// =============================================================================
// src/modules/schools/schools.routes.js
// Routes for school management — Super Admin only
//
// Endpoints:
//   GET    /api/schools/by-code/:code                         Resolve school code to UUID (public)
//   POST   /api/schools                                       Create a new school
//   GET    /api/schools                                       List all schools (paginated)
//   GET    /api/schools/:schoolId                             Get a single school with stats
//   PATCH  /api/schools/:schoolId                             Update school details
//   DELETE /api/schools/:schoolId/deactivate                  Deactivate school + users
//   PUT    /api/schools/:schoolId/reactivate                  Reactivate school
//   POST   /api/schools/:schoolId/admin                       Create School Admin for a school
//   GET    /api/schools/:schoolId/admin                       Get School Admin for a school
//   POST   /api/schools/:schoolId/admin/:userId/reset-password  Reset School Admin password
//   DELETE /api/schools/:schoolId/admin/:userId/deactivate     Deactivate School Admin
//   PUT    /api/schools/:schoolId/admin/:userId/reactivate     Reactivate School Admin
// =============================================================================

const express = require('express');
const router = express.Router();

const { authenticate, requireSuperAdmin } = require('../../middleware/auth');
const {
    createSchool,
    listSchools,
    getSchool,
    updateSchool,
    deactivateSchool,
    reactivateSchool,
    createSchoolAdmin,
    getSchoolAdmin,
    resetSchoolAdminPassword,
    deactivateSchoolAdmin,
    reactivateSchoolAdmin,
    getSchoolByCode,
} = require('./schools.controller');

// Public route — no auth required — must be before authenticate middleware
router.get('/by-code/:code', getSchoolByCode);

// All routes below require Super Admin privileges
router.post('/', authenticate, requireSuperAdmin, createSchool);
router.get('/', authenticate, requireSuperAdmin, listSchools);
router.get('/:schoolId', authenticate, requireSuperAdmin, getSchool);
router.patch('/:schoolId', authenticate, requireSuperAdmin, updateSchool);
router.delete('/:schoolId/deactivate', authenticate, requireSuperAdmin, deactivateSchool);
router.put('/:schoolId/reactivate', authenticate, requireSuperAdmin, reactivateSchool);
router.post('/:schoolId/admin', authenticate, requireSuperAdmin, createSchoolAdmin);
router.get('/:schoolId/admin', authenticate, requireSuperAdmin, getSchoolAdmin);
router.post('/:schoolId/admin/:userId/reset-password', authenticate, requireSuperAdmin, resetSchoolAdminPassword);
router.delete('/:schoolId/admin/:userId/deactivate', authenticate, requireSuperAdmin, deactivateSchoolAdmin);
router.put('/:schoolId/admin/:userId/reactivate', authenticate, requireSuperAdmin, reactivateSchoolAdmin);
module.exports = router;
