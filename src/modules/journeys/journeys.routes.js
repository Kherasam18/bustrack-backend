// =============================================================================
// src/modules/journeys/journeys.routes.js
// Routes for Journey lifecycle and read endpoints
//
// Driver action endpoints (authenticate + requireDriver):
//   POST  /api/journeys/start-pickup      Start pickup journey
//   POST  /api/journeys/arrived-school     Mark arrived at school
//   POST  /api/journeys/start-drop         Start drop journey
//   POST  /api/journeys/end-journey        End drop journey
//   GET   /api/journeys/my-today           Driver's own today journeys
//
// School Admin read endpoints (authenticate + enforceSchoolScope + requireSchoolAdmin):
//   GET   /api/journeys/today              All today's journeys for school
//   GET   /api/journeys/:journeyId         Single journey by ID
//   GET   /api/journeys                    Paginated journey history
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
    startPickup,
    arrivedSchool,
    startDrop,
    endJourney,
    myToday,
    todayJourneys,
    getJourney,
    journeyHistory,
} = require('./journeys.controller');

// =============================================================================
// DRIVER ACTION ROUTES — requires authenticate + requireDriver
// =============================================================================
router.post('/start-pickup',    authenticate, requireDriver, startPickup);
router.post('/arrived-school',  authenticate, requireDriver, arrivedSchool);
router.post('/start-drop',      authenticate, requireDriver, startDrop);
router.post('/end-journey',     authenticate, requireDriver, endJourney);
router.get('/my-today',         authenticate, requireDriver, myToday);

// =============================================================================
// SCHOOL ADMIN READ ROUTES — requires authenticate + enforceSchoolScope + requireSchoolAdmin
// "today" must be declared before ":journeyId" to avoid route param conflict
// =============================================================================
router.get('/today',            authenticate, enforceSchoolScope, requireSchoolAdmin, todayJourneys);
router.get('/:journeyId',      authenticate, enforceSchoolScope, requireSchoolAdmin, getJourney);
router.get('/',                 authenticate, enforceSchoolScope, requireSchoolAdmin, journeyHistory);

module.exports = router;
