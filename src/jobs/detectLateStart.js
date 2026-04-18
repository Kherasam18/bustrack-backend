// =============================================================================
// src/jobs/detectLateStart.js
// Cron job – Detect buses that have not started their pickup journey
//
// Runs every 5 minutes during school hours (06:00–21:00).
// For each active route whose scheduled_departure + 30 min grace has passed,
// checks whether a PICKUP journey exists for today. If not, inserts a
// LATE_START journey_flag (journey_id = NULL) and sends a LATE_START_ALERT
// notification to the School Admin.
//
// Duplicate alerts for the same bus on the same day are prevented by checking
// the notifications table for an existing LATE_START_ALERT with matching
// meta->>'bus_id'.
// =============================================================================

const cron = require('node-cron');
const pool = require('../config/db');
const { getRabbitMQChannel } = require('../config/rabbitmq');
const logger = require('../config/logger');

const QUEUE_NAME = 'bustrack.notifications';
const GRACE_MINUTES = 30;

// =============================================================================
// findCandidateRoutes — Fetches all active routes whose late threshold has passed
// =============================================================================
async function findCandidateRoutes(client) {
    const result = await client.query(
        `SELECT
             br.id          AS route_id,
             br.school_id,
             br.bus_id,
             br.route_name,
             br.scheduled_departure,
             b.bus_number
         FROM bus_routes br
         JOIN buses   b ON b.id = br.bus_id
         JOIN schools s ON s.id = br.school_id
         WHERE br.is_active = TRUE
           AND br.scheduled_departure IS NOT NULL
           AND b.is_active  = TRUE
           AND s.is_active  = TRUE
           AND CURRENT_TIME > (br.scheduled_departure + INTERVAL '${GRACE_MINUTES} minutes')`
    );

    return result.rows;
}

// =============================================================================
// hasPickupJourneyToday — Returns true if a PICKUP journey already exists today
// =============================================================================
async function hasPickupJourneyToday(client, busId, schoolId) {
    const result = await client.query(
        `SELECT 1 FROM journeys
         WHERE bus_id       = $1::uuid
           AND school_id    = $2::uuid
           AND journey_type = 'PICKUP'
           AND journey_date = CURRENT_DATE
         LIMIT 1`,
        [busId, schoolId]
    );

    return result.rowCount > 0;
}

// =============================================================================
// hasAlreadyAlertedToday — Returns true if a LATE_START_ALERT notification
// was already sent for this bus today (duplicate guard)
// =============================================================================
async function hasAlreadyAlertedToday(client, schoolId, busId) {
    const result = await client.query(
        `SELECT 1 FROM notifications
         WHERE school_id    = $1::uuid
           AND type         = 'LATE_START_ALERT'
           AND created_at::date = CURRENT_DATE
           AND meta->>'bus_id' = $2
         LIMIT 1`,
        [schoolId, busId]
    );

    return result.rowCount > 0;
}

// =============================================================================
// findSchoolAdmin — Returns the active School Admin user id for a school
// =============================================================================
async function findSchoolAdmin(client, schoolId) {
    const result = await client.query(
        `SELECT id FROM users
         WHERE school_id = $1::uuid
           AND role      = 'SCHOOL_ADMIN'
           AND is_active = TRUE
         LIMIT 1`,
        [schoolId]
    );

    return result.rowCount > 0 ? result.rows[0].id : null;
}

// =============================================================================
// insertJourneyFlag — Inserts a LATE_START flag with journey_id = NULL
// =============================================================================
async function insertJourneyFlag(client, schoolId) {
    await client.query(
        `INSERT INTO journey_flags (id, school_id, journey_id, type, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, NULL, 'LATE_START', NOW(), NOW())`,
        [schoolId]
    );
}

