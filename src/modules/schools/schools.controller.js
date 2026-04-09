// =============================================================================
// src/modules/schools/schools.controller.js
// Controller for school CRUD operations and School Admin provisioning
//
// All endpoints are Super Admin only.
// =============================================================================

const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const { success, error } = require('../../utils/response');
const { parsePagination, paginationMeta } = require('../../utils/pagination');
const logger = require('../../config/logger');

// Regex for UUID v4 validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * isValidUUID
 * Returns true if the given string is a valid UUID.
 */
function isValidUUID(id) {
    return typeof id === 'string' && UUID_REGEX.test(id);
}

// =============================================================================
// createSchool
// POST /api/schools
//
// Creates a new school record.
// Body: { name, code, address, city, state }
// - name and code are required
// - code is stored uppercase, must be unique (case-insensitive)
// =============================================================================
async function createSchool(req, res) {
    try {
        const { name, code, address, city, state } = req.body;

        // --- Validation ---
        if (!name || !String(name).trim()) {
            return error(res, 'School name is required', 400);
        }
        if (!code || !String(code).trim()) {
            return error(res, 'School code is required', 400);
        }

        const trimmedName = String(name).trim();
        const trimmedCode = String(code).trim().toUpperCase();
        const trimmedAddress = address ? String(address).trim() : null;
        const trimmedCity = city ? String(city).trim() : null;
        const trimmedState = state ? String(state).trim() : null;

        // --- Check for duplicate code (case-insensitive) ---
        const duplicate = await pool.query(
            `SELECT id FROM schools WHERE UPPER(code) = $1`,
            [trimmedCode]
        );

        if (duplicate.rowCount > 0) {
            return error(res, `School code '${trimmedCode}' already exists`, 409);
        }

        // --- Insert ---
        const result = await pool.query(
            `INSERT INTO schools (name, code, address, city, state, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
             RETURNING id, name, code, address, city, state, is_active, created_at, updated_at`,
            [trimmedName, trimmedCode, trimmedAddress, trimmedCity, trimmedState]
        );

        return success(res, { school: result.rows[0] }, 'School created successfully', 201);

    } catch (err) {
        logger.error('createSchool error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to create school', 500, err.message);
    }
}

