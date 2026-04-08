// =============================================================================
// src/modules/notifications/notifications.controller.js
// Controller for Notification REST endpoints
//
// Parent endpoints: list own notifications, mark read, mark all read
// School Admin endpoints: view all school notifications today
//
// All DB logic is delegated to notifications.service.js.
// =============================================================================

const { success, error } = require('../../utils/response');
const { isValidUUID } = require('../journeys/journeys.service');
const notificationsService = require('./notifications.service');

// =============================================================================
// getNotifications — GET /api/notifications
// Returns today's notifications for the logged-in parent, newest first
// =============================================================================
async function getNotifications(req, res) {
    try {
        const userId = req.user.userId;
        const schoolId = req.user.school_id;

        const unreadOnly = req.query.unread_only === 'true';
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        const result = await notificationsService.getParentNotifications(userId, schoolId, {
            unreadOnly,
            limit,
            offset,
        });

        return success(res, {
            notifications: result.notifications,
            total: result.total,
            unread_count: result.unread_count,
        }, 'Notifications retrieved');
    } catch (err) {
        console.error('getNotifications error:', err);
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// markAsRead — PATCH /api/notifications/:notificationId/read
// Marks a single notification as read for the logged-in parent
// =============================================================================
async function markAsRead(req, res) {
    try {
        const userId = req.user.userId;
        const schoolId = req.user.school_id;
        const { notificationId } = req.params;

        // Validate UUID format
        if (!isValidUUID(notificationId)) {
            return error(res, 'Invalid notification ID format', 400);
        }

        const result = await notificationsService.markAsRead(notificationId, userId, schoolId);

        if (!result) {
            return error(res, 'Notification not found', 404);
        }

        return success(res, { id: result.id, is_read: result.is_read }, 'Notification marked as read');
    } catch (err) {
        console.error('markAsRead error:', err);
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// markAllAsRead — PATCH /api/notifications/read-all
// Marks all of today's unread notifications as read for the logged-in parent
// =============================================================================
async function markAllAsRead(req, res) {
    try {
        const userId = req.user.userId;
        const schoolId = req.user.school_id;

        const result = await notificationsService.markAllAsRead(userId, schoolId);

        return success(res, { updated: result.updated }, 'All notifications marked as read');
    } catch (err) {
        console.error('markAllAsRead error:', err);
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// getSchoolNotificationsToday — GET /api/notifications/school/today
// Returns all notifications sent today for the school (School Admin only)
// =============================================================================
async function getSchoolNotificationsToday(req, res) {
    try {
        const schoolId = req.schoolId;
        const journeyIdFilter = req.query.journey_id || null;

        // Validate journey_id filter if provided
        if (journeyIdFilter && !isValidUUID(journeyIdFilter)) {
            return error(res, 'Invalid journey_id format', 400);
        }

        const result = await notificationsService.getSchoolNotificationsToday(schoolId, journeyIdFilter);

        return success(res, {
            notifications: result.notifications,
            total: result.total,
        }, 'School notifications retrieved');
    } catch (err) {
        console.error('getSchoolNotificationsToday error:', err);
        return error(res, 'Internal server error', 500);
    }
}

module.exports = {
    getNotifications,
    markAsRead,
    markAllAsRead,
    getSchoolNotificationsToday,
};
