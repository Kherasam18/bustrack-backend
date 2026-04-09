// =============================================================================
// src/modules/dashboard/dashboard.routes.js
// Routes for School Admin dashboard endpoints
//
// All routes require: authenticate + enforceSchoolScope + requireSchoolAdmin
//
//   GET   /api/dashboard/live          Live fleet overview
//   GET   /api/dashboard/buses/:busId  Single bus detail
//   GET   /api/dashboard/stats         Summary counts
// =============================================================================

const express = require('express');
const router = express.Router();

const {
    authenticate,
    requireSchoolAdmin,
    enforceSchoolScope,
} = require('../../middleware/auth');

const {
    getLive,
    getBusDetail,
    getStats,
} = require('./dashboard.controller');

// =============================================================================
// SCHOOL ADMIN DASHBOARD ROUTES
// =============================================================================
router.get('/live',          authenticate, enforceSchoolScope, requireSchoolAdmin, getLive);
router.get('/buses/:busId',  authenticate, enforceSchoolScope, requireSchoolAdmin, getBusDetail);
router.get('/stats',         authenticate, enforceSchoolScope, requireSchoolAdmin, getStats);

module.exports = router;
