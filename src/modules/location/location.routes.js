// =============================================================================
// src/modules/location/location.routes.js
// Routes for GPS location tracking
//
// POST  /api/location/update                Driver pushes GPS coordinate
// GET   /api/location/journey/:journeyId    School Admin views location log
// =============================================================================

const express = require('express');
const router = express.Router();

const {
    authenticate,
    requireDriver,
    requireSchoolAdmin,
    enforceSchoolScope,
} = require('../../middleware/auth');

const {
    updateLocation,
    getJourneyLocations,
} = require('./location.controller');

// =============================================================================
// DRIVER ROUTE — authenticate + requireDriver
// =============================================================================
router.post('/update', authenticate, requireDriver, updateLocation);

// =============================================================================
// SCHOOL ADMIN ROUTE — authenticate + enforceSchoolScope + requireSchoolAdmin
// =============================================================================
router.get('/journey/:journeyId', authenticate, enforceSchoolScope, requireSchoolAdmin, getJourneyLocations);

module.exports = router;
