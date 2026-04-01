// =============================================================================
// src/modules/users/users.controller.js
// Controller for Driver and Parent user management
//
// All endpoints are School Admin only, scoped to their own school.
// Super Admin bypasses school scope via enforceSchoolScope middleware.
//
// Drivers:  CRUD + deactivate/reactivate + reset password
// Parents:  CRUD + deactivate/reactivate + reset password (default gen)
// =============================================================================

const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const { success, error } = require('../../utils/response');
const { parsePagination, paginationMeta } = require('../../utils/pagination');

// Regex for UUID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(id) {
    return typeof id === 'string' && UUID_REGEX.test(id);
}

// =============================================================================
//                              DRIVER ENDPOINTS
// =============================================================================

// =============================================================================
// createDriver
// POST /api/users/drivers
//
// Creates a new driver account for the school.
// Body: { name, employee_id, password, phone?, email? }
// =============================================================================
async function createDriver(req, res) {
    try {
        const schoolId = req.schoolId;
        const { name, employee_id, password, phone, email } = req.body;

        // --- Validation ---
        if (!name || !String(name).trim()) {
            return error(res, 'Driver name is required', 400);
        }
        if (!employee_id || !String(employee_id).trim()) {
            return error(res, 'Employee ID is required', 400);
        }
        if (!password || !String(password).trim()) {
            return error(res, 'Password is required', 400);
        }

        const trimmedName = String(name).trim();
        const trimmedEmpId = String(employee_id).trim();
        const trimmedPassword = String(password).trim();
        const trimmedPhone = phone ? String(phone).trim() : null;
        const trimmedEmail = email ? String(email).trim().toLowerCase() : null;

        if (trimmedPassword.length < 8) {
            return error(res, 'Password must be at least 8 characters', 400);
        }

        // --- Check employee_id uniqueness within school ---
        const empDup = await pool.query(
            `SELECT id FROM users WHERE school_id = $1 AND employee_id = $2`,
            [schoolId, trimmedEmpId]
        );
        if (empDup.rowCount > 0) {
            return error(res, `Employee ID '${trimmedEmpId}' already exists in this school`, 409);
        }

        // --- Check email uniqueness within school if provided ---
        if (trimmedEmail) {
            const emailDup = await pool.query(
                `SELECT id FROM users WHERE school_id = $1 AND LOWER(email) = $2`,
                [schoolId, trimmedEmail]
            );
            if (emailDup.rowCount > 0) {
                return error(res, 'A user with this email already exists in this school', 409);
            }
        }

        // --- Hash password ---
        const passwordHash = await bcrypt.hash(trimmedPassword, 12);

        // --- Insert ---
        const result = await pool.query(
            `INSERT INTO users (school_id, role, name, employee_id, password_hash, phone, email, is_active, created_at, updated_at)
             VALUES ($1, 'DRIVER', $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
             RETURNING id, school_id, role, name, employee_id, phone, email, is_active, created_at`,
            [schoolId, trimmedName, trimmedEmpId, passwordHash, trimmedPhone, trimmedEmail]
        );

        return success(res, { driver: result.rows[0] }, 'Driver created successfully', 201);

    } catch (err) {
        console.error('createDriver error:', err);
        return error(res, 'Failed to create driver', 500, err.message);
    }
}

