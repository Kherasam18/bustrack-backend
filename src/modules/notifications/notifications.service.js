// =============================================================================
// src/modules/notifications/notifications.service.js
// Service layer for the Notifications module
//
// Responsibilities:
//   - Queue journey-level notifications for affected parents
//   - Fetch in-app notification history (parent + school admin)
//   - Mark notifications as read
//
// All DB logic lives here. Controllers import and call these functions.
// Every query is parameterised and scoped to school_id.
// =============================================================================

const pool = require('../../config/db');
const { getRabbitMQChannel } = require('../../config/rabbitmq');

const QUEUE_NAME = 'bustrack.notifications';

// Notification body templates keyed by notification type
const BODY_TEMPLATES = {
    PICKUP_STARTED: '{driver_name} has started the pickup journey for Bus {bus_number}',
    ARRIVED_SCHOOL: 'Bus {bus_number} has arrived at school',
    DROP_STARTED:   '{driver_name} has started the drop journey for Bus {bus_number}',
    JOURNEY_ENDED:  'Drop journey for Bus {bus_number} has ended',
};

// Builds the notification body from a template and meta values
function buildBody(type, meta) {
    let body = BODY_TEMPLATES[type] || '';
    body = body.replace('{driver_name}', meta.driver_name || '');
    body = body.replace('{bus_number}', meta.bus_number || '');
    return body;
}

// =============================================================================
// queueJourneyNotification
// Queues notifications for all parents whose children are on the given bus.
// This function NEVER throws — all errors are caught and logged.
// =============================================================================
async function queueJourneyNotification(journeyId, type, schoolId) {
    try {
        // a. Fetch journey row to get bus_id and driver_id
        const journeyResult = await pool.query(
            `SELECT bus_id, driver_id FROM journeys
             WHERE id = $1::uuid AND school_id = $2::uuid`,
            [journeyId, schoolId]
        );

        if (journeyResult.rowCount === 0) {
            console.error('queueJourneyNotification: journey not found', journeyId);
            return;
        }

        const { bus_id, driver_id } = journeyResult.rows[0];

        // b. Fetch bus_number
        const busResult = await pool.query(
            `SELECT bus_number FROM buses
             WHERE id = $1::uuid AND school_id = $2::uuid`,
            [bus_id, schoolId]
        );

        const busNumber = busResult.rowCount > 0 ? busResult.rows[0].bus_number : 'Unknown';

        // c. Fetch driver name
        const driverResult = await pool.query(
            `SELECT name FROM users
             WHERE id = $1::uuid AND school_id = $2::uuid`,
            [driver_id, schoolId]
        );

        const driverName = driverResult.rowCount > 0 ? driverResult.rows[0].name : 'Unknown';

        // d. Build notification body
        const meta = { bus_number: busNumber, driver_name: driverName };
        const body = buildBody(type, meta);

        // e. Fetch all active parents of students currently assigned to this bus
        const parentsResult = await pool.query(
            `SELECT DISTINCT u.id AS parent_id
             FROM student_bus_assignments sba
             JOIN parent_students ps ON ps.student_id = sba.student_id
             JOIN users u ON u.id = ps.parent_id
             WHERE sba.bus_id = $1::uuid
               AND sba.is_current = TRUE
               AND sba.school_id = $2::uuid
               AND u.is_active = TRUE
               AND u.role = 'PARENT'`,
            [bus_id, schoolId]
        );

        if (parentsResult.rowCount === 0) {
            console.log('queueJourneyNotification: no parents to notify for journey', journeyId);
            return;
        }

        // f. Insert one notification row per parent
        const notificationIds = [];

        for (const row of parentsResult.rows) {
            const insertResult = await pool.query(
                `INSERT INTO notifications
                   (school_id, recipient_user_id, journey_id, type, body, meta,
                    delivery_status, is_read, created_at, updated_at)
                 VALUES
                   ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
                    'PENDING', FALSE, NOW(), NOW())
                 RETURNING id`,
                [schoolId, row.parent_id, journeyId, type, body, JSON.stringify(meta)]
            );

            notificationIds.push(insertResult.rows[0].id);
        }

        // g. Publish each notification_id to RabbitMQ
        const channel = await getRabbitMQChannel();
        channel.assertQueue(QUEUE_NAME, { durable: true });

        for (const notificationId of notificationIds) {
            channel.sendToQueue(
                QUEUE_NAME,
                Buffer.from(JSON.stringify({ notification_id: notificationId })),
                { persistent: true }
            );
        }

        // h. Log count
        console.log(`queueJourneyNotification: ${notificationIds.length} notifications queued for journey ${journeyId} (${type})`);
    } catch (err) {
        // i. Never throw — log and return gracefully
        console.error('queueJourneyNotification error:', err);
    }
}

