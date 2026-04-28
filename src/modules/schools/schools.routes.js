// =============================================================================
// src/modules/schools/schools.routes.js
// Routes for school management — Super Admin only
//
// Endpoints:
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
} = require('./schools.controller');

// All school-management routes require Super Admin privileges
router.use(authenticate, requireSuperAdmin);

router.post('/', createSchool);
router.get('/', listSchools);
router.get('/:schoolId', getSchool);
router.patch('/:schoolId', updateSchool);
router.delete('/:schoolId/deactivate', deactivateSchool);
router.put('/:schoolId/reactivate', reactivateSchool);
router.post('/:schoolId/admin', createSchoolAdmin);

// Get the School Admin for a school (null if none exists)
router.get('/:schoolId/admin', getSchoolAdmin);

// Reset School Admin password
router.post('/:schoolId/admin/:userId/reset-password', resetSchoolAdminPassword);

// Deactivate School Admin
router.delete('/:schoolId/admin/:userId/deactivate', deactivateSchoolAdmin);

// Reactivate School Admin
router.put('/:schoolId/admin/:userId/reactivate', reactivateSchoolAdmin);

module.exports = router;
