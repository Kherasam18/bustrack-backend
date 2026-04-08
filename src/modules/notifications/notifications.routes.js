// =============================================================================
// src/modules/notifications/notifications.routes.js
// Route definitions for the Notifications module
//
// Parent routes: GET /, PATCH /read-all, PATCH /:notificationId/read
// School Admin routes: GET /school/today
//
// IMPORTANT: /read-all MUST be registered BEFORE /:notificationId/read
// to prevent Express from matching "read-all" as a notificationId param.
// =============================================================================

const { Router } = require('express');
const {
    authenticate,
    requireParent,
    requireSchoolAdmin,
    enforceSchoolScope,
} = require('../../middleware/auth');
const controller = require('./notifications.controller');

const router = Router();

// =============================================================================
// Parent endpoints — authenticate + requireParent
// =============================================================================

// Fetch today's notifications for the logged-in parent
router.get(
    '/',
    authenticate,
    requireParent,
    controller.getNotifications
);

// Mark ALL of today's unread notifications as read (must come before /:notificationId)
router.patch(
    '/read-all',
    authenticate,
    requireParent,
    controller.markAllAsRead
);

// Mark a single notification as read
router.patch(
    '/:notificationId/read',
    authenticate,
    requireParent,
    controller.markAsRead
);

// =============================================================================
// School Admin endpoints — authenticate + enforceSchoolScope + requireSchoolAdmin
// =============================================================================

// Fetch all notifications sent today for the school
router.get(
    '/school/today',
    authenticate,
    enforceSchoolScope,
    requireSchoolAdmin,
    controller.getSchoolNotificationsToday
);

module.exports = router;