// =============================================================================
// getParentNotifications
// Fetches today's notifications for a parent with optional unread filter and pagination
// =============================================================================
async function getParentNotifications(userId, schoolId, { unreadOnly, limit, offset }) {
    const conditions = [
        'recipient_user_id = $1::uuid',
        'school_id = $2::uuid',
        'created_at >= CURRENT_DATE',
    ];
    const params = [userId, schoolId];
    let paramIndex = 3;

    if (unreadOnly) {
        conditions.push('is_read = FALSE');
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Fetch notifications
    const result = await pool.query(
        `SELECT id, journey_id, type, body, meta, delivery_status,
                is_read, delivered_at, created_at
         FROM notifications
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
    );

    // Fetch total count for this query
    const countResult = await pool.query(
        `SELECT COUNT(*) FROM notifications ${whereClause}`,
        params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Fetch unread count (always today's unread, regardless of unread_only filter)
    const unreadResult = await pool.query(
        `SELECT COUNT(*) FROM notifications
         WHERE recipient_user_id = $1::uuid
           AND school_id = $2::uuid
           AND is_read = FALSE
           AND created_at >= CURRENT_DATE`,
        [userId, schoolId]
    );
    const unreadCount = parseInt(unreadResult.rows[0].count, 10);

    return { notifications: result.rows, total, unread_count: unreadCount };
}

// =============================================================================
// markAsRead
// Marks a single notification as read for the given parent
// =============================================================================
async function markAsRead(notificationId, userId, schoolId) {
    const result = await pool.query(
        `UPDATE notifications
         SET is_read = TRUE, updated_at = NOW()
         WHERE id = $1::uuid
           AND recipient_user_id = $2::uuid
           AND school_id = $3::uuid
         RETURNING id, is_read`,
        [notificationId, userId, schoolId]
    );

    return result.rowCount > 0 ? result.rows[0] : null;
}

// =============================================================================
// markAllAsRead
// Marks all of today's unread notifications as read for a parent
// =============================================================================
async function markAllAsRead(userId, schoolId) {
    const result = await pool.query(
        `UPDATE notifications
         SET is_read = TRUE, updated_at = NOW()
         WHERE recipient_user_id = $1::uuid
           AND school_id = $2::uuid
           AND is_read = FALSE
           AND created_at >= CURRENT_DATE`,
        [userId, schoolId]
    );

    return { updated: result.rowCount };
}

// =============================================================================
// getSchoolNotificationsToday
// Fetches all notifications sent today for a school, with optional journey_id filter
// =============================================================================
async function getSchoolNotificationsToday(schoolId, journeyIdFilter) {
    const conditions = [
        'n.school_id = $1::uuid',
        'n.created_at >= CURRENT_DATE',
    ];
    const params = [schoolId];
    let paramIndex = 2;

    if (journeyIdFilter) {
        conditions.push(`n.journey_id = $${paramIndex}::uuid`);
        params.push(journeyIdFilter);
        paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await pool.query(
        `SELECT n.id, n.recipient_user_id, n.journey_id, n.type,
                n.body, n.meta, n.delivery_status, n.is_read,
                n.delivered_at, n.created_at,
                u.name AS recipient_name
         FROM notifications n
         JOIN users u ON u.id = n.recipient_user_id
         ${whereClause}
         ORDER BY n.created_at DESC`,
        params
    );

    return { notifications: result.rows, total: result.rowCount };
}

module.exports = {
    queueJourneyNotification,
    getParentNotifications,
    markAsRead,
    markAllAsRead,
    getSchoolNotificationsToday,
};
