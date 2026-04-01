// =============================================================================
// src/modules/students/students.controller.js
// Controller for Student management — School Admin only
//
// All endpoints are scoped to the caller's school via req.schoolId.
// Supports CRUD, deactivate/reactivate, parent linking, and bulk import.
// =============================================================================

const pool = require('../../config/db');
const { success, error } = require('../../utils/response');
const { parsePagination, paginationMeta } = require('../../utils/pagination');

// Regex for UUID v1–v5 validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(id) {
    return typeof id === 'string' && UUID_REGEX.test(id);
}

// Maximum number of students per bulk import request
const BULK_IMPORT_MAX = 500;

// =============================================================================
// createStudent
// POST /api/students
//
// Creates a single student for the school.
// Body: { name, roll_no, class, section? }
// - name, roll_no, class are required
// - Checks UNIQUE(school_id, class, section, roll_no) — 409 if duplicate
// =============================================================================
async function createStudent(req, res) {
    try {
        const schoolId = req.schoolId;
        const { name, roll_no, section } = req.body;
        const studentClass = req.body.class;

        // --- Validation ---
        if (!name || !String(name).trim()) {
            return error(res, 'Student name is required', 400);
        }
        if (!roll_no || !String(roll_no).trim()) {
            return error(res, 'Roll number is required', 400);
        }
        if (!studentClass || !String(studentClass).trim()) {
            return error(res, 'Class is required', 400);
        }

        const trimmedName = String(name).trim();
        const trimmedRollNo = String(roll_no).trim();
        const trimmedClass = String(studentClass).trim();
        const trimmedSection = section ? String(section).trim() : null;

        // --- Check duplicate: UNIQUE(school_id, class, section, roll_no) ---
        const dupCheck = await pool.query(
            `SELECT id FROM students
             WHERE school_id = $1 AND class = $2 AND roll_no = $3
               AND (section IS NOT DISTINCT FROM $4)`,
            [schoolId, trimmedClass, trimmedRollNo, trimmedSection]
        );

        if (dupCheck.rowCount > 0) {
            return error(
                res,
                `Student with roll number '${trimmedRollNo}' already exists in class '${trimmedClass}'${trimmedSection ? ` section '${trimmedSection}'` : ''}`,
                409
            );
        }

        // --- Insert ---
        const result = await pool.query(
            `INSERT INTO students (school_id, name, roll_no, class, section, is_active, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, TRUE, NOW(), NOW())
             RETURNING id, school_id, name, roll_no, class, section, is_active, created_at, updated_at`,
            [schoolId, trimmedName, trimmedRollNo, trimmedClass, trimmedSection]
        );

        return success(res, { student: result.rows[0] }, 'Student created successfully', 201);

    } catch (err) {
        console.error('createStudent error:', err);
        return error(res, 'Failed to create student', 500, err.message);
    }
}

