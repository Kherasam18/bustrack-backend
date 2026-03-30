// =============================================================================
// src/utils/jwt.js
// JWT signing and verification
// Two token types:
//   - Main JWT:  issued after full auth is complete
//   - 2FA JWT:   short-lived, issued after password check, before OTP verified
// =============================================================================

const jwt = require('jsonwebtoken');

// -----------------------------------------------------------------------------
// Sign main JWT — issued to all roles after complete login
// Payload carries only what middleware needs: no sensitive data
// -----------------------------------------------------------------------------
function signToken(payload) {
    return jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
}

// -----------------------------------------------------------------------------
// Sign 2FA intermediate token — School Admin only
// Short-lived. Grants access only to the /verify-otp endpoint.
// -----------------------------------------------------------------------------
function sign2FAToken(payload) {
    return jwt.sign(
        { ...payload, is2FAPending: true },
        process.env.JWT_2FA_SECRET,
        { expiresIn: process.env.JWT_2FA_EXPIRES_IN || '10m' }
    );
}

// -----------------------------------------------------------------------------
// Verify main JWT
// -----------------------------------------------------------------------------
function verifyToken(token) {
    return jwt.verify(token, process.env.JWT_SECRET);
}

// -----------------------------------------------------------------------------
// Verify 2FA intermediate token
// -----------------------------------------------------------------------------
function verify2FAToken(token) {
    return jwt.verify(token, process.env.JWT_2FA_SECRET);
}

module.exports = {
    signToken,
    sign2FAToken,
    verifyToken,
    verify2FAToken,
};