// =============================================================================
// listSchools
// GET /api/schools
//
// Returns a paginated list of schools.
// Query params: ?page=1&limit=20&search=&status=active|inactive|all
// =============================================================================
async function listSchools(req, res) {
    try {
        const { limit, offset, page } = parsePagination(req.query);
        const search = req.query.search ? String(req.query.search).trim() : '';
        const status = req.query.status ? String(req.query.status).trim().toLowerCase() : 'all';

        // --- Build dynamic WHERE clause ---
        const conditions = [];
        const params = [];
        let paramIndex = 1;

        // Status filter
        if (status === 'active') {
            conditions.push(`is_active = TRUE`);
        } else if (status === 'inactive') {
            conditions.push(`is_active = FALSE`);
        }
        // 'all' — no status filter

        // Search filter (ILIKE on name and code)
        if (search) {
            conditions.push(`(name ILIKE $${paramIndex} OR code ILIKE $${paramIndex})`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        const whereClause = conditions.length > 0
            ? `WHERE ${conditions.join(' AND ')}`
            : '';

        // --- Count total matching rows ---
        const countResult = await pool.query(
            `SELECT COUNT(*) AS total FROM schools ${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].total, 10);

        // --- Fetch paginated rows ---
        const dataResult = await pool.query(
            `SELECT id, name, code, city, state, is_active, created_at
             FROM schools ${whereClause}
             ORDER BY created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...params, limit, offset]
        );

        return success(res, {
            schools: dataResult.rows,
            pagination: paginationMeta(total, limit, page),
        }, 'Schools retrieved successfully');

    } catch (err) {
        logger.error('listSchools error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to retrieve schools', 500, err.message);
    }
}

// =============================================================================
// getSchool
// GET /api/schools/:schoolId
//
// Fetches a single school by ID along with aggregate counts:
// total active drivers, total active parents, total students, total buses.
// =============================================================================
async function getSchool(req, res) {
    try {
        const { schoolId } = req.params;

        if (!isValidUUID(schoolId)) {
            return error(res, 'Invalid school ID format', 400);
        }

        // --- Fetch the school ---
        const schoolResult = await pool.query(
            `SELECT id, name, code, address, city, state, is_active, created_at, updated_at
             FROM schools WHERE id = $1`,
            [schoolId]
        );

        if (schoolResult.rowCount === 0) {
            return error(res, 'School not found', 404);
        }

        const school = schoolResult.rows[0];

        // --- Aggregate counts for this school ---
        const countsResult = await pool.query(
            `SELECT
                 COALESCE(SUM(CASE WHEN role = 'DRIVER'  AND is_active = TRUE THEN 1 ELSE 0 END), 0) AS total_drivers,
                 COALESCE(SUM(CASE WHEN role = 'PARENT'  AND is_active = TRUE THEN 1 ELSE 0 END), 0) AS total_parents
             FROM users
             WHERE school_id = $1`,
            [schoolId]
        );

        const studentsResult = await pool.query(
            `SELECT COUNT(*) AS total_students FROM students WHERE school_id = $1`,
            [schoolId]
        );

        const busesResult = await pool.query(
            `SELECT COUNT(*) AS total_buses FROM buses WHERE school_id = $1`,
            [schoolId]
        );

        const counts = countsResult.rows[0];

        return success(res, {
            school: {
                ...school,
                stats: {
                    totalDrivers: parseInt(counts.total_drivers, 10),
                    totalParents: parseInt(counts.total_parents, 10),
                    totalStudents: parseInt(studentsResult.rows[0].total_students, 10),
                    totalBuses: parseInt(busesResult.rows[0].total_buses, 10),
                },
            },
        }, 'School retrieved successfully');

    } catch (err) {
        logger.error('getSchool error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to retrieve school', 500, err.message);
    }
}

// =============================================================================
// updateSchool
// PATCH /api/schools/:schoolId
//
// Updates one or more school fields. Code is NOT updatable after creation.
// Body: { name, address, city, state }
// =============================================================================
async function updateSchool(req, res) {
    try {
        const { schoolId } = req.params;

        if (!isValidUUID(schoolId)) {
            return error(res, 'Invalid school ID format', 400);
        }

        const { name, address, city, state } = req.body;

        // --- Validate that at least one field is provided ---
        const hasName = name !== undefined && name !== null;
        const hasAddress = address !== undefined && address !== null;
        const hasCity = city !== undefined && city !== null;
        const hasState = state !== undefined && state !== null;

        if (!hasName && !hasAddress && !hasCity && !hasState) {
            return error(res, 'At least one field (name, address, city, state) must be provided', 400);
        }

        // --- Check existence ---
        const existing = await pool.query(
            `SELECT id FROM schools WHERE id = $1`,
            [schoolId]
        );

        if (existing.rowCount === 0) {
            return error(res, 'School not found', 404);
        }

        // --- Build dynamic SET clause ---
        const setClauses = [];
        const params = [];
        let paramIndex = 1;

        if (hasName) {
            setClauses.push(`name = $${paramIndex++}`);
            params.push(String(name).trim());
        }
        if (hasAddress) {
            setClauses.push(`address = $${paramIndex++}`);
            params.push(String(address).trim());
        }
        if (hasCity) {
            setClauses.push(`city = $${paramIndex++}`);
            params.push(String(city).trim());
        }
        if (hasState) {
            setClauses.push(`state = $${paramIndex++}`);
            params.push(String(state).trim());
        }

        // Always update the timestamp
        setClauses.push(`updated_at = NOW()`);

        params.push(schoolId);

        const result = await pool.query(
            `UPDATE schools
             SET ${setClauses.join(', ')}
             WHERE id = $${paramIndex}
             RETURNING id, name, code, address, city, state, is_active, created_at, updated_at`,
            params
        );

        return success(res, { school: result.rows[0] }, 'School updated successfully');

    } catch (err) {
        logger.error('updateSchool error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to update school', 500, err.message);
    }
}

// =============================================================================
// deactivateSchool
// DELETE /api/schools/:schoolId/deactivate
//
// Deactivates a school AND all its associated users in a single transaction.
// Returns 404 if school not found, 400 if already inactive.
// =============================================================================
async function deactivateSchool(req, res) {
    const client = await pool.connect();

    try {
        const { schoolId } = req.params;

        if (!isValidUUID(schoolId)) {
            client.release();
            return error(res, 'Invalid school ID format', 400);
        }

        await client.query('BEGIN');

        // --- Check school exists and current status ---
        const schoolResult = await client.query(
            `SELECT id, is_active FROM schools WHERE id = $1 FOR UPDATE`,
            [schoolId]
        );

        if (schoolResult.rowCount === 0) {
            await client.query('ROLLBACK');
            client.release();
            return error(res, 'School not found', 404);
        }

        if (!schoolResult.rows[0].is_active) {
            await client.query('ROLLBACK');
            client.release();
            return error(res, 'School is already inactive', 400);
        }

        // --- Deactivate the school ---
        await client.query(
            `UPDATE schools SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
            [schoolId]
        );

        // --- Deactivate ALL users belonging to this school ---
        await client.query(
            `UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE school_id = $1`,
            [schoolId]
        );

        await client.query('COMMIT');
        client.release();

        return success(res, { schoolId }, 'School and all associated users deactivated successfully');

    } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        logger.error('deactivateSchool error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to deactivate school', 500, err.message);
    }
}

// =============================================================================
// reactivateSchool
// PUT /api/schools/:schoolId/reactivate
//
// Reactivates a school. Does NOT automatically reactivate its users —
// the School Admin must manually reactivate individual users.
// Returns 404 if school not found, 400 if already active.
// =============================================================================
async function reactivateSchool(req, res) {
    try {
        const { schoolId } = req.params;

        if (!isValidUUID(schoolId)) {
            return error(res, 'Invalid school ID format', 400);
        }

        // --- Check school exists and current status ---
        const schoolResult = await pool.query(
            `SELECT id, is_active FROM schools WHERE id = $1`,
            [schoolId]
        );

        if (schoolResult.rowCount === 0) {
            return error(res, 'School not found', 404);
        }

        if (schoolResult.rows[0].is_active) {
            return error(res, 'School is already active', 400);
        }

        // --- Reactivate school only ---
        const result = await pool.query(
            `UPDATE schools SET is_active = TRUE, updated_at = NOW()
             WHERE id = $1
             RETURNING id, name, code, address, city, state, is_active, created_at, updated_at`,
            [schoolId]
        );

        return success(res, { school: result.rows[0] }, 'School reactivated successfully');

    } catch (err) {
        logger.error('reactivateSchool error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to reactivate school', 500, err.message);
    }
}

// =============================================================================
// createSchoolAdmin
// POST /api/schools/:schoolId/admin
//
// Provisions a SCHOOL_ADMIN user for the given school.
// Enforces one admin per school rule.
// Body: { name, email, password }
// =============================================================================
async function createSchoolAdmin(req, res) {
    try {
        const { schoolId } = req.params;

        if (!isValidUUID(schoolId)) {
            return error(res, 'Invalid school ID format', 400);
        }

        const { name, email, password } = req.body;

        // --- Validate required fields ---
        if (!name || !String(name).trim()) {
            return error(res, 'Name is required', 400);
        }
        if (!email || !String(email).trim()) {
            return error(res, 'Email is required', 400);
        }
        if (!password || !String(password).trim()) {
            return error(res, 'Password is required', 400);
        }

        const trimmedName = String(name).trim();
        const trimmedEmail = String(email).trim().toLowerCase();
        const trimmedPassword = String(password).trim();

        if (trimmedPassword.length < 8) {
            return error(res, 'Password must be at least 8 characters', 400);
        }

        // --- Check school exists and is active ---
        const schoolResult = await pool.query(
            `SELECT id, is_active FROM schools WHERE id = $1`,
            [schoolId]
        );

        if (schoolResult.rowCount === 0) {
            return error(res, 'School not found', 404);
        }

        if (!schoolResult.rows[0].is_active) {
            return error(res, 'Cannot create admin for an inactive school', 400);
        }

        // --- One admin per school rule ---
        const existingAdmin = await pool.query(
            `SELECT id FROM users WHERE school_id = $1 AND role = 'SCHOOL_ADMIN'`,
            [schoolId]
        );

        if (existingAdmin.rowCount > 0) {
            return error(res, 'A School Admin already exists for this school', 409);
        }

        // --- Check for duplicate email within this school ---
        const duplicateEmail = await pool.query(
            `SELECT id FROM users WHERE school_id = $1 AND LOWER(email) = $2`,
            [schoolId, trimmedEmail]
        );

        if (duplicateEmail.rowCount > 0) {
            return error(res, 'A user with this email already exists in this school', 409);
        }

        // --- Hash password ---
        const passwordHash = await bcrypt.hash(trimmedPassword, 12);

        // --- Insert the School Admin ---
        const result = await pool.query(
            `INSERT INTO users (school_id, role, name, email, password_hash, is_active, created_at, updated_at)
             VALUES ($1, 'SCHOOL_ADMIN', $2, $3, $4, TRUE, NOW(), NOW())
             RETURNING id, school_id, role, name, email, is_active, created_at`,
            [schoolId, trimmedName, trimmedEmail, passwordHash]
        );

        return success(res, { admin: result.rows[0] }, 'School Admin created successfully', 201);

    } catch (err) {
        logger.error('createSchoolAdmin error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to create School Admin', 500, err.message);
    }
}

module.exports = {
    createSchool,
    listSchools,
    getSchool,
    updateSchool,
    deactivateSchool,
    reactivateSchool,
    createSchoolAdmin,
};
