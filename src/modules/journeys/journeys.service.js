// =============================================================================
// src/modules/journeys/journeys.service.js
// Service layer for Journey lifecycle operations
//
// All DB logic lives here. Controllers import and call these functions.
// Every function receives school_id explicitly — never from globals.
// All queries are parameterised and scoped to school_id.
// =============================================================================

const pool = require('../../config/db');
const notificationsService = require('../notifications/notifications.service');
const logger = require('../../config/logger');

// UUID format validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validates a UUID string format
function isValidUUID(id) {
    return typeof id === 'string' && UUID_REGEX.test(id);
}

// Validates a YYYY-MM-DD date string format
function isValidDate(d) {
    return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));
}

// Valid journey_type enum values
const VALID_JOURNEY_TYPES = ['PICKUP', 'DROP'];

// =============================================================================
// resolveDriverBus
// Determines which bus a driver is assigned to TODAY.
// Resolution: substitute_assignments first, then bus_routes default_driver_id.
// Returns { bus_id, route_id } or null if no assignment found.
// =============================================================================
async function resolveDriverBus(driverId, schoolId) {
    // 1. Check substitute assignments for today
    const subQuery = await pool.query(
        `SELECT sa.bus_id, br.id AS route_id
         FROM substitute_assignments sa
         LEFT JOIN bus_routes br
           ON br.bus_id = sa.bus_id
           AND br.is_active = TRUE
           AND br.school_id = $2
         WHERE sa.substitute_driver_id = $1
           AND sa.assignment_date = CURRENT_DATE
           AND sa.school_id = $2`,
        [driverId, schoolId]
    );

    if (subQuery.rowCount > 0) {
        return {
            bus_id: subQuery.rows[0].bus_id,
            route_id: subQuery.rows[0].route_id || null,
        };
    }

    // 2. Check bus_routes default driver
    const routeResult = await pool.query(
        `SELECT br.bus_id, br.id AS route_id
         FROM bus_routes br
         WHERE br.default_driver_id = $1
           AND br.is_active = TRUE
           AND br.school_id = $2`,
        [driverId, schoolId]
    );

    if (routeResult.rowCount > 0) {
        return {
            bus_id: routeResult.rows[0].bus_id,
            route_id: routeResult.rows[0].route_id,
        };
    }

    return null;
}
// async function resolveDriverBus(driverId, schoolId) {
//     // 1. Check substitute assignments for today
//     const subQuery = await pool.query(
//         `SELECT sa.bus_id, br.id AS route_id
//         FROM substitute_assignments sa
//         LEFT JOIN bus_routes br
//         ON br.bus_id = sa.bus_id AND br.is_active = TRUE AND br.school_id = $2::uuid
//         WHERE sa.substitute_driver_id = $1::uuid
//         AND sa.assignment_date = CURRENT_DATE
//         AND sa.school_id = $2::uuid`,
//         [driverId, schoolId]
//     );

//     if (subQuery.rowCount > 0) {
//         return {
//             bus_id: subQuery.rows[0].bus_id,
//             route_id: subQuery.rows[0].route_id || null,
//         };
//     }

//     // 2. Check bus_routes default driver
//     const routeResult = await pool.query(
//         `SELECT br.bus_id, br.id AS route_id
//         FROM bus_routes br
//         WHERE br.default_driver_id = $1::uuid
//         AND br.is_active = TRUE
//         AND br.school_id = $2::uuid`,
//         [driverId, schoolId]
//     );

//     if (routeResult.rowCount > 0) {
//         return {
//             bus_id: routeResult.rows[0].bus_id,
//             route_id: routeResult.rows[0].route_id,
//         };
//     }

//     return null;
// }

