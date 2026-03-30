// =============================================================================
// src/config/mailer.js
// Nodemailer transport — used for School Admin 2FA OTP and password resets
// =============================================================================

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

// Verify SMTP connection on startup
transporter.verify((err) => {
    if (err) {
        console.warn('⚠️  SMTP connection failed:', err.message);
    } else {
        console.log('✅ SMTP mailer ready');
    }
});

module.exports = transporter;
