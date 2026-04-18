// =============================================================================
// src/jobs/expireJourneys.js
// Cron job – Auto-end journeys running longer than 6 hours
//
// Runs every 30 minutes, 24/7.
// Covers the case where a driver forgets to tap the final action (Arrived
// School for PICKUP or Journey End for DROP). A single bulk UPDATE transitions
// all stale journeys to their correct terminal status, then SESSION_EXPIRED
// flags are inserted and any open GPS flags are resolved per journey.
//
// Status transitions:
//   PICKUP_STARTED → ARRIVED_SCHOOL
//   DROP_STARTED   → COMPLETED
//
// No notifications are sent — this is a silent system maintenance operation.
// =============================================================================

const cron = require('node-cron');
const pool = require('../config/db');
const logger = require('../config/logger');

const EXPIRY_HOURS = 6;

// =============================================================================
// bulkExpireJourneys — Single bulk UPDATE with CASE to transition all expired journeys
// =============================================================================
async function bulkExpireJourneys() {
    const result = await pool.query(
        `UPDATE journeys
         SET
           status = CASE
             WHEN status = 'PICKUP_STARTED' THEN 'ARRIVED_SCHOOL'::journey_status
             WHEN status = 'DROP_STARTED'   THEN 'COMPLETED'::journey_status
           END,
           ended_at = NOW(),
           is_auto_ended = TRUE,
           tracking_status = 'LOST'::tracking_status,
           updated_at = NOW()
         WHERE
           status IN ('PICKUP_STARTED', 'DROP_STARTED')
           AND started_at < NOW() - INTERVAL '${EXPIRY_HOURS} hours'
         RETURNING
           id            AS journey_id,
           school_id,
           bus_id,
           status        AS new_status,
           journey_type,
           started_at,
           ended_at`
    );

    return result.rows;
}

// =============================================================================
// insertSessionExpiredFlag — Inserts a SESSION_EXPIRED flag for an auto-expired journey
// =============================================================================
async function insertSessionExpiredFlag(client, schoolId, journeyId) {
    await client.query(
        `INSERT INTO journey_flags (id, school_id, journey_id, type, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'SESSION_EXPIRED', NOW(), NOW())`,
        [schoolId, journeyId]
    );
}

// =============================================================================
// resolveOpenGpsFlags — Resolves any unresolved GPS_WEAK or GPS_LOST flags for a journey
// =============================================================================
async function resolveOpenGpsFlags(client, journeyId) {
    const result = await client.query(
        `UPDATE journey_flags
         SET resolved_at = NOW(), updated_at = NOW()
         WHERE journey_id = $1::uuid
           AND type IN ('GPS_WEAK', 'GPS_LOST')
           AND resolved_at IS NULL`,
        [journeyId]
    );

    return result.rowCount;
}

// =============================================================================
// processExpiredJourney — Handles flag insert + GPS flag resolution for one journey
// =============================================================================
async function processExpiredJourney(row) {
    const {
        journey_id: journeyId,
        school_id: schoolId,
        bus_id: busId,
        new_status: newStatus,
        journey_type: journeyType,
        started_at: startedAt,
    } = row;

    let client;

    try {
        client = await pool.connect();

        await client.query('BEGIN');

        try {
            // Insert SESSION_EXPIRED flag
            await insertSessionExpiredFlag(client, schoolId, journeyId);

            // Resolve any lingering GPS flags
            await resolveOpenGpsFlags(client, journeyId);

            await client.query('COMMIT');
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        }

        const hoursRunning = Math.round(
            (Date.now() - new Date(startedAt).getTime()) / 3600000
        );

        logger.warn('expireJourneys: journey auto-expired', {
            journeyId,
            schoolId,
            busId,
            journeyType,
            newStatus,
            startedAt,
            hoursRunning,
        });
    } catch (err) {
        logger.error('expireJourneys: error processing journey', {
            journeyId,
            error: err.message,
            stack: err.stack,
        });
    } finally {
        if (client) client.release();
    }
}

// =============================================================================
// expireJourneys — Main job body
// =============================================================================
async function expireJourneys() {
    logger.info('expireJourneys: job started');

    try {
        // Step 1 — Bulk UPDATE all expired journeys in a single statement
        const rows = await bulkExpireJourneys();

        if (rows.length === 0) {
            logger.info('expireJourneys: no expired journeys found');
            return;
        }

        // Steps 2–4 — Insert SESSION_EXPIRED flags and resolve GPS flags in parallel
        await Promise.allSettled(rows.map(row => processExpiredJourney(row)));

        logger.info('expireJourneys: job completed', { expired: rows.length });
    } catch (err) {
        // Top-level error (e.g. bulkExpireJourneys failed)
        logger.error('expireJourneys: job failed', { error: err.message, stack: err.stack });
    }
}

// =============================================================================
// startExpireJourneys — Registers the cron schedule
// =============================================================================
function startExpireJourneys() {
    // Every 30 minutes, 24/7
    cron.schedule('*/30 * * * *', expireJourneys);
    logger.info('expireJourneys: cron registered (*/30 * * * *)');
}

module.exports = { startExpireJourneys };

expireJourneys();