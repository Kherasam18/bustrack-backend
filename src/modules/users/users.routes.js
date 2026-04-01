// =============================================================================
// src/modules/users/users.routes.js
// Routes for driver and parent user management — School Admin only
//
// All routes require: authenticate + enforceSchoolScope
// Sub-routes are grouped by role: /drivers and /parents
//
// Driver endpoints:
//   POST   /api/users/drivers                         Create driver
//   GET    /api/users/drivers                         List drivers
//   GET    /api/users/drivers/:userId                 Get driver
//   PATCH  /api/users/drivers/:userId                 Update driver
//   DELETE /api/users/drivers/:userId/deactivate      Deactivate driver
//   PUT    /api/users/drivers/:userId/reactivate      Reactivate driver
//   POST   /api/users/drivers/:userId/reset-password  Reset driver password
//
// Parent endpoints:
//   POST   /api/users/parents                         Create parent
//   GET    /api/users/parents                         List parents
//   GET    /api/users/parents/:userId                 Get parent + children
//   PATCH  /api/users/parents/:userId                 Update parent
//   DELETE /api/users/parents/:userId/deactivate      Deactivate parent
//   PUT    /api/users/parents/:userId/reactivate      Reactivate parent
//   POST   /api/users/parents/:userId/reset-password  Reset parent password
// =============================================================================

const express = require('express');
const router = express.Router();

const {
    authenticate,
    requireSchoolAdmin,
    enforceSchoolScope,
} = require('../../middleware/auth');

const {
    // Drivers
    createDriver,
    listDrivers,
    getDriver,
    updateDriver,
    deactivateDriver,
    reactivateDriver,
    resetDriverPassword,
    // Parents
    createParent,
    listParents,
    getParent,
    updateParent,
    deactivateParent,
    reactivateParent,
    resetParentPassword,
} = require('./users.controller');

// All user-management routes require authentication + school scope
router.use(authenticate, enforceSchoolScope);

// =============================================================================
// DRIVER ROUTES — School Admin only
// =============================================================================
router.post('/drivers',                        requireSchoolAdmin, createDriver);
router.get('/drivers',                         requireSchoolAdmin, listDrivers);
router.get('/drivers/:userId',                 requireSchoolAdmin, getDriver);
router.patch('/drivers/:userId',               requireSchoolAdmin, updateDriver);
router.delete('/drivers/:userId/deactivate',   requireSchoolAdmin, deactivateDriver);
router.put('/drivers/:userId/reactivate',      requireSchoolAdmin, reactivateDriver);
router.post('/drivers/:userId/reset-password', requireSchoolAdmin, resetDriverPassword);

// =============================================================================
// PARENT ROUTES — School Admin only
// =============================================================================
router.post('/parents',                        requireSchoolAdmin, createParent);
router.get('/parents',                         requireSchoolAdmin, listParents);
router.get('/parents/:userId',                 requireSchoolAdmin, getParent);
router.patch('/parents/:userId',               requireSchoolAdmin, updateParent);
router.delete('/parents/:userId/deactivate',   requireSchoolAdmin, deactivateParent);
router.put('/parents/:userId/reactivate',      requireSchoolAdmin, reactivateParent);
router.post('/parents/:userId/reset-password', requireSchoolAdmin, resetParentPassword);

module.exports = router;
