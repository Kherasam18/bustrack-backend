// =============================================================================
// src/modules/auth/schoolAdmin.controller.js
// School Admin authentication with Email OTP 2FA
//
// Two-step login flow:
//   Step 1 — POST /auth/school-admin/login
//            Validates email + password
//            Issues a short-lived 2FA intermediate token
//            Sends OTP to registered email
//
//   Step 2 — POST /auth/school-admin/verify-otp
//            Validates OTP against the 2FA intermediate token
//            Issues full JWT on success
//
// Endpoints:
//   POST /auth/school-admin/login
//   POST /auth/school-admin/verify-otp
//   POST /auth/school-admin/forgot-password
//   POST /auth/school-admin/reset-password
// =============================================================================

const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const { signToken, sign2FAToken } = require('../../utils/jwt');
const { success, error } = require('../../utils/response');
const { issueOTP, consumeOTP } = require('../otp/otpStore');
const { sendEmailOTP } = require('../../utils/otp');
const logger = require('../../config/logger');

// -----------------------------------------------------------------------------
// POST /auth/school-admin/login  — Step 1
// Validates credentials, sends OTP, returns 2FA intermediate token
// Body: { email, password }
// -----------------------------------------------------------------------------
async function login(req, res) {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return error(res, 'Email and password are required', 400);
        }

        const result = await pool.query(`
      SELECT u.id, u.name, u.email, u.password_hash, u.role,
             u.school_id, u.is_active, s.is_active AS school_active
      FROM users u
      JOIN schools s ON s.id = u.school_id
      WHERE u.email = $1 AND u.role = 'SCHOOL_ADMIN'
    `, [email.toLowerCase().trim()]);

        if (result.rowCount === 0) {
            return error(res, 'Invalid email or password', 401);
        }

        const user = result.rows[0];

        if (!user.is_active) {
            return error(res, 'Your account has been deactivated.', 403);
        }

        if (!user.school_active) {
            return error(res, 'Your school account has been deactivated. Contact the platform administrator.', 403);
        }

        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            return error(res, 'Invalid email or password', 401);
        }

        // Issue and send OTP
        const otp = await issueOTP(user.id, '2FA_LOGIN');
        await sendEmailOTP(user.email, otp, user.name);

        // 2FA intermediate token — only valid for /verify-otp endpoint
        const twoFAToken = sign2FAToken({
            userId: user.id,
            role: user.role,
            school_id: user.school_id,
            name: user.name,
        });

        return success(res, {
            twoFAToken,
            message: 'Verification code sent to your email.',
        }, 'Password verified. Please enter your OTP.');

    } catch (err) {
        logger.error('SchoolAdmin login error', { error: err.message, stack: err.stack });
        return error(res, 'Login failed', 500, err.message);
    }
}

// -----------------------------------------------------------------------------
// POST /auth/school-admin/verify-otp  — Step 2
// Requires 2FA intermediate token in Authorization header
// Body: { otp }
// -----------------------------------------------------------------------------
async function verifyOTP(req, res) {
    try {
        const { otp } = req.body;

        // req.user is populated by authenticate2FA middleware
        const { userId, role, school_id, name } = req.user;

        if (!otp) {
            return error(res, 'OTP is required', 400);
        }

        const verified = await consumeOTP(userId, '2FA_LOGIN', otp);

        if (!verified.valid) {
            return error(res, `Invalid or expired OTP: ${verified.reason}`, 400);
        }

        // Update last_active_at
        await pool.query(`
      UPDATE users SET last_active_at = NOW() WHERE id = $1
    `, [userId]);

        // Issue full JWT — login complete
        const token = signToken({ userId, role, school_id, name });

        return success(res, {
            token,
            user: { id: userId, name, role, school_id },
        }, 'Login successful');

    } catch (err) {
        logger.error('SchoolAdmin verifyOTP error', { error: err.message, stack: err.stack });
        return error(res, 'OTP verification failed', 500, err.message);
    }
}

// -----------------------------------------------------------------------------
// POST /auth/school-admin/forgot-password
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
      WHERE email = $1 AND role = 'SCHOOL_ADMIN' AND is_active = TRUE
    `, [email.toLowerCase().trim()]);

        if (result.rowCount === 0) {
            return success(res, {}, 'If this email exists, a reset code has been sent.');
        }

        const user = result.rows[0];
        const otp = await issueOTP(user.id, 'FORGOT_PASSWORD');
        await sendEmailOTP(user.email, otp, user.name);

        return success(res, {}, 'Password reset code sent to your email.');

    } catch (err) {
        logger.error('SchoolAdmin forgotPassword error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to send reset code', 500, err.message);
    }
}

// -----------------------------------------------------------------------------
// POST /auth/school-admin/reset-password
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
      WHERE email = $1 AND role = 'SCHOOL_ADMIN' AND is_active = TRUE
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
        logger.error('SchoolAdmin resetPassword error', { error: err.message, stack: err.stack });
        return error(res, 'Password reset failed', 500, err.message);
    }
}

module.exports = { login, verifyOTP, forgotPassword, resetPassword };
