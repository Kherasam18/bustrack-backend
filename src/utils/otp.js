// =============================================================================
// src/utils/otp.js
// OTP generation, hashing, verification
// MSG91 delivery (phone) and email delivery
// =============================================================================

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mailer = require('../config/mailer');

// -----------------------------------------------------------------------------
// Generate a numeric OTP of configured length
// -----------------------------------------------------------------------------
function generateOTP() {
    const length = parseInt(process.env.OTP_LENGTH, 10) || 6;
    // Use crypto for randomness — Math.random() is not suitable for security
    const max = Math.pow(10, length);
    const otp = crypto.randomInt(0, max).toString().padStart(length, '0');
    return otp;
}

// -----------------------------------------------------------------------------
// Hash OTP before storing in DB — same principle as password hashing
// Never store raw OTPs
// -----------------------------------------------------------------------------
async function hashOTP(otp) {
    return bcrypt.hash(otp, 10);
}

async function verifyOTP(plainOTP, hashedOTP) {
    return bcrypt.compare(plainOTP, hashedOTP);
}

// -----------------------------------------------------------------------------
// OTP expiry — returns the timestamp when this OTP expires
// -----------------------------------------------------------------------------
function otpExpiresAt() {
    const minutes = parseInt(process.env.OTP_EXPIRES_IN_MINUTES, 10) || 10;
    return new Date(Date.now() + minutes * 60 * 1000);
}

// -----------------------------------------------------------------------------
// Send OTP via MSG91 (Phone — used for Parent forgot password)
// MSG91 Flow API
// -----------------------------------------------------------------------------
async function sendPhoneOTP(phone, otp) {
    // Normalise phone to E.164 format for India (add 91 prefix if not present)
    const normalised = phone.startsWith('+')
        ? phone.replace('+', '')
        : phone.startsWith('91')
            ? phone
            : `91${phone}`;

    const payload = {
        flow_id: process.env.MSG91_TEMPLATE_ID,
        sender: process.env.MSG91_SENDER_ID,
        mobiles: normalised,
        OTP: otp,   // This variable name must match your MSG91 template variable
    };

    const response = await fetch('https://api.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'authkey': process.env.MSG91_AUTH_KEY,
        },
        body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok || result.type === 'error') {
        throw new Error(`MSG91 error: ${result.message || 'Unknown error'}`);
    }

    return result;
}

// -----------------------------------------------------------------------------
// Send OTP via Email (used for School Admin 2FA)
// -----------------------------------------------------------------------------
async function sendEmailOTP(email, otp, name) {
    const minutes = process.env.OTP_EXPIRES_IN_MINUTES || 10;

    await mailer.sendMail({
        from: process.env.SMTP_FROM,
        to: email,
        subject: 'BusTrack — Your Login Verification Code',
        html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #2B5FAC;">BusTrack Login Verification</h2>
        <p>Hi ${name},</p>
        <p>Your one-time verification code is:</p>
        <div style="
          font-size: 36px;
          font-weight: bold;
          letter-spacing: 8px;
          color: #2B5FAC;
          text-align: center;
          padding: 20px;
          background: #EBF2FB;
          border-radius: 8px;
          margin: 20px 0;
        ">${otp}</div>
        <p>This code expires in <strong>${minutes} minutes</strong>.</p>
        <p>If you did not attempt to log in, please contact your platform administrator immediately.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #999; font-size: 12px;">BusTrack — School Bus Tracking System</p>
      </div>
    `,
    });
}

module.exports = {
    generateOTP,
    hashOTP,
    verifyOTP,
    otpExpiresAt,
    sendPhoneOTP,
    sendEmailOTP,
};
