// =============================================================================
// src/jobs/clearNotifications.js
// Cron job – Hard-delete all notifications older than today
//
// Runs once daily at 23:59.
// Notifications in BusTrack have a 1-day validity window. This job removes
// all records where created_at < CURRENT_DATE in a single atomic DELETE.
// No archiving, no soft delete — this is an intentional product decision.
//
// No school_id scoping — clears across all schools in one pass by design.
// =============================================================================

const cron = require('node-cron');
const pool = require('../config/db');
const logger = require('../config/logger');

// =============================================================================
// clearNotifications — Deletes all notification records created before today
// =============================================================================
async function clearNotifications() {
    logger.info('clearNotifications: job started');

    try {
        const result = await pool.query(
            `DELETE FROM notifications
             WHERE created_at < CURRENT_DATE
             RETURNING id`
        );

        logger.info('clearNotifications: job completed', { deleted: result.rowCount });
    } catch (err) {
        logger.error('clearNotifications: job failed', { error: err.message, stack: err.stack });
    }
}

// =============================================================================
// startClearNotifications — Registers the cron schedule
// =============================================================================
function startClearNotifications() {
    // Once daily at 23:59
    cron.schedule('59 23 * * *', clearNotifications);
    logger.info('clearNotifications: cron registered (59 23 * * *)');
}

module.exports = { startClearNotifications };
