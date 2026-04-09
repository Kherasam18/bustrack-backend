// =============================================================================
// src/modules/auth/driver.controller.js
// Driver authentication
// Login: Employee ID + Password (set by School Admin)
// Forgot password: Reset by School Admin only (no self-service)
//
// Endpoints:
//   POST /auth/driver/login
//   POST /auth/driver/change-password   (authenticated — driver changes own password)
// =============================================================================

const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const { signToken } = require('../../utils/jwt');
const { success, error } = require('../../utils/response');
const logger = require('../../config/logger');

// -----------------------------------------------------------------------------
// POST /auth/driver/login
// Body: { employee_id, password, school_id }
// school_id is required — employee_id is only unique within a school
// -----------------------------------------------------------------------------
async function login(req, res) {
    try {
        const { employee_id, password, school_id } = req.body;

        if (!employee_id || !password || !school_id) {
            return error(res, 'Employee ID, password, and school ID are required', 400);
        }

        const result = await pool.query(`
      SELECT u.id, u.name, u.employee_id, u.password_hash, u.role,
             u.school_id, u.is_active, s.is_active AS school_active
      FROM users u
      JOIN schools s ON s.id = u.school_id
      WHERE u.employee_id = $1
        AND u.school_id   = $2
        AND u.role        = 'DRIVER'
    `, [employee_id.trim(), school_id]);

        if (result.rowCount === 0) {
            return error(res, 'Invalid employee ID or password', 401);
        }

        const user = result.rows[0];

        if (!user.is_active) {
            return error(res, 'Your account has been deactivated. Contact your school administrator.', 403);
        }

        if (!user.school_active) {
            return error(res, 'School account is inactive. Contact the platform administrator.', 403);
        }

        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            return error(res, 'Invalid employee ID or password', 401);
        }

        // Update last_active_at and register device if fcm_token provided
        await pool.query(`
      UPDATE users SET last_active_at = NOW() WHERE id = $1
    `, [user.id]);

        const token = signToken({
            userId: user.id,
            role: user.role,
            school_id: user.school_id,
            name: user.name,
        });

        return success(res, {
            token,
            user: {
                id: user.id,
                name: user.name,
                role: user.role,
                school_id: user.school_id,
                employee_id: user.employee_id,
            },
        }, 'Login successful');

    } catch (err) {
        logger.error('Driver login error', { error: err.message, stack: err.stack });
        return error(res, 'Login failed', 500, err.message);
    }
}

// -----------------------------------------------------------------------------
// POST /auth/driver/change-password
// Authenticated endpoint — driver changes their own password
// Body: { current_password, new_password }
// -----------------------------------------------------------------------------
async function changePassword(req, res) {
    try {
        const { current_password, new_password } = req.body;
        const userId = req.user.userId;

        if (!current_password || !new_password) {
            return error(res, 'Current password and new password are required', 400);
        }

        if (new_password.length < 8) {
            return error(res, 'New password must be at least 8 characters', 400);
        }

        if (current_password === new_password) {
            return error(res, 'New password must be different from current password', 400);
        }

        const result = await pool.query(`
      SELECT password_hash FROM users WHERE id = $1
    `, [userId]);

        const match = await bcrypt.compare(current_password, result.rows[0].password_hash);
        if (!match) {
            return error(res, 'Current password is incorrect', 400);
        }

        const hash = await bcrypt.hash(new_password, 12);
        await pool.query(`
      UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2
    `, [hash, userId]);

        return success(res, {}, 'Password changed successfully');

    } catch (err) {
        logger.error('Driver changePassword error', { error: err.message, stack: err.stack });
        return error(res, 'Password change failed', 500, err.message);
    }
}

module.exports = { login, changePassword };