// =============================================================================
// findTodayJourney
// Looks up a journey for a specific bus, date (today), and journey_type.
// Returns the journey row or null.
// =============================================================================
async function findTodayJourney(busId, journeyType, schoolId) {
    const result = await pool.query(
        `SELECT id, school_id, bus_id, driver_id, route_id, journey_type,
                status, journey_date, started_at, ended_at,
                last_known_lat, last_known_lng, last_location_at,
                tracking_status, last_signal_at,
                is_auto_started, is_auto_ended,
                created_at, updated_at
         FROM journeys
         WHERE bus_id = $1
           AND journey_date = CURRENT_DATE
           AND journey_type = $2
           AND school_id = $3`,
        [busId, journeyType, schoolId]
    );

    return result.rowCount > 0 ? result.rows[0] : null;
}

// =============================================================================
// startPickup
// Creates a PICKUP journey with status PICKUP_STARTED.
// Guards: no existing PICKUP journey for this bus today.
// =============================================================================
async function startPickup(driverId, schoolId) {
    const assignment = await resolveDriverBus(driverId, schoolId);
    if (!assignment) {
        return { error: 'No bus assigned to this driver for today', status: 400 };
    }

    const { bus_id, route_id } = assignment;

    // Guard: no existing PICKUP journey today
    const existing = await findTodayJourney(bus_id, 'PICKUP', schoolId);
    if (existing) {
        return { error: 'Pickup journey already exists for this bus today', status: 409 };
    }

    const result = await pool.query(
        `INSERT INTO journeys
            (school_id, bus_id, driver_id, route_id, journey_type, status,
             journey_date, started_at, tracking_status, is_auto_started, is_auto_ended,
             created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'PICKUP', 'PICKUP_STARTED',
                 CURRENT_DATE, NOW(), 'LOST', FALSE, FALSE,
                 NOW(), NOW())
         RETURNING *`,
        [schoolId, bus_id, driverId, route_id]
    );

    // Fire-and-forget notification — never block the journey action
    notificationsService.queueJourneyNotification(
        result.rows[0].id, 'PICKUP_STARTED', schoolId
    ).catch(err => logger.error('Notification queue error (startPickup)', { error: err.message }));

    return { journey: result.rows[0] };
}

// =============================================================================
// arrivedSchool
// Updates the PICKUP journey to ARRIVED_SCHOOL and sets ended_at.
// Guards: PICKUP journey must exist with status PICKUP_STARTED.
// =============================================================================
async function arrivedSchool(driverId, schoolId) {
    const assignment = await resolveDriverBus(driverId, schoolId);
    if (!assignment) {
        return { error: 'No bus assigned to this driver for today', status: 400 };
    }

    const { bus_id } = assignment;

    const existing = await findTodayJourney(bus_id, 'PICKUP', schoolId);
    if (!existing) {
        return { error: 'No pickup journey found for this bus today', status: 409 };
    }

    if (existing.status !== 'PICKUP_STARTED') {
        return { error: `Cannot mark arrived: journey status is ${existing.status}, expected PICKUP_STARTED`, status: 409 };
    }

    const result = await pool.query(
        `UPDATE journeys
         SET status = 'ARRIVED_SCHOOL',
             ended_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND school_id = $2
         RETURNING *`,
        [existing.id, schoolId]
    );

    // Fire-and-forget notification — never block the journey action
    notificationsService.queueJourneyNotification(
        result.rows[0].id, 'ARRIVED_SCHOOL', schoolId
    ).catch(err => logger.error('Notification queue error (arrivedSchool)', { error: err.message }));

    return { journey: result.rows[0] };
}

