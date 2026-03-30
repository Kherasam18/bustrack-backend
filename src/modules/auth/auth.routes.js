// =============================================================================
// src/modules/auth/auth.routes.js
// All authentication routes
// =============================================================================

const express = require('express');
const router = express.Router();

const superAdminCtrl = require('./superAdmin.controller');
const schoolAdminCtrl = require('./schoolAdmin.controller');
const driverCtrl = require('./driver.controller');
const parentCtrl = require('./parent.controller');

const {
    authenticate,
    authenticate2FA,
    requireSuperAdmin,
    requireSchoolAdmin,
    requireDriver,
    requireParent,
} = require('../../middleware/auth');

const rateLimit = require('express-rate-limit');

// -----------------------------------------------------------------------------
// Rate limiters
// Tight limits on login and OTP endpoints to prevent brute force
// -----------------------------------------------------------------------------
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 10,
    message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,  // 10 minutes
    max: 3,
    message: { success: false, message: 'Too many OTP requests. Please wait before trying again.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// =============================================================================
// SUPER ADMIN
// =============================================================================
router.post('/super-admin/login', loginLimiter, superAdminCtrl.login);
router.post('/super-admin/forgot-password', otpLimiter, superAdminCtrl.forgotPassword);
router.post('/super-admin/reset-password', superAdminCtrl.resetPassword);

// =============================================================================
// SCHOOL ADMIN (2FA flow)
// =============================================================================
router.post('/school-admin/login', loginLimiter, schoolAdminCtrl.login);
router.post('/school-admin/verify-otp', authenticate2FA, schoolAdminCtrl.verifyOTP);
router.post('/school-admin/forgot-password', otpLimiter, schoolAdminCtrl.forgotPassword);
router.post('/school-admin/reset-password', schoolAdminCtrl.resetPassword);

// =============================================================================
// DRIVER
// =============================================================================
router.post('/driver/login', loginLimiter, driverCtrl.login);
router.post('/driver/change-password', authenticate, requireDriver, driverCtrl.changePassword);

// =============================================================================
// PARENT
// =============================================================================
router.post('/parent/login', loginLimiter, parentCtrl.login);
router.post('/parent/change-password', authenticate, requireParent, parentCtrl.changePassword);
router.post('/parent/forgot-password', otpLimiter, parentCtrl.forgotPasswordSendOTP);
router.post('/parent/forgot-password/verify', parentCtrl.forgotPasswordVerifyOTP);
router.post('/parent/forgot-password/reset', parentCtrl.forgotPasswordReset);

// =============================================================================
// SHARED — Get current user profile (all authenticated roles)
// =============================================================================
router.get('/me', authenticate, async (req, res) => {
    const pool = require('../../config/db');
    const { success: ok, error: err } = require('../../utils/response');
    try {
        const result = await pool.query(`
      SELECT id, name, email, phone, role, school_id, employee_id, last_active_at
      FROM users WHERE id = $1
    `, [req.user.userId]);

        if (result.rowCount === 0) {
            return err(res, 'User not found', 404);
        }
        return ok(res, { user: result.rows[0] });
    } catch (e) {
        return err(res, 'Failed to fetch profile', 500);
    }
});

module.exports = router;