// =============================================================================
// listStudents
// GET /api/students
//
// Returns a paginated list of students for the school.
// Query: ?page&limit&search&class&section&status=active|inactive|all
// - search: ILIKE on name and roll_no
// - Includes assigned bus info (is_current = TRUE) via LEFT JOIN
// =============================================================================
async function listStudents(req, res) {
    try {
        const schoolId = req.schoolId;
        const { limit, offset, page } = parsePagination(req.query);
        const search = req.query.search ? String(req.query.search).trim() : '';
        const classFilter = req.query.class ? String(req.query.class).trim() : '';
        const sectionFilter = req.query.section ? String(req.query.section).trim() : '';
        const status = req.query.status ? String(req.query.status).trim().toLowerCase() : 'active';

        const conditions = [`s.school_id = $1`];
        const params = [schoolId];
        let paramIndex = 2;

        // Status filter (default: active)
        if (status === 'active') {
            conditions.push(`s.is_active = TRUE`);
        } else if (status === 'inactive') {
            conditions.push(`s.is_active = FALSE`);
        }
        // 'all' — no status filter

        // Search filter (ILIKE on name and roll_no)
        if (search) {
            conditions.push(`(s.name ILIKE $${paramIndex} OR s.roll_no ILIKE $${paramIndex})`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        // Class filter — exact match
        if (classFilter) {
            conditions.push(`s.class = $${paramIndex}`);
            params.push(classFilter);
            paramIndex++;
        }

        // Section filter — exact match
        if (sectionFilter) {
            conditions.push(`s.section = $${paramIndex}`);
            params.push(sectionFilter);
            paramIndex++;
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        // Count
        const countResult = await pool.query(
            `SELECT COUNT(*) AS total FROM students s ${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].total, 10);

        // Fetch with LEFT JOIN for current bus assignment
        const dataResult = await pool.query(
            `SELECT s.id, s.name, s.roll_no, s.class, s.section, s.is_active, s.created_at,
                    sba.bus_id, b.bus_number
             FROM students s
             LEFT JOIN student_bus_assignments sba
               ON sba.student_id = s.id AND sba.is_current = TRUE
             LEFT JOIN buses b
               ON b.id = sba.bus_id
             ${whereClause}
             ORDER BY s.class ASC, s.section ASC, s.roll_no ASC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...params, limit, offset]
        );

        return success(res, {
            students: dataResult.rows,
            pagination: paginationMeta(total, limit, page),
        }, 'Students retrieved successfully');

    } catch (err) {
        console.error('listStudents error:', err);
        return error(res, 'Failed to retrieve students', 500, err.message);
    }
}

// =============================================================================
// getStudent
// GET /api/students/:studentId
//
// Fetches a single student with:
//   1. Student details
//   2. Linked parents array (from parent_students JOIN users)
//   3. Current bus assignment if exists
// =============================================================================
async function getStudent(req, res) {
    try {
        const { studentId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(studentId)) {
            return error(res, 'Invalid student ID format', 400);
        }

        // Fetch student
        const studentResult = await pool.query(
            `SELECT id, school_id, name, roll_no, class, section, is_active, created_at, updated_at
             FROM students
             WHERE id = $1 AND school_id = $2`,
            [studentId, schoolId]
        );

        if (studentResult.rowCount === 0) {
            return error(res, 'Student not found', 404);
        }

        const student = studentResult.rows[0];

        // Fetch linked parents
        const parentsResult = await pool.query(
            `SELECT u.id, u.name, u.phone, u.email, u.is_active
             FROM parent_students ps
             JOIN users u ON u.id = ps.parent_id
             WHERE ps.student_id = $1`,
            [studentId]
        );

        // Fetch current bus assignment
        const busResult = await pool.query(
            `SELECT sba.bus_id, b.bus_number, sba.effective_from
             FROM student_bus_assignments sba
             JOIN buses b ON b.id = sba.bus_id
             WHERE sba.student_id = $1 AND sba.is_current = TRUE`,
            [studentId]
        );

        return success(res, {
            student: {
                ...student,
                parents: parentsResult.rows,
                current_bus: busResult.rowCount > 0 ? busResult.rows[0] : null,
            },
        }, 'Student retrieved successfully');

    } catch (err) {
        console.error('getStudent error:', err);
        return error(res, 'Failed to retrieve student', 500, err.message);
    }
}

// =============================================================================
// updateStudent
// PATCH /api/students/:studentId
//
// Updates student details. roll_no is NOT updatable after creation.
// Body: { name?, class?, section? }
// - If class or section is changed, re-checks roll_no uniqueness — 409 if conflict
// =============================================================================
async function updateStudent(req, res) {
    try {
        const { studentId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(studentId)) {
            return error(res, 'Invalid student ID format', 400);
        }

        const { name, section } = req.body;
        const studentClass = req.body.class;

        const hasName = name !== undefined && name !== null;
        const hasClass = studentClass !== undefined && studentClass !== null;
        const hasSection = section !== undefined && section !== null;

        if (!hasName && !hasClass && !hasSection) {
            return error(res, 'At least one field (name, class, section) must be provided', 400);
        }

        // Fetch existing student
        const existing = await pool.query(
            `SELECT id, roll_no, class, section FROM students
             WHERE id = $1 AND school_id = $2`,
            [studentId, schoolId]
        );

        if (existing.rowCount === 0) {
            return error(res, 'Student not found', 404);
        }

        const currentStudent = existing.rows[0];

        // If class or section is being changed, re-check roll_no uniqueness
        if (hasClass || hasSection) {
            const newClass = hasClass ? String(studentClass).trim() : currentStudent.class;
            const newSection = hasSection ? String(section).trim() || null : currentStudent.section;

            const dupCheck = await pool.query(
                `SELECT id FROM students
                 WHERE school_id = $1 AND class = $2 AND roll_no = $3
                   AND (section IS NOT DISTINCT FROM $4) AND id != $5`,
                [schoolId, newClass, currentStudent.roll_no, newSection, studentId]
            );

            if (dupCheck.rowCount > 0) {
                return error(
                    res,
                    `Roll number '${currentStudent.roll_no}' already exists in class '${newClass}'${newSection ? ` section '${newSection}'` : ''}`,
                    409
                );
            }
        }

        // Build dynamic SET
        const setClauses = [];
        const params = [];
        let paramIndex = 1;

        if (hasName) {
            setClauses.push(`name = $${paramIndex++}`);
            params.push(String(name).trim());
        }
        if (hasClass) {
            setClauses.push(`class = $${paramIndex++}`);
            params.push(String(studentClass).trim());
        }
        if (hasSection) {
            setClauses.push(`section = $${paramIndex++}`);
            params.push(String(section).trim() || null);
        }

        setClauses.push(`updated_at = NOW()`);
        params.push(studentId);
        params.push(schoolId);

        const result = await pool.query(
            `UPDATE students
             SET ${setClauses.join(', ')}
             WHERE id = $${paramIndex} AND school_id = $${paramIndex + 1}
             RETURNING id, school_id, name, roll_no, class, section, is_active, created_at, updated_at`,
            params
        );

        return success(res, { student: result.rows[0] }, 'Student updated successfully');

    } catch (err) {
        console.error('updateStudent error:', err);
        return error(res, 'Failed to update student', 500, err.message);
    }
}

// =============================================================================
// deactivateStudent
// DELETE /api/students/:studentId/deactivate
//
// Sets is_active = FALSE on the student AND deactivates any current bus
// assignment (is_current = FALSE). Wrapped in a transaction.
// Returns 400 if already inactive, 404 if not found.
// =============================================================================
async function deactivateStudent(req, res) {
    const client = await pool.connect();

    try {
        const { studentId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(studentId)) {
            client.release();
            return error(res, 'Invalid student ID format', 400);
        }

        // Check existence
        const existing = await client.query(
            `SELECT id, is_active FROM students WHERE id = $1 AND school_id = $2`,
            [studentId, schoolId]
        );

        if (existing.rowCount === 0) {
            client.release();
            return error(res, 'Student not found', 404);
        }

        if (!existing.rows[0].is_active) {
            client.release();
            return error(res, 'Student is already inactive', 400);
        }

        // --- Transaction: deactivate student + remove current bus assignment ---
        await client.query('BEGIN');

        await client.query(
            `UPDATE students SET is_active = FALSE, updated_at = NOW()
             WHERE id = $1 AND school_id = $2`,
            [studentId, schoolId]
        );

        await client.query(
            `UPDATE student_bus_assignments
             SET is_current = FALSE, updated_at = NOW()
             WHERE student_id = $1 AND is_current = TRUE`,
            [studentId]
        );

        await client.query('COMMIT');
        client.release();

        return success(res, { studentId }, 'Student deactivated successfully');

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        console.error('deactivateStudent error:', err);
        return error(res, 'Failed to deactivate student', 500, err.message);
    }
}

// =============================================================================
// reactivateStudent
// PUT /api/students/:studentId/reactivate
//
// Sets is_active = TRUE on the student only.
// Does NOT auto-reassign to a bus (admin does that manually).
// Returns 400 if already active, 404 if not found.
// =============================================================================
async function reactivateStudent(req, res) {
    try {
        const { studentId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(studentId)) {
            return error(res, 'Invalid student ID format', 400);
        }

        const existing = await pool.query(
            `SELECT id, is_active FROM students WHERE id = $1 AND school_id = $2`,
            [studentId, schoolId]
        );

        if (existing.rowCount === 0) {
            return error(res, 'Student not found', 404);
        }

        if (existing.rows[0].is_active) {
            return error(res, 'Student is already active', 400);
        }

        const result = await pool.query(
            `UPDATE students SET is_active = TRUE, updated_at = NOW()
             WHERE id = $1 AND school_id = $2
             RETURNING id, school_id, name, roll_no, class, section, is_active, created_at, updated_at`,
            [studentId, schoolId]
        );

        return success(res, { student: result.rows[0] }, 'Student reactivated successfully');

    } catch (err) {
        console.error('reactivateStudent error:', err);
        return error(res, 'Failed to reactivate student', 500, err.message);
    }
}

// =============================================================================
// linkParent
// POST /api/students/:studentId/parents
//
// Links a parent to a student.
// Body: { parent_id }
// - Validates parent exists in same school with role = 'PARENT'
// - Validates student exists in same school
// - Checks link doesn't already exist — 409 if duplicate
// =============================================================================
async function linkParent(req, res) {
    try {
        const { studentId } = req.params;
        const schoolId = req.schoolId;
        const { parent_id } = req.body;

        // --- UUID validation ---
        if (!isValidUUID(studentId)) {
            return error(res, 'Invalid student ID format', 400);
        }
        if (!parent_id || !isValidUUID(parent_id)) {
            return error(res, 'Valid parent_id is required', 400);
        }

        // --- Validate student exists in this school ---
        const studentResult = await pool.query(
            `SELECT id, name FROM students WHERE id = $1 AND school_id = $2`,
            [studentId, schoolId]
        );

        if (studentResult.rowCount === 0) {
            return error(res, 'Student not found', 404);
        }

        // --- Validate parent exists in same school with role = PARENT ---
        const parentResult = await pool.query(
            `SELECT id, name FROM users WHERE id = $1 AND school_id = $2 AND role = 'PARENT'`,
            [parent_id, schoolId]
        );

        if (parentResult.rowCount === 0) {
            return error(res, 'Parent not found in this school', 404);
        }

        // --- Check if link already exists ---
        const existingLink = await pool.query(
            `SELECT parent_id FROM parent_students WHERE parent_id = $1 AND student_id = $2`,
            [parent_id, studentId]
        );

        if (existingLink.rowCount > 0) {
            return error(res, 'This parent is already linked to this student', 409);
        }

        // --- Insert link ---
        await pool.query(
            `INSERT INTO parent_students (parent_id, student_id, created_at)
             VALUES ($1, $2, NOW())`,
            [parent_id, studentId]
        );

        return success(res, {
            student_name: studentResult.rows[0].name,
            parent_name: parentResult.rows[0].name,
        }, 'Parent linked to student successfully', 201);

    } catch (err) {
        console.error('linkParent error:', err);
        return error(res, 'Failed to link parent to student', 500, err.message);
    }
}

// =============================================================================
// unlinkParent
// DELETE /api/students/:studentId/parents/:parentId
//
// Removes the link between a parent and a student.
// Returns 404 if the link does not exist.
// =============================================================================
async function unlinkParent(req, res) {
    try {
        const { studentId, parentId } = req.params;
        const schoolId = req.schoolId;

        // --- UUID validation ---
        if (!isValidUUID(studentId)) {
            return error(res, 'Invalid student ID format', 400);
        }
        if (!isValidUUID(parentId)) {
            return error(res, 'Invalid parent ID format', 400);
        }

        // --- Validate student belongs to this school ---
        const studentCheck = await pool.query(
            `SELECT id FROM students WHERE id = $1 AND school_id = $2`,
            [studentId, schoolId]
        );

        if (studentCheck.rowCount === 0) {
            return error(res, 'Student not found', 404);
        }

        // --- Check link exists ---
        const linkResult = await pool.query(
            `DELETE FROM parent_students WHERE parent_id = $1 AND student_id = $2`,
            [parentId, studentId]
        );

        if (linkResult.rowCount === 0) {
            return error(res, 'Parent–student link not found', 404);
        }

        return success(res, {}, 'Parent unlinked from student successfully');

    } catch (err) {
        console.error('unlinkParent error:', err);
        return error(res, 'Failed to unlink parent from student', 500, err.message);
    }
}

// =============================================================================
// bulkImport
// POST /api/students/import
//
// Bulk imports students from a JSON array.
// Body: { students: [ { name, roll_no, class, section? }, ... ] }
//
// - Max 500 rows per request
// - Validates each row: name, roll_no, class are required
//   → aborts entire import on first validation failure (400)
// - Runs in a single transaction:
//   → skips duplicates (same school_id + class + section + roll_no)
//   → inserts new rows
//   → never partially commits
// - Returns summary with imported/skipped counts and skipped details
// =============================================================================
async function bulkImport(req, res) {
    const client = await pool.connect();

    try {
        const schoolId = req.schoolId;
        const { students } = req.body;

        // --- Validate input is a non-empty array ---
        if (!Array.isArray(students) || students.length === 0) {
            client.release();
            return error(res, 'Request body must include a non-empty "students" array', 400);
        }

        if (students.length > BULK_IMPORT_MAX) {
            client.release();
            return error(res, `Maximum ${BULK_IMPORT_MAX} students per import request`, 400);
        }

        // --- Pre-validate all rows before starting transaction ---
        const trimmedStudents = [];

        for (let i = 0; i < students.length; i++) {
            const row = students[i];
            const rowNum = i + 1;

            if (!row.name || !String(row.name).trim()) {
                client.release();
                return error(res, `Row ${rowNum}: Student name is required`, 400);
            }
            if (!row.roll_no || !String(row.roll_no).trim()) {
                client.release();
                return error(res, `Row ${rowNum}: Roll number is required`, 400);
            }
            if (!row.class || !String(row.class).trim()) {
                client.release();
                return error(res, `Row ${rowNum}: Class is required`, 400);
            }

            trimmedStudents.push({
                rowNum,
                name: String(row.name).trim(),
                roll_no: String(row.roll_no).trim(),
                class: String(row.class).trim(),
                section: row.section ? String(row.section).trim() : null,
            });
        }

        // --- Process in a single transaction ---
        await client.query('BEGIN');

        let imported = 0;
        let skipped = 0;
        const skippedDetails = [];

        for (const student of trimmedStudents) {
            // Check if duplicate exists
            const dupCheck = await client.query(
                `SELECT id FROM students
                 WHERE school_id = $1 AND class = $2 AND roll_no = $3
                   AND (section IS NOT DISTINCT FROM $4)`,
                [schoolId, student.class, student.roll_no, student.section]
            );

            if (dupCheck.rowCount > 0) {
                skipped++;
                skippedDetails.push({
                    row: student.rowNum,
                    name: student.name,
                    roll_no: student.roll_no,
                    reason: 'Already exists',
                });
                continue;
            }

            // Insert new student
            await client.query(
                `INSERT INTO students (school_id, name, roll_no, class, section, is_active, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, TRUE, NOW(), NOW())`,
                [schoolId, student.name, student.roll_no, student.class, student.section]
            );

            imported++;
        }

        await client.query('COMMIT');
        client.release();

        return success(res, {
            total: trimmedStudents.length,
            imported,
            skipped,
            skipped_details: skippedDetails,
        }, 'Bulk import completed successfully', 201);

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        console.error('bulkImport error:', err);
        return error(res, 'Failed to import students', 500, err.message);
    }
}

// =============================================================================
// Exports
// =============================================================================
module.exports = {
    createStudent,
    listStudents,
    getStudent,
    updateStudent,
    deactivateStudent,
    reactivateStudent,
    linkParent,
    unlinkParent,
    bulkImport,
};
