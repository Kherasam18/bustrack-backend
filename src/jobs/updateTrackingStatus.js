// =============================================================================
// src/jobs/updateTrackingStatus.js
// Cron job – Degrade tracking_status on journeys with stale GPS signal
//
// Runs every 1 minute, 24/7.
// Performs a single bulk UPDATE with a CASE expression to compute the correct
// tracking_status (ACTIVE / WEAK / LOST) for every in-progress journey.
// Then inserts GPS_WEAK and GPS_LOST flags where none exist, and sends
// TRACKING_LOST_ALERT notifications to the School Admin for newly-lost buses.
//
// Thresholds:
//   ACTIVE  — last_signal_at within the past 1 minute
//   WEAK    — last_signal_at between 1 and 5 minutes ago
//   LOST    — last_signal_at more than 5 minutes ago, or NULL
// =============================================================================

const cron = require('node-cron');
const pool = require('../config/db');
const { getRabbitMQChannel } = require('../config/rabbitmq');
const logger = require('../config/logger');

const QUEUE_NAME = 'bustrack.notifications';

// Maximum concurrent per-journey processing tasks — sized to stay within
// the default pg pool of 10 connections (bulk UPDATE uses one, leaves room)
const CONCURRENCY_LIMIT = 5;

// =============================================================================
// runWithConcurrency — Runs async task functions with a maximum concurrency cap.
// Returns an array of { status, value/reason } objects matching Promise.allSettled.
// =============================================================================
async function runWithConcurrency(tasks, concurrency) {
    const results = [];
    let index = 0;

    async function worker() {
        while (index < tasks.length) {
            const current = index++;
            try {
                const value = await tasks[current]();
                results[current] = { status: 'fulfilled', value };
            } catch (reason) {
                results[current] = { status: 'rejected', reason };
            }
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
    await Promise.all(workers);
    return results;
}

// =============================================================================
// bulkUpdateTrackingStatus — Single-statement bulk UPDATE with CASE expression
// =============================================================================
async function bulkUpdateTrackingStatus() {
    const result = await pool.query(
        `UPDATE journeys
         SET
           tracking_status = CASE
             WHEN last_signal_at >= NOW() - INTERVAL '1 minute'  THEN 'ACTIVE'::tracking_status
             WHEN last_signal_at >= NOW() - INTERVAL '5 minutes' THEN 'WEAK'::tracking_status
             ELSE 'LOST'::tracking_status
           END,
           updated_at = NOW()
         WHERE status IN ('PICKUP_STARTED', 'DROP_STARTED')
         RETURNING
           id AS journey_id,
           school_id,
           bus_id,
           tracking_status,
           last_signal_at`
    );

    return result.rows;
}

// =============================================================================
// insertFlag — Inserts a journey_flag with ON CONFLICT DO NOTHING (atomic guard)
// =============================================================================
async function insertFlag(client, schoolId, journeyId, flagType) {
    await client.query(
        `INSERT INTO journey_flags (id, school_id, journey_id, type, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [schoolId, journeyId, flagType]
    );
}

// =============================================================================
// findSchoolAdmin — Returns the active School Admin user id for a school
// =============================================================================
async function findSchoolAdmin(client, schoolId) {
    const result = await client.query(
        `SELECT id FROM users
         WHERE school_id = $1::uuid
           AND role = 'SCHOOL_ADMIN'
           AND is_active = TRUE
         LIMIT 1`,
        [schoolId]
    );

    return result.rowCount > 0 ? result.rows[0].id : null;
}

// =============================================================================
// fetchBusDetails — Fetches bus_number and route_name for a bus
// =============================================================================
async function fetchBusDetails(client, busId) {
    const result = await client.query(
        `SELECT b.bus_number, r.route_name
         FROM buses b
         JOIN bus_routes r ON r.bus_id = b.id
         WHERE b.id = $1::uuid
         LIMIT 1`,
        [busId]
    );

    return result.rowCount > 0 ? result.rows[0] : { bus_number: 'Unknown', route_name: 'Unknown' };
}

// =============================================================================
// insertNotification — Inserts a TRACKING_LOST_ALERT notification
// =============================================================================
async function insertNotification(client, schoolId, recipientId, journeyId, body, meta) {
    const result = await client.query(
        `INSERT INTO notifications
           (id, school_id, recipient_user_id, journey_id, type, body, meta,
            delivery_status, is_read, created_at, updated_at)
         VALUES
           (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'TRACKING_LOST_ALERT', $4, $5,
            'PENDING', FALSE, NOW(), NOW())
         RETURNING id`,
        [schoolId, recipientId, journeyId, body, JSON.stringify(meta)]
    );

    return result.rows[0].id;
}

// =============================================================================
// publishToQueue — Fire-and-forget RabbitMQ publish for a notification
// =============================================================================
async function publishToQueue(notificationId) {
    try {
        const channel = await getRabbitMQChannel();
        await channel.assertQueue(QUEUE_NAME, { durable: true });

        channel.sendToQueue(
            QUEUE_NAME,
            Buffer.from(JSON.stringify({ notification_id: notificationId })),
            { persistent: true }
        );
    } catch (err) {
        // Fire-and-forget — notification row exists with PENDING status for retry
        logger.error('updateTrackingStatus: RabbitMQ publish failed', {
            error: err.message,
            notificationId,
        });
    }
}

// =============================================================================
// buildLostNotificationBody — Builds the notification body for a GPS_LOST event
// =============================================================================
function buildLostNotificationBody(busNumber, lastSignalAt) {
    if (!lastSignalAt) {
        return `GPS signal lost for Bus ${busNumber}. No signal received.`;
    }

    const minutesAgo = Math.round((Date.now() - new Date(lastSignalAt).getTime()) / 60000);
    return `GPS signal lost for Bus ${busNumber}. Last seen ${minutesAgo} minutes ago.`;
}

// =============================================================================
// processWeakJourney — Inserts a GPS_WEAK flag if none exists (no notification)
// =============================================================================
async function processWeakJourney(journey) {
    const { journey_id: journeyId, school_id: schoolId, bus_id: busId } = journey;
    let client;

    try {
        client = await pool.connect();

        await client.query('BEGIN');

        try {
            // Re-check for unresolved flag inside the transaction (atomic with insert)
            const existing = await client.query(
                `SELECT 1 FROM journey_flags
                 WHERE journey_id = $1::uuid
                   AND type = 'GPS_WEAK'
                   AND resolved_at IS NULL
                 LIMIT 1`,
                [journeyId]
            );

            if (existing.rowCount > 0) {
                await client.query('ROLLBACK');
                return { flagInserted: false };
            }

            // Use INSERT ... ON CONFLICT DO NOTHING with the partial unique index
            // idx_journey_flags_unresolved_unique (journey_id, type) WHERE resolved_at IS NULL
            await insertFlag(client, schoolId, journeyId, 'GPS_WEAK');
            await client.query('COMMIT');

            logger.warn('updateTrackingStatus: GPS_WEAK detected', { journeyId, busId, schoolId });

            return { flagInserted: true };
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        }
    } catch (err) {
        logger.error('updateTrackingStatus: error processing journey', {
            journeyId,
            error: err.message,
            stack: err.stack,
        });
        return { flagInserted: false };
    } finally {
        if (client) client.release();
    }
}

// =============================================================================
// processLostJourney — Inserts a GPS_LOST flag + sends TRACKING_LOST_ALERT
// =============================================================================
async function processLostJourney(journey) {
    const {
        journey_id: journeyId,
        school_id: schoolId,
        bus_id: busId,
        last_signal_at: lastSignalAt,
    } = journey;

    let client;
    let notificationSent = false;

    try {
        client = await pool.connect();

        // Fetch details needed for notification (read-only, before transaction)
        const schoolAdminId = await findSchoolAdmin(client, schoolId);
        if (!schoolAdminId) {
            logger.warn('updateTrackingStatus: no active School Admin found', { schoolId, journeyId });
        }

        const busDetails = await fetchBusDetails(client, busId);
        const { bus_number: busNumber, route_name: routeName } = busDetails;

        const notificationBody = buildLostNotificationBody(busNumber, lastSignalAt);
        const notificationMeta = {
            journey_id: journeyId,
            bus_id: busId,
            bus_number: busNumber,
            route_name: routeName,
            last_signal_at: lastSignalAt || null,
        };

        // Transaction: flag insert + notification insert
        await client.query('BEGIN');

        try {
            // Re-check for unresolved flag inside the transaction (atomic with insert)
            const existing = await client.query(
                `SELECT 1 FROM journey_flags
                 WHERE journey_id = $1::uuid
                   AND type = 'GPS_LOST'
                   AND resolved_at IS NULL
                 LIMIT 1`,
                [journeyId]
            );

            if (existing.rowCount > 0) {
                await client.query('ROLLBACK');
                return { flagInserted: false, notificationSent: false };
            }

            // Use INSERT ... ON CONFLICT DO NOTHING with the partial unique index
            // idx_journey_flags_unresolved_unique (journey_id, type) WHERE resolved_at IS NULL
            await insertFlag(client, schoolId, journeyId, 'GPS_LOST');

            let notificationId = null;

            if (schoolAdminId) {
                notificationId = await insertNotification(
                    client,
                    schoolId,
                    schoolAdminId,
                    journeyId,
                    notificationBody,
                    notificationMeta
                );
            }

            await client.query('COMMIT');

            logger.warn('updateTrackingStatus: GPS_LOST detected', {
                journeyId,
                busId,
                schoolId,
                lastSignalAt,
            });

            // Fire-and-forget RabbitMQ publish (after commit)
            if (notificationId) {
                notificationSent = true;

                publishToQueue(notificationId).then(() => {
                    logger.info('updateTrackingStatus: TRACKING_LOST_ALERT queued', {
                        notificationId,
                        journeyId,
                        schoolAdminId,
                    });
                }).catch(() => {
                    // Already logged inside publishToQueue
                });
            }

            return { flagInserted: true, notificationSent };
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        }
    } catch (err) {
        logger.error('updateTrackingStatus: error processing journey', {
            journeyId,
            error: err.message,
            stack: err.stack,
        });
        return { flagInserted: false, notificationSent: false };
    } finally {
        if (client) client.release();
    }
}

// =============================================================================
// updateTrackingStatus — Main job body
// =============================================================================
async function updateTrackingStatus() {
    logger.info('updateTrackingStatus: job started');

    let flagsInserted = 0;
    let notificationsSent = 0;

    try {
        // Step 1 — Bulk UPDATE all active journeys in a single statement
        const rows = await bulkUpdateTrackingStatus();

        // Step 2 — Separate into transition groups
        const lostJourneys = rows.filter(r => r.tracking_status === 'LOST');
        const weakJourneys = rows.filter(r => r.tracking_status === 'WEAK');

        logger.info('updateTrackingStatus: bulk update complete', {
            totalActive: rows.length,
            lostCount: lostJourneys.length,
            weakCount: weakJourneys.length,
        });

        // Steps 3–5 — Process WEAK and LOST journeys with concurrency cap
        // Tasks are thunks (functions returning promises), not pre-started promises
        const tasks = [
            ...weakJourneys.map(j => () => processWeakJourney(j)),
            ...lostJourneys.map(j => () => processLostJourney(j)),
        ];

        const results = await runWithConcurrency(tasks, CONCURRENCY_LIMIT);

        // Tally results
        for (const result of results) {
            if (result.status === 'fulfilled') {
                if (result.value.flagInserted) flagsInserted++;
                if (result.value.notificationSent) notificationsSent++;
            }
            // Rejected promises are already logged inside process* functions
        }
    } catch (err) {
        // Top-level error (e.g. bulkUpdateTrackingStatus failed)
        logger.error('updateTrackingStatus: job failed', { error: err.message, stack: err.stack });
        return;
    }

    logger.info('updateTrackingStatus: job completed', { flagsInserted, notificationsSent });
}

// =============================================================================
// startUpdateTrackingStatus — Registers the cron schedule
// =============================================================================
function startUpdateTrackingStatus() {
    // Every 1 minute, 24/7 — active journeys can run early morning or late evening
    cron.schedule('* * * * *', updateTrackingStatus);
    logger.info('updateTrackingStatus: cron registered (* * * * *)');
}

module.exports = { startUpdateTrackingStatus };