// =============================================================================
// startDrop
// Creates a DROP journey with status DROP_STARTED.
// Guards: no existing DROP journey for this bus today.
// =============================================================================
async function startDrop(driverId, schoolId) {
    const assignment = await resolveDriverBus(driverId, schoolId);
    if (!assignment) {
        return { error: 'No bus assigned to this driver for today', status: 400 };
    }

    const { bus_id, route_id } = assignment;

    // Guard: no existing DROP journey today
    const existing = await findTodayJourney(bus_id, 'DROP', schoolId);
    if (existing) {
        return { error: 'Drop journey already exists for this bus today', status: 409 };
    }

    const result = await pool.query(
        `INSERT INTO journeys
            (school_id, bus_id, driver_id, route_id, journey_type, status,
             journey_date, started_at, tracking_status, is_auto_started, is_auto_ended,
             created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'DROP', 'DROP_STARTED',
                 CURRENT_DATE, NOW(), 'LOST', FALSE, FALSE,
                 NOW(), NOW())
         RETURNING *`,
        [schoolId, bus_id, driverId, route_id]
    );

    // Fire-and-forget notification — never block the journey action
    notificationsService.queueJourneyNotification(
        result.rows[0].id, 'DROP_STARTED', schoolId
    ).catch(err => logger.error('Notification queue error (startDrop)', { error: err.message }));

    return { journey: result.rows[0] };
}

// =============================================================================
// endJourney
// Updates the DROP journey to COMPLETED and sets ended_at.
// Guards: DROP journey must exist with status DROP_STARTED.
// =============================================================================
async function endJourney(driverId, schoolId) {
    const assignment = await resolveDriverBus(driverId, schoolId);
    if (!assignment) {
        return { error: 'No bus assigned to this driver for today', status: 400 };
    }

    const { bus_id } = assignment;

    const existing = await findTodayJourney(bus_id, 'DROP', schoolId);
    if (!existing) {
        return { error: 'No drop journey found for this bus today', status: 409 };
    }

    if (existing.status !== 'DROP_STARTED') {
        return { error: `Cannot end journey: journey status is ${existing.status}, expected DROP_STARTED`, status: 409 };
    }

    const result = await pool.query(
        `UPDATE journeys
         SET status = 'COMPLETED',
             ended_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND school_id = $2
         RETURNING *`,
        [existing.id, schoolId]
    );

    // Fire-and-forget notification — never block the journey action
    notificationsService.queueJourneyNotification(
        result.rows[0].id, 'JOURNEY_ENDED', schoolId
    ).catch(err => logger.error('Notification queue error (endJourney)', { error: err.message }));

    return { journey: result.rows[0] };
}

// =============================================================================
// getDriverTodayJourneys
// Fetches the driver's today journey rows (0–2), with bus_number and route_name.
// =============================================================================
async function getDriverTodayJourneys(driverId, schoolId) {
    const assignment = await resolveDriverBus(driverId, schoolId);
    if (!assignment) {
        // No bus assigned — return empty array (not an error for a read endpoint)
        return { journeys: [] };
    }

    const { bus_id } = assignment;

    const result = await pool.query(
        `SELECT j.id, j.school_id, j.bus_id, j.driver_id, j.route_id,
                j.journey_type, j.status, j.journey_date,
                j.started_at, j.ended_at,
                j.last_known_lat, j.last_known_lng, j.last_location_at,
                j.tracking_status, j.last_signal_at,
                j.is_auto_started, j.is_auto_ended,
                j.created_at, j.updated_at,
                b.bus_number,
                br.route_name
         FROM journeys j
         LEFT JOIN buses b ON b.id = j.bus_id
         LEFT JOIN bus_routes br ON br.id = j.route_id
         WHERE j.bus_id = $1
           AND j.journey_date = CURRENT_DATE
           AND j.school_id = $2
         ORDER BY j.journey_type ASC`,
        [bus_id, schoolId]
    );

    return { journeys: result.rows };
}

