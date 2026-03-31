// =============================================================================
// src/modules/schools/schools.routes.js
// Routes for school management — Super Admin only
//
// Endpoints:
//   POST   /api/schools                        Create a new school
//   GET    /api/schools                        List all schools (paginated)
//   GET    /api/schools/:schoolId              Get a single school with stats
//   PATCH  /api/schools/:schoolId              Update school details
//   DELETE /api/schools/:schoolId/deactivate   Deactivate school + users
//   PUT    /api/schools/:schoolId/reactivate   Reactivate school
//   POST   /api/schools/:schoolId/admin        Create School Admin for a school
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

module.exports = router;
