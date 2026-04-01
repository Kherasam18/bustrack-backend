// =============================================================================
// src/modules/buses/buses.routes.js
// Routes for bus, route, stop, and student assignment management
//
// All routes require: authenticate + enforceSchoolScope + requireSchoolAdmin
//
// Bus CRUD:
//   POST   /api/buses                                Create bus
//   GET    /api/buses                                List buses (paginated)
//   GET    /api/buses/:busId                         Get bus with full details
//   PATCH  /api/buses/:busId                         Update bus
//   DELETE /api/buses/:busId/deactivate              Deactivate bus
//   PUT    /api/buses/:busId/reactivate              Reactivate bus
//
// Route management:
//   POST   /api/buses/:busId/route                   Create route for bus
//   GET    /api/buses/:busId/route                   Get active route with stops
//   PATCH  /api/buses/:busId/route                   Update route details
//
// Stop management:
//   POST   /api/buses/:busId/route/stops             Add a stop to route
//   PATCH  /api/buses/:busId/route/stops/:stopId     Update a stop
//   DELETE /api/buses/:busId/route/stops/:stopId     Delete a stop
//   PUT    /api/buses/:busId/route/stops/reorder     Reorder all stops
//
// Student assignments:
//   POST   /api/buses/:busId/students                Assign student to bus
//   DELETE /api/buses/:busId/students/:studentId     Unassign student from bus
//   GET    /api/buses/:busId/students                List students on this bus
// =============================================================================

const express = require('express');
const router = express.Router();

const {
    authenticate,
    requireSchoolAdmin,
    enforceSchoolScope,
} = require('../../middleware/auth');

const {
    // Bus CRUD
    createBus,
    listBuses,
    getBus,
    updateBus,
    deactivateBus,
    reactivateBus,
    // Route management
    createRoute,
    getRoute,
    updateRoute,
    // Stop management
    addStop,
    updateStop,
    deleteStop,
    reorderStops,
    // Student assignments
    assignStudent,
    unassignStudent,
    listBusStudents,
} = require('./buses.controller');

// All bus routes require authentication + school scope
router.use(authenticate, enforceSchoolScope);

// =============================================================================
// BUS CRUD ROUTES — School Admin only
// =============================================================================
router.post('/',                       requireSchoolAdmin, createBus);
router.get('/',                        requireSchoolAdmin, listBuses);
router.get('/:busId',                  requireSchoolAdmin, getBus);
router.patch('/:busId',               requireSchoolAdmin, updateBus);
router.delete('/:busId/deactivate',   requireSchoolAdmin, deactivateBus);
router.put('/:busId/reactivate',      requireSchoolAdmin, reactivateBus);

// =============================================================================
// ROUTE MANAGEMENT — School Admin only
// =============================================================================
router.post('/:busId/route',           requireSchoolAdmin, createRoute);
router.get('/:busId/route',            requireSchoolAdmin, getRoute);
router.patch('/:busId/route',          requireSchoolAdmin, updateRoute);

// =============================================================================
// STOP MANAGEMENT — School Admin only
// Reorder must be declared before /:stopId to avoid route conflicts
// =============================================================================
router.put('/:busId/route/stops/reorder',    requireSchoolAdmin, reorderStops);
router.post('/:busId/route/stops',           requireSchoolAdmin, addStop);
router.patch('/:busId/route/stops/:stopId',  requireSchoolAdmin, updateStop);
router.delete('/:busId/route/stops/:stopId', requireSchoolAdmin, deleteStop);

// =============================================================================
// STUDENT ASSIGNMENT ROUTES — School Admin only
// =============================================================================
router.post('/:busId/students',              requireSchoolAdmin, assignStudent);
router.get('/:busId/students',               requireSchoolAdmin, listBusStudents);
router.delete('/:busId/students/:studentId', requireSchoolAdmin, unassignStudent);

module.exports = router;