// =============================================================================
// getTodayJourneys
// Returns all journeys for a school today, with optional bus_id filter.
// Joins bus_number, driver name, route_name.
// =============================================================================
async function getTodayJourneys(schoolId, busIdFilter) {
    const conditions = ['j.school_id = $1', 'j.journey_date = CURRENT_DATE'];
    const params = [schoolId];
    let paramIndex = 2;

    if (busIdFilter) {
        conditions.push(`j.bus_id = $${paramIndex}`);
        params.push(busIdFilter);
        paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await pool.query(
        `SELECT j.id, j.school_id, j.bus_id, j.driver_id, j.route_id,
                j.journey_type, j.status, j.journey_date,
                j.started_at, j.ended_at,
                j.last_known_lat, j.last_known_lng, j.last_location_at,
                j.tracking_status, j.last_signal_at,
                j.is_auto_started, j.is_auto_ended,
                j.created_at, j.updated_at,
                b.bus_number,
                u.name AS driver_name,
                br.route_name
         FROM journeys j
         LEFT JOIN buses b ON b.id = j.bus_id
         LEFT JOIN users u ON u.id = j.driver_id
         LEFT JOIN bus_routes br ON br.id = j.route_id
         ${whereClause}
         ORDER BY j.started_at DESC`,
        params
    );

    return { journeys: result.rows };
}

// =============================================================================
// getJourneyById
// Returns a single journey by ID, scoped to school_id.
// Joins bus_number, driver name, route_name.
// =============================================================================
async function getJourneyById(journeyId, schoolId) {
    const result = await pool.query(
        `SELECT j.id, j.school_id, j.bus_id, j.driver_id, j.route_id,
                j.journey_type, j.status, j.journey_date,
                j.started_at, j.ended_at,
                j.last_known_lat, j.last_known_lng, j.last_location_at,
                j.tracking_status, j.last_signal_at,
                j.is_auto_started, j.is_auto_ended,
                j.created_at, j.updated_at,
                b.bus_number,
                u.name AS driver_name,
                br.route_name
         FROM journeys j
         LEFT JOIN buses b ON b.id = j.bus_id
         LEFT JOIN users u ON u.id = j.driver_id
         LEFT JOIN bus_routes br ON br.id = j.route_id
         WHERE j.id = $1 AND j.school_id = $2`,
        [journeyId, schoolId]
    );

    return result.rowCount > 0 ? result.rows[0] : null;
}

// =============================================================================
// getJourneyHistory
// Paginated journey history for a school with optional filters.
// Filters: bus_id, journey_type, date (YYYY-MM-DD).
// Ordered by journey_date DESC, started_at DESC.
// =============================================================================
async function getJourneyHistory(schoolId, { busId, journeyType, date, limit, offset }) {
    const conditions = ['j.school_id = $1'];
    const params = [schoolId];
    let paramIndex = 2;

    if (busId) {
        conditions.push(`j.bus_id = $${paramIndex}`);
        params.push(busId);
        paramIndex++;
    }

    if (journeyType) {
        conditions.push(`j.journey_type = $${paramIndex}`);
        params.push(journeyType);
        paramIndex++;
    }

    if (date) {
        conditions.push(`j.journey_date = $${paramIndex}`);
        params.push(date);
        paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Count total matching rows
    const countResult = await pool.query(
        `SELECT COUNT(*) AS total FROM journeys j ${whereClause}`,
        params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Fetch paginated data with joins
    const dataResult = await pool.query(
        `SELECT j.id, j.school_id, j.bus_id, j.driver_id, j.route_id,
                j.journey_type, j.status, j.journey_date,
                j.started_at, j.ended_at,
                j.last_known_lat, j.last_known_lng, j.last_location_at,
                j.tracking_status, j.last_signal_at,
                j.is_auto_started, j.is_auto_ended,
                j.created_at, j.updated_at,
                b.bus_number,
                u.name AS driver_name,
                br.route_name
         FROM journeys j
         LEFT JOIN buses b ON b.id = j.bus_id
         LEFT JOIN users u ON u.id = j.driver_id
         LEFT JOIN bus_routes br ON br.id = j.route_id
         ${whereClause}
         ORDER BY j.journey_date DESC, j.started_at DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
    );

    return { journeys: dataResult.rows, total };
}

module.exports = {
    isValidUUID,
    isValidDate,
    VALID_JOURNEY_TYPES,
    resolveDriverBus,
    startPickup,
    arrivedSchool,
    startDrop,
    endJourney,
    getDriverTodayJourneys,
    getTodayJourneys,
    getJourneyById,
    getJourneyHistory,
};
