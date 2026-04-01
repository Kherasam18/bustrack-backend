// =============================================================================
// src/modules/routes/routes.routes.js
// Routes for route-centric views, stop-student management, and driver route
//
// School Admin endpoints (authenticate + enforceSchoolScope + requireSchoolAdmin):
//   GET    /api/routes                                     List all routes
//   GET    /api/routes/:routeId                            Get route details
//   POST   /api/routes/:routeId/stops/:stopId/students     Assign student to stop
//   DELETE /api/routes/:routeId/stops/:stopId/students/:studentId  Remove student
//   GET    /api/routes/:routeId/stops/:stopId/students     List stop students
//
// Driver endpoint (authenticate + enforceSchoolScope + requireDriver):
//   GET    /api/routes/my-route                            Get driver's route
// =============================================================================

const express = require('express');
const router = express.Router();

const {
    authenticate,
    requireSchoolAdmin,
    requireDriver,
    enforceSchoolScope,
} = require('../../middleware/auth');

const {
    listRoutes,
    getRoute,
    assignStudentToStop,
    removeStudentFromStop,
    listStopStudents,
    getMyRoute,
} = require('./routes.controller');

// All routes require authentication + school scope
router.use(authenticate, enforceSchoolScope);

// =============================================================================
// DRIVER ROUTE — must be declared before /:routeId to avoid param conflicts
// =============================================================================
router.get('/my-route', requireDriver, getMyRoute);

// =============================================================================
// SCHOOL ADMIN ROUTES
// =============================================================================
router.get('/',        requireSchoolAdmin, listRoutes);
router.get('/:routeId', requireSchoolAdmin, getRoute);

// Stop-student management
router.post('/:routeId/stops/:stopId/students',              requireSchoolAdmin, assignStudentToStop);
router.get('/:routeId/stops/:stopId/students',               requireSchoolAdmin, listStopStudents);
router.delete('/:routeId/stops/:stopId/students/:studentId', requireSchoolAdmin, removeStudentFromStop);

module.exports = router;
