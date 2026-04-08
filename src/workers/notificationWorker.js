// =============================================================================
// src/workers/notificationWorker.js
// RabbitMQ consumer — processes notification delivery via FCM
//
// Reads notification_id from the queue, fetches the notification row,
// retrieves FCM tokens for the recipient, sends push notifications,
// and updates delivery_status accordingly.
//
// This worker NEVER crashes the Express process. All errors are caught
// per message. On connection failure, retries after 5 seconds.
// =============================================================================

const pool = require('../config/db');
const { getRabbitMQChannel } = require('../config/rabbitmq');
const admin = require('../config/firebase');

const QUEUE_NAME = 'bustrack.notifications';

// Starts the RabbitMQ consumer loop for notification delivery
async function startWorker() {
    try {
        const channel = await getRabbitMQChannel();

        await channel.assertQueue(QUEUE_NAME, { durable: true });
        channel.prefetch(1);

        console.log('🔔 Notification worker started — waiting for messages');

        channel.consume(QUEUE_NAME, async (msg) => {
            if (!msg) return;

            try {
                // i. Parse the message to get notification_id
                const { notification_id } = JSON.parse(msg.content.toString());

                // ii. Fetch the notification row from DB
                const notifResult = await pool.query(
                    `SELECT n.id, n.recipient_user_id, n.school_id, n.body,
                            n.type, n.meta, n.delivery_status
                     FROM notifications n
                     WHERE n.id = $1::uuid`,
                    [notification_id]
                );

                if (notifResult.rowCount === 0) {
                    console.log('Worker: notification not found, skipping', notification_id);
                    channel.ack(msg);
                    return;
                }

                const notification = notifResult.rows[0];

                // Skip if already delivered
                if (notification.delivery_status === 'SENT') {
                    console.log('Worker: notification already sent, skipping', notification_id);
                    channel.ack(msg);
                    return;
                }

                // iii. Fetch FCM tokens for the recipient
                const tokensResult = await pool.query(
                    `SELECT fcm_token FROM user_devices
                     WHERE user_id = $1::uuid`,
                    [notification.recipient_user_id]
                );

                if (tokensResult.rowCount === 0) {
                    // No tokens — mark as FAILED
                    await pool.query(
                        `UPDATE notifications
                         SET delivery_status = 'FAILED', updated_at = NOW()
                         WHERE id = $1::uuid`,
                        [notification_id]
                    );
                    console.log('Worker: no FCM tokens for user', notification.recipient_user_id);
                    channel.ack(msg);
                    return;
                }

                // iv. Send FCM to each token
                let allSucceeded = true;

                for (const row of tokensResult.rows) {
                    try {
                        await admin.messaging().send({
                            token: row.fcm_token,
                            notification: {
                                title: 'BusTrack',
                                body: notification.body,
                            },
                            data: {
                                type: notification.type,
                                notification_id: notification.id,
                            },
                        });
                    } catch (fcmErr) {
                        console.error('Worker: FCM send error for token', row.fcm_token, fcmErr.message);
                        allSucceeded = false;
                    }
                }

                // Update delivery status based on outcome
                if (allSucceeded) {
                    await pool.query(
                        `UPDATE notifications
                         SET delivery_status = 'SENT', delivered_at = NOW(), updated_at = NOW()
                         WHERE id = $1::uuid`,
                        [notification_id]
                    );
                } else {
                    await pool.query(
                        `UPDATE notifications
                         SET delivery_status = 'FAILED', updated_at = NOW()
                         WHERE id = $1::uuid`,
                        [notification_id]
                    );
                }

                // v. Always ack the message
                channel.ack(msg);
            } catch (err) {
                // vi. Catch all errors per message — never crash the consumer loop
                console.error('Worker: error processing message:', err);
                channel.ack(msg);
            }
        });
    } catch (err) {
        // e. On RabbitMQ connection error — log and retry after 5 seconds
        console.error('Notification worker connection error:', err.message);
        console.log('Retrying notification worker in 5 seconds...');
        setTimeout(startWorker, 5000);
    }
}

module.exports = { startWorker };