// =============================================================================
// insertNotification — Inserts a LATE_START_ALERT notification for the School Admin
// =============================================================================
async function insertNotification(client, schoolId, recipientId, body, meta) {
    const result = await client.query(
        `INSERT INTO notifications
           (id, school_id, recipient_user_id, journey_id, type, body, meta,
            delivery_status, is_read, created_at, updated_at)
         VALUES
           (gen_random_uuid(), $1::uuid, $2::uuid, NULL, 'LATE_START_ALERT', $3, $4,
            'PENDING', FALSE, NOW(), NOW())
         RETURNING id`,
        [schoolId, recipientId, body, JSON.stringify(meta)]
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
        logger.error('detectLateStart: RabbitMQ publish failed', {
            error: err.message,
            notificationId,
        });
    }
}

// =============================================================================
// detectLateStart — Main job body
// =============================================================================
async function detectLateStart() {
    logger.info('detectLateStart: job started');

    let processed = 0;
    let flagged = 0;
    let client;

    try {
        client = await pool.connect();

        // Step 1 — Find all candidate routes past their grace period
        const routes = await findCandidateRoutes(client);

        for (const route of routes) {
            processed++;

            try {
                const {
                    route_id,
                    school_id: schoolId,
                    bus_id: busId,
                    bus_number: busNumber,
                    route_name: routeName,
                    scheduled_departure: scheduledDeparture,
                } = route;

                // Step 2 — Skip if a PICKUP journey already exists for today
                if (await hasPickupJourneyToday(client, busId, schoolId)) {
                    continue;
                }

                // Step 3 — Skip if we already alerted for this bus today
                if (await hasAlreadyAlertedToday(client, schoolId, busId)) {
                    continue;
                }

                // Locate the School Admin
                const schoolAdminId = await findSchoolAdmin(client, schoolId);
                if (!schoolAdminId) {
                    logger.warn('detectLateStart: no active School Admin found', { schoolId });
                    continue;
                }

                // Format the scheduled_departure for display (HH:MM)
                const depDisplay = typeof scheduledDeparture === 'string'
                    ? scheduledDeparture.substring(0, 5)
                    : scheduledDeparture;

                const notificationBody =
                    `Bus ${busNumber} has not started its pickup journey. Scheduled departure was ${depDisplay}.`;

                const notificationMeta = {
                    bus_id: busId,
                    bus_number: busNumber,
                    scheduled_departure: depDisplay,
                    route_name: routeName,
                };

                // Step 4 + 5 — Insert flag & notification inside a transaction
                await client.query('BEGIN');

                try {
                    await insertJourneyFlag(client, schoolId);

                    const notificationId = await insertNotification(
                        client,
                        schoolId,
                        schoolAdminId,
                        notificationBody,
                        notificationMeta
                    );

                    await client.query('COMMIT');

                    flagged++;

                    // Step 6 — Logging
                    logger.warn('detectLateStart: late start detected', {
                        busId,
                        busNumber,
                        schoolId,
                        scheduledDeparture: depDisplay,
                    });

                    // Publish to RabbitMQ (fire-and-forget, after commit)
                    publishToQueue(notificationId).then(() => {
                        logger.info('detectLateStart: LATE_START_ALERT queued', {
                            notificationId,
                            schoolAdminId,
                            busId,
                        });
                    }).catch(() => {
                        // Already logged inside publishToQueue
                    });
                } catch (txErr) {
                    await client.query('ROLLBACK');
                    throw txErr;
                }
            } catch (iterErr) {
                // Per-iteration error — log and continue to next route
                logger.error('detectLateStart error', {
                    error: iterErr.message,
                    stack: iterErr.stack,
                    busId: route.bus_id,
                    schoolId: route.school_id,
                });
            }
        }
    } catch (err) {
        // Top-level error (e.g. pool.connect failed, findCandidateRoutes failed)
        logger.error('detectLateStart error', { error: err.message, stack: err.stack });
    } finally {
        if (client) {
            client.release();
        }
    }

    logger.info('detectLateStart: job completed', { processed, flagged });
}

// =============================================================================
// startDetectLateStart — Registers the cron schedule
// =============================================================================
function startDetectLateStart() {
    // Every 5 minutes, between 6 AM and 9 PM only
    cron.schedule('*/5 6-21 * * *', detectLateStart, { timezone: 'Asia/Kolkata' });
    logger.info('detectLateStart: cron registered (*/5 6-21 * * *)');
}

module.exports = { startDetectLateStart };
