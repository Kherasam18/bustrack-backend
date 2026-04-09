// =============================================================================
// src/modules/auth/parent.controller.js
// Parent authentication
//
// Login:           Phone + Password (default: SchoolCode+Class+Section+RollNo)
// First login:     Optional prompt to change password (flag in response)
// Forgot password: Phone OTP via MSG91
//
// Endpoints:
//   POST /auth/parent/login
//   POST /auth/parent/change-password          (authenticated)
//   POST /auth/parent/forgot-password          (send OTP to phone)
//   POST /auth/parent/forgot-password/verify   (verify OTP)
//   POST /auth/parent/forgot-password/reset    (set new password)
// =============================================================================

const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const { signToken } = require('../../utils/jwt');
const { success, error } = require('../../utils/response');
const { issueOTP, consumeOTP } = require('../otp/otpStore');
const { sendPhoneOTP } = require('../../utils/otp');
const logger = require('../../config/logger');

// -----------------------------------------------------------------------------
// POST /auth/parent/login
// Body: { phone, password, school_id }
// -----------------------------------------------------------------------------
async function login(req, res) {
    try {
        const { phone, password, school_id } = req.body;

        if (!phone || !password || !school_id) {
            return error(res, 'Phone number, password, and school ID are required', 400);
        }

        const result = await pool.query(`
      SELECT u.id, u.name, u.phone, u.password_hash, u.role,
             u.school_id, u.is_active, u.last_active_at,
             s.is_active AS school_active
      FROM users u
      JOIN schools s ON s.id = u.school_id
      WHERE u.phone     = $1
        AND u.school_id = $2
        AND u.role      = 'PARENT'
    `, [phone.trim(), school_id]);

        if (result.rowCount === 0) {
            return error(res, 'Invalid phone number or password', 401);
        }

        const user = result.rows[0];

        if (!user.is_active) {
            return error(res, 'Your account has been deactivated. Contact your school.', 403);
        }

        if (!user.school_active) {
            return error(res, 'School account is inactive.', 403);
        }

        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            return error(res, 'Invalid phone number or password', 401);
        }

        // Detect first login — last_active_at is NULL means they've never logged in
        const isFirstLogin = user.last_active_at === null;

        await pool.query(`
      UPDATE users SET last_active_at = NOW() WHERE id = $1
    `, [user.id]);

        // Fetch linked children for this parent
        const childrenResult = await pool.query(`
      SELECT s.id, s.name, s.class, s.section, s.roll_no
      FROM parent_students ps
      JOIN students s ON s.id = ps.student_id
      WHERE ps.parent_id = $1
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
                phone: user.phone,
            },
            children: childrenResult.rows,
            isFirstLogin,          // Frontend shows optional "change password" prompt if true
            // No force — parent can skip. This is just a signal to the frontend.
        }, 'Login successful');

    } catch (err) {
        logger.error('Parent login error', { error: err.message, stack: err.stack });
        return error(res, 'Login failed', 500, err.message);
    }
}

// -----------------------------------------------------------------------------
// POST /auth/parent/change-password
// Authenticated. Parent voluntarily changes their password.
// Body: { current_password, new_password }
// -----------------------------------------------------------------------------
async function changePassword(req, res) {
    try {
        const { current_password, new_password } = req.body;
        const userId = req.user.userId;

        if (!current_password || !new_password) {
            return error(res, 'Current and new password are required', 400);
        }

        if (new_password.length < 6) {
            return error(res, 'New password must be at least 6 characters', 400);
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
        logger.error('Parent changePassword error', { error: err.message, stack: err.stack });
        return error(res, 'Password change failed', 500, err.message);
    }
}

// -----------------------------------------------------------------------------
// POST /auth/parent/forgot-password
// Step 1: Send OTP to phone
// Body: { phone, school_id }
// -----------------------------------------------------------------------------
async function forgotPasswordSendOTP(req, res) {
    try {
        const { phone, school_id } = req.body;

        if (!phone || !school_id) {
            return error(res, 'Phone number and school ID are required', 400);
        }

        const result = await pool.query(`
      SELECT id, name, phone FROM users
      WHERE phone     = $1
        AND school_id = $2
        AND role      = 'PARENT'
        AND is_active = TRUE
    `, [phone.trim(), school_id]);

        // Always return success — don't confirm whether phone exists
        if (result.rowCount === 0) {
            return success(res, {}, 'If this number is registered, an OTP has been sent.');
        }

        const user = result.rows[0];
        const otp = await issueOTP(user.id, 'FORGOT_PASSWORD');
        await sendPhoneOTP(user.phone, otp);

        return success(res, {
            // Return a masked phone for display: "+91 ******* 89"
            maskedPhone: user.phone.replace(/.(?=.{2})/g, '*'),
        }, 'OTP sent to your registered phone number.');

    } catch (err) {
        logger.error('Parent forgotPassword sendOTP error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to send OTP', 500, err.message);
    }
}

// -----------------------------------------------------------------------------
// POST /auth/parent/forgot-password/verify
// Step 2: Verify OTP (does NOT reset password yet — just confirms identity)
// Body: { phone, school_id, otp }
// Returns a short-lived reset token on success
// -----------------------------------------------------------------------------
async function forgotPasswordVerifyOTP(req, res) {
    try {
        const { phone, school_id, otp } = req.body;

        if (!phone || !school_id || !otp) {
            return error(res, 'Phone, school ID, and OTP are required', 400);
        }

        const result = await pool.query(`
      SELECT id FROM users
      WHERE phone     = $1
        AND school_id = $2
        AND role      = 'PARENT'
        AND is_active = TRUE
    `, [phone.trim(), school_id]);

        if (result.rowCount === 0) {
            return error(res, 'Invalid request', 400);
        }

        const user = result.rows[0];
        const verified = await consumeOTP(user.id, 'FORGOT_PASSWORD', otp);

        if (!verified.valid) {
            return error(res, `OTP verification failed: ${verified.reason}`, 400);
        }

        // Issue a short-lived reset token so the client can proceed to set new password
        // without re-sending OTP
        const { signToken: sign } = require('../../utils/jwt');
        const resetToken = sign({
            userId: user.id,
            purpose: 'PASSWORD_RESET',
            school_id,
        });
        // Override expiry to 10 minutes for reset tokens
        const jwt = require('jsonwebtoken');
        const shortToken = jwt.sign(
            { userId: user.id, purpose: 'PASSWORD_RESET', school_id },
            process.env.JWT_SECRET,
            { expiresIn: '10m' }
        );

        return success(res, { resetToken: shortToken }, 'OTP verified. You may now reset your password.');

    } catch (err) {
        logger.error('Parent forgotPassword verifyOTP error', { error: err.message, stack: err.stack });
        return error(res, 'OTP verification failed', 500, err.message);
    }
}

// -----------------------------------------------------------------------------
// POST /auth/parent/forgot-password/reset
// Step 3: Set new password using reset token
// Body: { reset_token, new_password }
// -----------------------------------------------------------------------------
async function forgotPasswordReset(req, res) {
    try {
        const { reset_token, new_password } = req.body;

        if (!reset_token || !new_password) {
            return error(res, 'Reset token and new password are required', 400);
        }

        if (new_password.length < 6) {
            return error(res, 'Password must be at least 6 characters', 400);
        }

        // Verify reset token
        const jwt = require('jsonwebtoken');
        let decoded;
        try {
            decoded = jwt.verify(reset_token, process.env.JWT_SECRET);
        } catch {
            return error(res, 'Reset token is invalid or expired. Please request a new OTP.', 400);
        }

        if (decoded.purpose !== 'PASSWORD_RESET') {
            return error(res, 'Invalid reset token', 400);
        }

        const hash = await bcrypt.hash(new_password, 12);
        await pool.query(`
      UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2
    `, [hash, decoded.userId]);

        return success(res, {}, 'Password reset successfully. Please log in.');

    } catch (err) {
        logger.error('Parent forgotPassword reset error', { error: err.message, stack: err.stack });
        return error(res, 'Password reset failed', 500, err.message);
    }
}

module.exports = {
    login,
    changePassword,
    forgotPasswordSendOTP,
    forgotPasswordVerifyOTP,
    forgotPasswordReset,
};
