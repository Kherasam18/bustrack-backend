// =============================================================================
// src/server.js
// BusTrack API — Entry point
//
// Multi-tenant school bus tracking SaaS backend.
// Mounts all route modules, initialises OTP store, and starts Express.
// =============================================================================

require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const { initOTPStore } = require('./modules/otp/otpStore');

// =============================================================================
// Create Express app
// =============================================================================
const app = express();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// =============================================================================
// Global middleware
// =============================================================================

// --- Body parsers ---
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// --- Security headers ---
app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.removeHeader('X-Powered-By');
    next();
});

// --- Request logger (development only) ---
if (NODE_ENV === 'development') {
    app.use((req, _res, next) => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}]  ${req.method}  ${req.path}`);
        next();
    });
}

// =============================================================================
// Health check
// =============================================================================
app.get('/health', (_req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: NODE_ENV,
        version: '1.0.0',
    });
});

// =============================================================================
// Mount completed route modules
// =============================================================================
app.use('/api/auth', require('./modules/auth/auth.routes'));
app.use('/api/schools', require('./modules/schools/schools.routes'));

// =============================================================================
// Mount future modules (safe — only loaded if the file exists)
// =============================================================================
const futureModules = [
    { path: '/api/users',         file: './modules/users/users.routes.js' },
    { path: '/api/students',      file: './modules/students/students.routes.js' },
    { path: '/api/buses',         file: './modules/buses/buses.routes.js' },
    { path: '/api/routes',        file: './modules/routes/routes.routes.js' },
    { path: '/api/journeys',      file: './modules/journeys/journeys.routes.js' },
    { path: '/api/location',      file: './modules/location/location.routes.js' },
    { path: '/api/notifications', file: './modules/notifications/notifications.routes.js' },
    { path: '/api/substitutes',   file: './modules/substitutes/substitutes.routes.js' },
    { path: '/api/dashboard',     file: './modules/dashboard/dashboard.routes.js' },
];

futureModules.forEach(({ path: routePath, file }) => {
    const absolutePath = path.resolve(__dirname, file);
    if (fs.existsSync(absolutePath)) {
        const mod = require(absolutePath);
        // Only mount if the file exports a valid middleware / router function
        if (typeof mod === 'function') {
            app.use(routePath, mod);
            console.log(`✅ Mounted ${routePath}`);
        } else {
            console.log(`⚠️  Skipped ${routePath} (not a valid router yet)`);
        }
    }
});

// =============================================================================
// 404 handler — catches all unmatched routes
// =============================================================================
app.use((_req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found',
    });
});

// =============================================================================
// Global error handler (must have 4 parameters for Express to recognise it)
// =============================================================================
app.use((err, _req, res, _next) => {
    console.error('❌ Unhandled error:', err.stack || err.message || err);

    const statusCode = err.statusCode || 500;
    const message =
        NODE_ENV === 'production'
            ? 'Internal server error'
            : err.message || 'Internal server error';

    res.status(statusCode).json({
        success: false,
        message,
        ...(NODE_ENV === 'development' && { stack: err.stack }),
    });
});

// =============================================================================
// Startup
// =============================================================================
async function start() {
    try {
        // Ensure OTP store table exists
        await initOTPStore();
        console.log('✅ OTP store initialised');

        // Trigger SMTP verification (mailer.js self-verifies on require)
        require('./config/mailer');

        app.listen(PORT, () => {
            console.log('');
            console.log('🚌 ═══════════════════════════════════════════');
            console.log('🚌  BusTrack API Server');
            console.log(`🚌  Environment : ${NODE_ENV}`);
            console.log(`🚌  Port        : ${PORT}`);
            console.log(`🚌  Health      : http://localhost:${PORT}/health`);
            console.log('🚌 ═══════════════════════════════════════════');
            console.log('');
        });
    } catch (err) {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    }
}

start();
