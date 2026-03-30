// =============================================================================
// src/middleware/auth.js
// JWT authentication middleware + role-based access guards
// school_id enforcement — every request is scoped to the caller's school
// =============================================================================

const { verifyToken, verify2FAToken } = require('../utils/jwt');
const { error } = require('../utils/response');

// -----------------------------------------------------------------------------
// authenticate
// Validates the JWT from Authorization header.
// Attaches decoded payload to req.user.
// Enforces school_id on every non-super-admin request.
// -----------------------------------------------------------------------------
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return error(res, 'Authorization token required', 401);
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = verifyToken(token);

        // Reject 2FA intermediate tokens on regular endpoints
        if (decoded.is2FAPending) {
            return error(res, 'Login not complete. Please verify your OTP.', 401);
        }

        req.user = decoded;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return error(res, 'Session expired. Please log in again.', 401);
        }
        return error(res, 'Invalid token', 401);
    }
}

// -----------------------------------------------------------------------------
// authenticate2FA
// Validates the short-lived 2FA intermediate token.
// Used only on the /auth/school-admin/verify-otp endpoint.
// -----------------------------------------------------------------------------
function authenticate2FA(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return error(res, 'Authorization token required', 401);
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = verify2FAToken(token);

        if (!decoded.is2FAPending) {
            return error(res, 'Invalid 2FA token', 401);
        }

        req.user = decoded;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return error(res, 'OTP session expired. Please log in again.', 401);
        }
        return error(res, 'Invalid 2FA token', 401);
    }
}

// -----------------------------------------------------------------------------
// Role guards — use as middleware after authenticate
// -----------------------------------------------------------------------------
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return error(res, 'Unauthorized', 401);
        }
        if (!roles.includes(req.user.role)) {
            return error(res, 'You do not have permission to access this resource', 403);
        }
        next();
    };
}

// Convenience shorthand guards
const requireSuperAdmin = requireRole('SUPER_ADMIN');
const requireSchoolAdmin = requireRole('SCHOOL_ADMIN');
const requireDriver = requireRole('DRIVER');
const requireParent = requireRole('PARENT');
const requireAdminOrAbove = requireRole('SUPER_ADMIN', 'SCHOOL_ADMIN');

// -----------------------------------------------------------------------------
// enforceSchoolScope
// Ensures the school_id in route params or body matches the caller's school_id.
// Super Admin bypasses this — they operate across schools.
// -----------------------------------------------------------------------------
function enforceSchoolScope(req, res, next) {
    if (req.user.role === 'SUPER_ADMIN') {
        return next(); // Super Admin is not scoped
    }

    const requestedSchoolId =
        req.params.schoolId ||
        req.body.school_id ||
        req.query.school_id;

    if (requestedSchoolId && requestedSchoolId !== req.user.school_id) {
        return error(res, 'Access denied: cross-school request not permitted', 403);
    }

    // Always inject the caller's school_id into the request
    // so controllers never need to trust user-supplied school_id
    req.schoolId = req.user.school_id;
    next();
}

module.exports = {
    authenticate,
    authenticate2FA,
    requireRole,
    requireSuperAdmin,
    requireSchoolAdmin,
    requireDriver,
    requireParent,
    requireAdminOrAbove,
    enforceSchoolScope,
};
