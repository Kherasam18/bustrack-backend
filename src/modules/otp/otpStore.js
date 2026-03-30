// =============================================================================
// src/modules/otp/otpStore.js
// Stores hashed OTPs in PostgreSQL with expiry
// Used for:
//   - School Admin 2FA (email OTP)
//   - Parent forgot password (phone OTP)
//
// Uses a dedicated otp_store table — see migration SQL at bottom of file.
// =============================================================================

const pool = require('../../config/db');
const { generateOTP, hashOTP, verifyOTP, otpExpiresAt } = require('../../utils/otp');

// -----------------------------------------------------------------------------
// Create the otp_store table if it doesn't exist
// Called once on server startup
// -----------------------------------------------------------------------------
async function initOTPStore() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS otp_store (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      purpose      TEXT        NOT NULL,   -- '2FA_LOGIN' | 'FORGOT_PASSWORD'
      otp_hash     TEXT        NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      used         BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      -- One active OTP per user per purpose at a time
      CONSTRAINT otp_store_unique_active UNIQUE (user_id, purpose)
    );

    CREATE INDEX IF NOT EXISTS idx_otp_store_user_purpose
      ON otp_store (user_id, purpose);
  `);
}

// -----------------------------------------------------------------------------
// Issue a new OTP for a user
// Upserts — replaces any existing OTP for the same user+purpose
// Returns the plain OTP (caller sends it via email/SMS, we never store it plain)
// -----------------------------------------------------------------------------
async function issueOTP(userId, purpose) {
    const plain = generateOTP();
    const hash = await hashOTP(plain);
    const expiresAt = otpExpiresAt();

    await pool.query(`
    INSERT INTO otp_store (user_id, purpose, otp_hash, expires_at, used)
    VALUES ($1, $2, $3, $4, FALSE)
    ON CONFLICT (user_id, purpose)
    DO UPDATE SET
      otp_hash   = EXCLUDED.otp_hash,
      expires_at = EXCLUDED.expires_at,
      used       = FALSE,
      created_at = NOW()
  `, [userId, purpose, hash, expiresAt]);

    return plain;
}

// -----------------------------------------------------------------------------
// Verify an OTP
// Returns true if valid and not expired, false otherwise
// Marks OTP as used immediately on success (one-time use)
// -----------------------------------------------------------------------------
async function consumeOTP(userId, purpose, plainOTP) {
    const result = await pool.query(`
    SELECT id, otp_hash, expires_at, used
    FROM otp_store
    WHERE user_id = $1 AND purpose = $2
  `, [userId, purpose]);

    if (result.rowCount === 0) {
        return { valid: false, reason: 'No OTP found' };
    }

    const record = result.rows[0];

    if (record.used) {
        return { valid: false, reason: 'OTP already used' };
    }

    if (new Date() > new Date(record.expires_at)) {
        return { valid: false, reason: 'OTP expired' };
    }

    const match = await verifyOTP(plainOTP, record.otp_hash);

    if (!match) {
        return { valid: false, reason: 'Incorrect OTP' };
    }

    // Mark as used
    await pool.query(`
    UPDATE otp_store SET used = TRUE WHERE id = $1
  `, [record.id]);

    return { valid: true };
}

// -----------------------------------------------------------------------------
// Clean up expired OTPs — call this from a daily cron job
// -----------------------------------------------------------------------------
async function purgeExpiredOTPs() {
    const result = await pool.query(`
    DELETE FROM otp_store WHERE expires_at < NOW() OR used = TRUE
  `);
    return result.rowCount;
}

module.exports = {
    initOTPStore,
    issueOTP,
    consumeOTP,
    purgeExpiredOTPs,
};