// =============================================================================
// listDrivers
// GET /api/users/drivers
//
// Returns a paginated list of drivers for the school.
// Query: ?page=1&limit=20&search=&status=active|inactive|all
// =============================================================================
async function listDrivers(req, res) {
    try {
        const schoolId = req.schoolId;
        const { limit, offset, page } = parsePagination(req.query);
        const search = req.query.search ? String(req.query.search).trim() : '';
        const status = req.query.status ? String(req.query.status).trim().toLowerCase() : 'all';

        const conditions = [`school_id = $1`, `role = 'DRIVER'`];
        const params = [schoolId];
        let paramIndex = 2;

        // Status filter
        if (status === 'active') {
            conditions.push(`is_active = TRUE`);
        } else if (status === 'inactive') {
            conditions.push(`is_active = FALSE`);
        }

        // Search filter (ILIKE on name and employee_id)
        if (search) {
            conditions.push(`(name ILIKE $${paramIndex} OR employee_id ILIKE $${paramIndex})`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        // Count
        const countResult = await pool.query(
            `SELECT COUNT(*) AS total FROM users ${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].total, 10);

        // Fetch
        const dataResult = await pool.query(
            `SELECT id, name, employee_id, phone, email, is_active, last_active_at, created_at
             FROM users ${whereClause}
             ORDER BY created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...params, limit, offset]
        );

        return success(res, {
            drivers: dataResult.rows,
            pagination: paginationMeta(total, limit, page),
        }, 'Drivers retrieved successfully');

    } catch (err) {
        console.error('listDrivers error:', err);
        return error(res, 'Failed to retrieve drivers', 500, err.message);
    }
}

// =============================================================================
// getDriver
// GET /api/users/drivers/:userId
//
// Fetches a single driver by ID, scoped to the school.
// =============================================================================
async function getDriver(req, res) {
    try {
        const { userId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(userId)) {
            return error(res, 'Invalid user ID format', 400);
        }

        const result = await pool.query(
            `SELECT id, name, employee_id, phone, email, is_active, last_active_at, created_at
             FROM users
             WHERE id = $1 AND school_id = $2 AND role = 'DRIVER'`,
            [userId, schoolId]
        );

        if (result.rowCount === 0) {
            return error(res, 'Driver not found', 404);
        }

        return success(res, { driver: result.rows[0] }, 'Driver retrieved successfully');

    } catch (err) {
        console.error('getDriver error:', err);
        return error(res, 'Failed to retrieve driver', 500, err.message);
    }
}

// =============================================================================
// updateDriver
// PATCH /api/users/drivers/:userId
//
// Updates driver details. employee_id is NOT updatable.
// Body: { name?, phone?, email? }
// =============================================================================
async function updateDriver(req, res) {
    try {
        const { userId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(userId)) {
            return error(res, 'Invalid user ID format', 400);
        }

        const { name, phone, email } = req.body;

        const hasName = name !== undefined && name !== null;
        const hasPhone = phone !== undefined && phone !== null;
        const hasEmail = email !== undefined && email !== null;

        if (!hasName && !hasPhone && !hasEmail) {
            return error(res, 'At least one field (name, phone, email) must be provided', 400);
        }

        // Check existence
        const existing = await pool.query(
            `SELECT id FROM users WHERE id = $1 AND school_id = $2 AND role = 'DRIVER'`,
            [userId, schoolId]
        );
        if (existing.rowCount === 0) {
            return error(res, 'Driver not found', 404);
        }

        // Check email uniqueness if being changed
        if (hasEmail) {
            const trimmedEmail = String(email).trim().toLowerCase();
            const emailDup = await pool.query(
                `SELECT id FROM users WHERE school_id = $1 AND LOWER(email) = $2 AND id != $3`,
                [schoolId, trimmedEmail, userId]
            );
            if (emailDup.rowCount > 0) {
                return error(res, 'A user with this email already exists in this school', 409);
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
        if (hasPhone) {
            setClauses.push(`phone = $${paramIndex++}`);
            params.push(String(phone).trim());
        }
        if (hasEmail) {
            setClauses.push(`email = $${paramIndex++}`);
            params.push(String(email).trim().toLowerCase());
        }

        setClauses.push(`updated_at = NOW()`);
        params.push(userId);
        params.push(schoolId);

        const result = await pool.query(
            `UPDATE users
             SET ${setClauses.join(', ')}
             WHERE id = $${paramIndex} AND school_id = $${paramIndex + 1} AND role = 'DRIVER'
             RETURNING id, name, employee_id, phone, email, is_active, created_at, updated_at`,
            params
        );

        return success(res, { driver: result.rows[0] }, 'Driver updated successfully');

    } catch (err) {
        console.error('updateDriver error:', err);
        return error(res, 'Failed to update driver', 500, err.message);
    }
}

// =============================================================================
// deactivateDriver
// DELETE /api/users/drivers/:userId/deactivate
//
// Sets is_active = FALSE for the driver.
// =============================================================================
async function deactivateDriver(req, res) {
    try {
        const { userId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(userId)) {
            return error(res, 'Invalid user ID format', 400);
        }

        const existing = await pool.query(
            `SELECT id, is_active FROM users WHERE id = $1 AND school_id = $2 AND role = 'DRIVER'`,
            [userId, schoolId]
        );

        if (existing.rowCount === 0) {
            return error(res, 'Driver not found', 404);
        }

        if (!existing.rows[0].is_active) {
            return error(res, 'Driver is already inactive', 400);
        }

        await pool.query(
            `UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
            [userId]
        );

        return success(res, { userId }, 'Driver deactivated successfully');

    } catch (err) {
        console.error('deactivateDriver error:', err);
        return error(res, 'Failed to deactivate driver', 500, err.message);
    }
}

// =============================================================================
// reactivateDriver
// PUT /api/users/drivers/:userId/reactivate
//
// Sets is_active = TRUE for the driver.
// =============================================================================
async function reactivateDriver(req, res) {
    try {
        const { userId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(userId)) {
            return error(res, 'Invalid user ID format', 400);
        }

        const existing = await pool.query(
            `SELECT id, is_active FROM users WHERE id = $1 AND school_id = $2 AND role = 'DRIVER'`,
            [userId, schoolId]
        );

        if (existing.rowCount === 0) {
            return error(res, 'Driver not found', 404);
        }

        if (existing.rows[0].is_active) {
            return error(res, 'Driver is already active', 400);
        }

        const result = await pool.query(
            `UPDATE users SET is_active = TRUE, updated_at = NOW()
             WHERE id = $1
             RETURNING id, name, employee_id, phone, email, is_active, created_at, updated_at`,
            [userId]
        );

        return success(res, { driver: result.rows[0] }, 'Driver reactivated successfully');

    } catch (err) {
        console.error('reactivateDriver error:', err);
        return error(res, 'Failed to reactivate driver', 500, err.message);
    }
}

// =============================================================================
// resetDriverPassword
// POST /api/users/drivers/:userId/reset-password
//
// School Admin sets a new password for a driver.
// Body: { new_password }
// =============================================================================
async function resetDriverPassword(req, res) {
    try {
        const { userId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(userId)) {
            return error(res, 'Invalid user ID format', 400);
        }

        const { new_password } = req.body;

        if (!new_password || !String(new_password).trim()) {
            return error(res, 'New password is required', 400);
        }

        const trimmedPassword = String(new_password).trim();

        if (trimmedPassword.length < 8) {
            return error(res, 'Password must be at least 8 characters', 400);
        }

        // Verify driver exists in this school
        const existing = await pool.query(
            `SELECT id FROM users WHERE id = $1 AND school_id = $2 AND role = 'DRIVER'`,
            [userId, schoolId]
        );

        if (existing.rowCount === 0) {
            return error(res, 'Driver not found', 404);
        }

        const passwordHash = await bcrypt.hash(trimmedPassword, 12);

        await pool.query(
            `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
            [passwordHash, userId]
        );

        return success(res, {}, 'Driver password reset successfully');

    } catch (err) {
        console.error('resetDriverPassword error:', err);
        return error(res, 'Failed to reset driver password', 500, err.message);
    }
}

// =============================================================================
//                              PARENT ENDPOINTS
// =============================================================================

// =============================================================================
// createParent
// POST /api/users/parents
//
// Creates a new parent account. Auto-generates a default password from
// the school code + last 4 digits of the phone number.
// Body: { name, phone, email? }
// =============================================================================
async function createParent(req, res) {
    try {
        const schoolId = req.schoolId;
        const { name, phone, email } = req.body;

        // --- Validation ---
        if (!name || !String(name).trim()) {
            return error(res, 'Parent name is required', 400);
        }
        if (!phone || !String(phone).trim()) {
            return error(res, 'Phone number is required', 400);
        }

        const trimmedName = String(name).trim();
        const trimmedPhone = String(phone).trim();
        const trimmedEmail = email ? String(email).trim().toLowerCase() : null;

        // --- Check phone uniqueness within school ---
        const phoneDup = await pool.query(
            `SELECT id FROM users WHERE school_id = $1 AND phone = $2`,
            [schoolId, trimmedPhone]
        );
        if (phoneDup.rowCount > 0) {
            return error(res, 'A user with this phone number already exists in this school', 409);
        }

        // --- Check email uniqueness within school if provided ---
        if (trimmedEmail) {
            const emailDup = await pool.query(
                `SELECT id FROM users WHERE school_id = $1 AND LOWER(email) = $2`,
                [schoolId, trimmedEmail]
            );
            if (emailDup.rowCount > 0) {
                return error(res, 'A user with this email already exists in this school', 409);
            }
        }

        // --- Fetch school code for default password generation ---
        const schoolResult = await pool.query(
            `SELECT code FROM schools WHERE id = $1`,
            [schoolId]
        );

        if (schoolResult.rowCount === 0) {
            return error(res, 'School not found', 404);
        }

        const schoolCode = schoolResult.rows[0].code;

        // --- Generate default password: schoolCode + last 4 digits of phone ---
        const phoneLast4 = trimmedPhone.slice(-4);
        const defaultPassword = `${schoolCode}${phoneLast4}`;
        const passwordHash = await bcrypt.hash(defaultPassword, 12);

        // --- Insert ---
        const result = await pool.query(
            `INSERT INTO users (school_id, role, name, phone, email, password_hash, is_active, created_at, updated_at)
             VALUES ($1, 'PARENT', $2, $3, $4, $5, TRUE, NOW(), NOW())
             RETURNING id, school_id, role, name, phone, email, is_active, created_at`,
            [schoolId, trimmedName, trimmedPhone, trimmedEmail, passwordHash]
        );

        return success(res, {
            parent: result.rows[0],
            default_password: defaultPassword,  // Admin shares this with the parent
        }, 'Parent created successfully', 201);

    } catch (err) {
        console.error('createParent error:', err);
        return error(res, 'Failed to create parent', 500, err.message);
    }
}

// =============================================================================
// listParents
// GET /api/users/parents
//
// Returns a paginated list of parents for the school.
// Query: ?page=1&limit=20&search=&status=active|inactive|all
// =============================================================================
async function listParents(req, res) {
    try {
        const schoolId = req.schoolId;
        const { limit, offset, page } = parsePagination(req.query);
        const search = req.query.search ? String(req.query.search).trim() : '';
        const status = req.query.status ? String(req.query.status).trim().toLowerCase() : 'all';

        const conditions = [`school_id = $1`, `role = 'PARENT'`];
        const params = [schoolId];
        let paramIndex = 2;

        // Status filter
        if (status === 'active') {
            conditions.push(`is_active = TRUE`);
        } else if (status === 'inactive') {
            conditions.push(`is_active = FALSE`);
        }

        // Search filter (ILIKE on name and phone)
        if (search) {
            conditions.push(`(name ILIKE $${paramIndex} OR phone ILIKE $${paramIndex})`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        // Count
        const countResult = await pool.query(
            `SELECT COUNT(*) AS total FROM users ${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].total, 10);

        // Fetch
        const dataResult = await pool.query(
            `SELECT id, name, phone, email, is_active, last_active_at, created_at
             FROM users ${whereClause}
             ORDER BY created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...params, limit, offset]
        );

        return success(res, {
            parents: dataResult.rows,
            pagination: paginationMeta(total, limit, page),
        }, 'Parents retrieved successfully');

    } catch (err) {
        console.error('listParents error:', err);
        return error(res, 'Failed to retrieve parents', 500, err.message);
    }
}

// =============================================================================
// getParent
// GET /api/users/parents/:userId
//
// Fetches a single parent by ID, scoped to the school.
// Also fetches linked children from parent_students JOIN students.
// =============================================================================
async function getParent(req, res) {
    try {
        const { userId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(userId)) {
            return error(res, 'Invalid user ID format', 400);
        }

        // Fetch parent
        const parentResult = await pool.query(
            `SELECT id, name, phone, email, is_active, last_active_at, created_at
             FROM users
             WHERE id = $1 AND school_id = $2 AND role = 'PARENT'`,
            [userId, schoolId]
        );

        if (parentResult.rowCount === 0) {
            return error(res, 'Parent not found', 404);
        }

        // Fetch linked children
        const childrenResult = await pool.query(
            `SELECT s.id, s.name, s.class, s.section, s.roll_no
             FROM parent_students ps
             JOIN students s ON s.id = ps.student_id
             WHERE ps.parent_id = $1`,
            [userId]
        );

        return success(res, {
            parent: {
                ...parentResult.rows[0],
                children: childrenResult.rows,
            },
        }, 'Parent retrieved successfully');

    } catch (err) {
        console.error('getParent error:', err);
        return error(res, 'Failed to retrieve parent', 500, err.message);
    }
}

// =============================================================================
// updateParent
// PATCH /api/users/parents/:userId
//
// Updates parent details.
// Body: { name?, phone?, email? }
// =============================================================================
async function updateParent(req, res) {
    try {
        const { userId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(userId)) {
            return error(res, 'Invalid user ID format', 400);
        }

        const { name, phone, email } = req.body;

        const hasName = name !== undefined && name !== null;
        const hasPhone = phone !== undefined && phone !== null;
        const hasEmail = email !== undefined && email !== null;

        if (!hasName && !hasPhone && !hasEmail) {
            return error(res, 'At least one field (name, phone, email) must be provided', 400);
        }

        // Check existence
        const existing = await pool.query(
            `SELECT id FROM users WHERE id = $1 AND school_id = $2 AND role = 'PARENT'`,
            [userId, schoolId]
        );
        if (existing.rowCount === 0) {
            return error(res, 'Parent not found', 404);
        }

        // Check phone uniqueness if being changed
        if (hasPhone) {
            const trimmedPhone = String(phone).trim();
            const phoneDup = await pool.query(
                `SELECT id FROM users WHERE school_id = $1 AND phone = $2 AND id != $3`,
                [schoolId, trimmedPhone, userId]
            );
            if (phoneDup.rowCount > 0) {
                return error(res, 'A user with this phone number already exists in this school', 409);
            }
        }

        // Check email uniqueness if being changed
        if (hasEmail) {
            const trimmedEmail = String(email).trim().toLowerCase();
            const emailDup = await pool.query(
                `SELECT id FROM users WHERE school_id = $1 AND LOWER(email) = $2 AND id != $3`,
                [schoolId, trimmedEmail, userId]
            );
            if (emailDup.rowCount > 0) {
                return error(res, 'A user with this email already exists in this school', 409);
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
        if (hasPhone) {
            setClauses.push(`phone = $${paramIndex++}`);
            params.push(String(phone).trim());
        }
        if (hasEmail) {
            setClauses.push(`email = $${paramIndex++}`);
            params.push(String(email).trim().toLowerCase());
        }

        setClauses.push(`updated_at = NOW()`);
        params.push(userId);
        params.push(schoolId);

        const result = await pool.query(
            `UPDATE users
             SET ${setClauses.join(', ')}
             WHERE id = $${paramIndex} AND school_id = $${paramIndex + 1} AND role = 'PARENT'
             RETURNING id, name, phone, email, is_active, created_at, updated_at`,
            params
        );

        return success(res, { parent: result.rows[0] }, 'Parent updated successfully');

    } catch (err) {
        console.error('updateParent error:', err);
        return error(res, 'Failed to update parent', 500, err.message);
    }
}

// =============================================================================
// deactivateParent
// DELETE /api/users/parents/:userId/deactivate
//
// Sets is_active = FALSE for the parent.
// =============================================================================
async function deactivateParent(req, res) {
    try {
        const { userId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(userId)) {
            return error(res, 'Invalid user ID format', 400);
        }

        const existing = await pool.query(
            `SELECT id, is_active FROM users WHERE id = $1 AND school_id = $2 AND role = 'PARENT'`,
            [userId, schoolId]
        );

        if (existing.rowCount === 0) {
            return error(res, 'Parent not found', 404);
        }

        if (!existing.rows[0].is_active) {
            return error(res, 'Parent is already inactive', 400);
        }

        await pool.query(
            `UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
            [userId]
        );

        return success(res, { userId }, 'Parent deactivated successfully');

    } catch (err) {
        console.error('deactivateParent error:', err);
        return error(res, 'Failed to deactivate parent', 500, err.message);
    }
}

// =============================================================================
// reactivateParent
// PUT /api/users/parents/:userId/reactivate
//
// Sets is_active = TRUE for the parent.
// =============================================================================
async function reactivateParent(req, res) {
    try {
        const { userId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(userId)) {
            return error(res, 'Invalid user ID format', 400);
        }

        const existing = await pool.query(
            `SELECT id, is_active FROM users WHERE id = $1 AND school_id = $2 AND role = 'PARENT'`,
            [userId, schoolId]
        );

        if (existing.rowCount === 0) {
            return error(res, 'Parent not found', 404);
        }

        if (existing.rows[0].is_active) {
            return error(res, 'Parent is already active', 400);
        }

        const result = await pool.query(
            `UPDATE users SET is_active = TRUE, updated_at = NOW()
             WHERE id = $1
             RETURNING id, name, phone, email, is_active, created_at, updated_at`,
            [userId]
        );

        return success(res, { parent: result.rows[0] }, 'Parent reactivated successfully');

    } catch (err) {
        console.error('reactivateParent error:', err);
        return error(res, 'Failed to reactivate parent', 500, err.message);
    }
}

// =============================================================================
// resetParentPassword
// POST /api/users/parents/:userId/reset-password
//
// Resets parent password back to the default:
//   schoolCode + last 4 digits of phone
// Returns the plaintext default password so admin can share it.
// =============================================================================
async function resetParentPassword(req, res) {
    try {
        const { userId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(userId)) {
            return error(res, 'Invalid user ID format', 400);
        }

        // Fetch parent's phone
        const parentResult = await pool.query(
            `SELECT id, phone FROM users WHERE id = $1 AND school_id = $2 AND role = 'PARENT'`,
            [userId, schoolId]
        );

        if (parentResult.rowCount === 0) {
            return error(res, 'Parent not found', 404);
        }

        const parent = parentResult.rows[0];

        if (!parent.phone) {
            return error(res, 'Parent has no phone number on record — cannot generate default password', 400);
        }

        // Fetch school code
        const schoolResult = await pool.query(
            `SELECT code FROM schools WHERE id = $1`,
            [schoolId]
        );

        if (schoolResult.rowCount === 0) {
            return error(res, 'School not found', 404);
        }

        const schoolCode = schoolResult.rows[0].code;

        // Generate default password: schoolCode + last 4 digits of phone
        const phoneLast4 = parent.phone.slice(-4);
        const defaultPassword = `${schoolCode}${phoneLast4}`;
        const passwordHash = await bcrypt.hash(defaultPassword, 12);

        await pool.query(
            `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
            [passwordHash, userId]
        );

        return success(res, {
            default_password: defaultPassword,  // Admin shares this with the parent
        }, 'Parent password reset to default successfully');

    } catch (err) {
        console.error('resetParentPassword error:', err);
        return error(res, 'Failed to reset parent password', 500, err.message);
    }
}

module.exports = {
    // Drivers
    createDriver,
    listDrivers,
    getDriver,
    updateDriver,
    deactivateDriver,
    reactivateDriver,
    resetDriverPassword,
    // Parents
    createParent,
    listParents,
    getParent,
    updateParent,
    deactivateParent,
    reactivateParent,
    resetParentPassword,
};
