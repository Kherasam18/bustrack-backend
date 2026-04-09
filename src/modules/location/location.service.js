// =============================================================================
// src/modules/location/location.service.js
// Service layer for GPS location tracking operations
//
// All DB and Firebase logic lives here. Controllers call these functions.
// Every function receives school_id explicitly — never from globals.
// All queries are parameterised and scoped to school_id.
// =============================================================================

const pool = require('../../config/db');
const admin = require('../../config/firebase');
const logger = require('../../config/logger');

// Firebase Realtime Database reference
const db = admin.database();

// Reuse UUID validation from journeys module
const { isValidUUID } = require('../journeys/journeys.service');

// =============================================================================
// validateLocationPayload
// Validates the incoming GPS update request body.
// Returns { valid: true, data } or { valid: false, message }.
// =============================================================================
function validateLocationPayload(body) {
    const { journey_id, lat, lng, speed } = body || {};

    if (!journey_id) {
        return { valid: false, message: 'journey_id is required' };
    }
    if (!isValidUUID(journey_id)) {
        return { valid: false, message: 'journey_id must be a valid UUID' };
    }

    if (lat === undefined || lat === null) {
        return { valid: false, message: 'lat is required' };
    }
    const parsedLat = Number(lat);
    if (isNaN(parsedLat) || parsedLat < -90 || parsedLat > 90) {
        return { valid: false, message: 'lat must be a number between -90 and 90' };
    }

    if (lng === undefined || lng === null) {
        return { valid: false, message: 'lng is required' };
    }
    const parsedLng = Number(lng);
    if (isNaN(parsedLng) || parsedLng < -180 || parsedLng > 180) {
        return { valid: false, message: 'lng must be a number between -180 and 180' };
    }

    let parsedSpeed = null;
    if (speed !== undefined && speed !== null) {
        parsedSpeed = Number(speed);
        if (isNaN(parsedSpeed) || parsedSpeed < 0) {
            return { valid: false, message: 'speed must be a non-negative number' };
        }
    }

    return {
        valid: true,
        data: {
            journey_id,
            lat: parsedLat,
            lng: parsedLng,
            speed: parsedSpeed,
        },
    };
}

// =============================================================================
// fetchJourneyForDriver
// Fetches a journey by ID ensuring it belongs to the given driver.
// Returns the journey row or null.
// =============================================================================
async function fetchJourneyForDriver(journeyId, driverId) {
    const result = await pool.query(
        `SELECT id, school_id, bus_id, driver_id, status, tracking_status
         FROM journeys
         WHERE id = $1 AND driver_id = $2`,
        [journeyId, driverId]
    );

    return result.rowCount > 0 ? result.rows[0] : null;
}

// =============================================================================
// processLocationUpdate
// Orchestrates the full GPS update: validation, DB inserts/updates, Firebase write.
// Returns { error, status } on failure or { data } on success.
// =============================================================================
async function processLocationUpdate(driverId, schoolId, body) {
    // 1. Validate payload
    const validation = validateLocationPayload(body);
    if (!validation.valid) {
        return { error: validation.message, status: 400 };
    }

    const { journey_id, lat, lng, speed } = validation.data;

    // 2. Fetch journey and verify ownership
    const journey = await fetchJourneyForDriver(journey_id, driverId);
    if (!journey) {
        return { error: 'Journey not found', status: 404 };
    }

    // 3. Verify journey is in an active status that accepts location updates
    const activeStatuses = ['PICKUP_STARTED', 'DROP_STARTED'];
    if (!activeStatuses.includes(journey.status)) {
        return {
            error: `Location updates not accepted for journey status: ${journey.status}`,
            status: 409,
        };
    }

    // 4. Insert into location_logs (append-only)
    await pool.query(
        `INSERT INTO location_logs (journey_id, lat, lng, speed, recorded_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [journey_id, lat, lng, speed]
    );

    // 5. Update journey tracking state
    const updateResult = await pool.query(
        `UPDATE journeys
         SET last_known_lat = $1,
             last_known_lng = $2,
             last_location_at = NOW(),
             tracking_status = 'ACTIVE',
             last_signal_at = NOW(),
             updated_at = NOW()
         WHERE id = $3 AND school_id = $4
         RETURNING last_signal_at`,
        [lat, lng, journey_id, journey.school_id]
    );

    const lastSignalAt = updateResult.rows[0].last_signal_at;

    // 5b. Resolve any open GPS flags now that tracking has recovered
    try {
        const flagResult = await pool.query(
            `UPDATE journey_flags
             SET resolved_at = NOW(), updated_at = NOW()
             WHERE journey_id = $1::uuid
               AND type IN ('GPS_WEAK', 'GPS_LOST')
               AND resolved_at IS NULL`,
            [journey_id]
        );

        if (flagResult.rowCount > 0) {
            logger.info('locationService: GPS flags resolved on recovery', {
                journeyId: journey_id,
                rowsResolved: flagResult.rowCount,
            });
        }
    } catch (flagErr) {
        // Best-effort cleanup — never block the GPS update response
        logger.warn('locationService: failed to resolve GPS flags', {
            journeyId: journey_id,
            error: flagErr.message,
        });
    }

    // 6. Fire-and-forget Firebase Realtime Database write
    const firebasePayload = {
        lat,
        lng,
        speed,
        updated_at: new Date().toISOString(),
        journey_id,
        tracking_status: 'ACTIVE',
    };

    db.ref(`schools/${journey.school_id}/buses/${journey.bus_id}/location`)
        .set(firebasePayload)
        .catch(err => logger.error('Firebase write failed', { error: err.message }));

    // 7. Return success data
    return {
        data: {
            journey_id,
            tracking_status: 'ACTIVE',
            last_known_lat: lat,
            last_known_lng: lng,
            last_signal_at: lastSignalAt,
        },
    };
}

// =============================================================================
// getJourneyLocationLog
// Fetches the full GPS log for a journey, scoped to school_id.
// Returns { error, status } on failure or { data } on success.
// =============================================================================
async function getJourneyLocationLog(journeyId, schoolId) {
    // 1. Verify journey exists and belongs to the school
    const journeyCheck = await pool.query(
        `SELECT id FROM journeys
         WHERE id = $1 AND school_id = $2`,
        [journeyId, schoolId]
    );

    if (journeyCheck.rowCount === 0) {
        return { error: 'Journey not found', status: 404 };
    }

    // 2. Fetch all location log points ordered by time
    const result = await pool.query(
        `SELECT id, lat, lng, speed, recorded_at
         FROM location_logs
         WHERE journey_id = $1
         ORDER BY recorded_at ASC`,
        [journeyId]
    );

    return {
        data: {
            journey_id: journeyId,
            points: result.rows,
            total: result.rowCount,
        },
    };
}

module.exports = {
    validateLocationPayload,
    processLocationUpdate,
    getJourneyLocationLog,
};
