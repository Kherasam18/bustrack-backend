// =============================================================================
// src/modules/students/students.routes.js
// Routes for student management — School Admin only
//
// All routes require: authenticate + enforceSchoolScope + requireSchoolAdmin
//
// Student CRUD:
//   POST   /api/students                              Create student
//   GET    /api/students                              List students (paginated)
//   GET    /api/students/:studentId                   Get student with details
//   PATCH  /api/students/:studentId                   Update student
//   DELETE /api/students/:studentId/deactivate        Deactivate student
//   PUT    /api/students/:studentId/reactivate        Reactivate student
//
// Parent linking:
//   POST   /api/students/:studentId/parents           Link parent to student
//   DELETE /api/students/:studentId/parents/:parentId Unlink parent from student
//
// Bulk:
//   POST   /api/students/import                       Bulk import students
// =============================================================================

const express = require('express');
const router = express.Router();

const {
    authenticate,
    requireSchoolAdmin,
    enforceSchoolScope,
} = require('../../middleware/auth');

const {
    createStudent,
    listStudents,
    getStudent,
    updateStudent,
    deactivateStudent,
    reactivateStudent,
    linkParent,
    unlinkParent,
    bulkImport,
} = require('./students.controller');

// All student-management routes require authentication + school scope
router.use(authenticate, enforceSchoolScope);

// =============================================================================
// BULK IMPORT — must be declared before /:studentId to avoid route conflicts
// =============================================================================
router.post('/import', requireSchoolAdmin, bulkImport);

// =============================================================================
// STUDENT CRUD ROUTES — School Admin only
// =============================================================================
router.post('/',                          requireSchoolAdmin, createStudent);
router.get('/',                           requireSchoolAdmin, listStudents);
router.get('/:studentId',                 requireSchoolAdmin, getStudent);
router.patch('/:studentId',               requireSchoolAdmin, updateStudent);
router.delete('/:studentId/deactivate',   requireSchoolAdmin, deactivateStudent);
router.put('/:studentId/reactivate',      requireSchoolAdmin, reactivateStudent);

// =============================================================================
// PARENT LINKING ROUTES — School Admin only
// =============================================================================
router.post('/:studentId/parents',            requireSchoolAdmin, linkParent);
router.delete('/:studentId/parents/:parentId', requireSchoolAdmin, unlinkParent);

module.exports = router;
