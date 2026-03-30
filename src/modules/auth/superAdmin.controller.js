// =============================================================================
// src/modules/auth/superAdmin.controller.js
// Super Admin authentication
//
// Endpoints:
//   POST /auth/super-admin/login
//   POST /auth/super-admin/forgot-password
//   POST /auth/super-admin/reset-password
// =============================================================================

const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const { signToken } = require('../../utils/jwt');
const { success, error } = require('../../utils/response');
const { issueOTP, consumeOTP } = require('../otp/otpStore');
const { sendEmailOTP } = require('../../utils/otp');

// -----------------------------------------------------------------------------
// POST /auth/super-admin/login
// Email + Password
// -----------------------------------------------------------------------------
async function login(req, res) {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return error(res, 'Email and password are required', 400);
        }

        const result = await pool.query(`
      SELECT id, name, email, password_hash, role, is_active
      FROM users
      WHERE email = $1 AND role = 'SUPER_ADMIN'
    `, [email.toLowerCase().trim()]);

        if (result.rowCount === 0) {
            // Generic message — don't reveal whether email exists
            return error(res, 'Invalid email or password', 401);
        }

        const user = result.rows[0];

        if (!user.is_active) {
            return error(res, 'Account is deactivated. Contact support.', 403);
        }

        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            return error(res, 'Invalid email or password', 401);
        }

        // Update last_active_at
        await pool.query(`
      UPDATE users SET last_active_at = NOW() WHERE id = $1
    `, [user.id]);

        const token = signToken({
            userId: user.id,
            role: user.role,
            school_id: null,   // Super Admin has no school scope
            name: user.name,
        });

        return success(res, {
            token,
            user: {
                id: user.id,
                name: user.name,
                role: user.role,
            },
        }, 'Login successful');

    } catch (err) {
        console.error('SuperAdmin login error:', err);
        return error(res, 'Login failed', 500, err.message);
    }
}

// -----------------------------------------------------------------------------
// POST /auth/super-admin/forgot-password
// Sends email OTP for password reset
// Body: { email }
// -----------------------------------------------------------------------------
async function forgotPassword(req, res) {
    try {
        const { email } = req.body;

        if (!email) {
            return error(res, 'Email is required', 400);
        }

        const result = await pool.query(`
      SELECT id, name, email FROM users
      WHERE email = $1 AND role = 'SUPER_ADMIN' AND is_active = TRUE
    `, [email.toLowerCase().trim()]);

        // Always return success — don't reveal whether the email exists
        if (result.rowCount === 0) {
            return success(res, {}, 'If this email exists, a reset code has been sent.');
        }

        const user = result.rows[0];
        const otp = await issueOTP(user.id, 'FORGOT_PASSWORD');
        await sendEmailOTP(user.email, otp, user.name);

        return success(res, {}, 'Password reset code sent to your email.');

    } catch (err) {
        console.error('SuperAdmin forgotPassword error:', err);
        return error(res, 'Failed to send reset code', 500, err.message);
    }
}

// -----------------------------------------------------------------------------
// POST /auth/super-admin/reset-password
// Body: { email, otp, new_password }
// -----------------------------------------------------------------------------
async function resetPassword(req, res) {
    try {
        const { email, otp, new_password } = req.body;

        if (!email || !otp || !new_password) {
            return error(res, 'Email, OTP, and new password are required', 400);
        }

        if (new_password.length < 8) {
            return error(res, 'Password must be at least 8 characters', 400);
        }

        const result = await pool.query(`
      SELECT id FROM users
      WHERE email = $1 AND role = 'SUPER_ADMIN' AND is_active = TRUE
    `, [email.toLowerCase().trim()]);

        if (result.rowCount === 0) {
            return error(res, 'Invalid request', 400);
        }

        const user = result.rows[0];
        const verified = await consumeOTP(user.id, 'FORGOT_PASSWORD', otp);

        if (!verified.valid) {
            return error(res, `Invalid or expired OTP: ${verified.reason}`, 400);
        }

        const hash = await bcrypt.hash(new_password, 12);

        await pool.query(`
      UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2
    `, [hash, user.id]);

        return success(res, {}, 'Password reset successfully. Please log in.');

    } catch (err) {
        console.error('SuperAdmin resetPassword error:', err);
        return error(res, 'Password reset failed', 500, err.message);
    }
}

module.exports = { login, forgotPassword, resetPassword };
