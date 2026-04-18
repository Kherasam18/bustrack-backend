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
const logger  = require('./config/logger');

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

// --- HTTP request logger ---
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        const meta = {
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            durationMs: duration,
        };
        if (req.user) {
            meta.userId = req.user.userId;
            meta.schoolId = req.user.school_id;
        }
        // Use warn level for 4xx/5xx, info for success
        if (res.statusCode >= 500) {
            logger.error('HTTP request', meta);
        } else if (res.statusCode >= 400) {
            logger.warn('HTTP request', meta);
        } else {
            logger.info('HTTP request', meta);
        }
    });
    next();
});

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
            logger.info('Route mounted', { path: routePath });
        } else {
            logger.warn('Route skipped (not a valid router)', { path: routePath });
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
    logger.error('Unhandled error', { error: err.message, stack: err.stack });

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
        logger.info('OTP store initialised');

        // Trigger SMTP verification (mailer.js self-verifies on require)
        require('./config/mailer');

        app.listen(PORT, () => {
            logger.info('BusTrack API Server started', { environment: NODE_ENV, port: PORT, health: `http://localhost:${PORT}/health` });

            // Notification worker always runs on every instance
            const { startWorker } = require('./workers/notificationWorker');
            try { startWorker(); } catch (err) { logger.error('Failed to start notification worker', { error: err.message }); }

            // Maintenance crons run only on the instance where RUN_MAINTENANCE_CRONS=true
            // In single-instance deployments: set RUN_MAINTENANCE_CRONS=true in .env
            // In multi-instance deployments: set it true on exactly one instance only
            if (process.env.RUN_MAINTENANCE_CRONS === 'true') {
                const { startDetectLateStart } = require('./jobs/detectLateStart');
                const { startUpdateTrackingStatus } = require('./jobs/updateTrackingStatus');
                const { startExpireJourneys } = require('./jobs/expireJourneys');
                const { startClearNotifications } = require('./jobs/clearNotifications');

                try { startDetectLateStart(); }       catch (err) { logger.error('Failed to start detectLateStart', { error: err.message }); }
                try { startUpdateTrackingStatus(); }  catch (err) { logger.error('Failed to start updateTrackingStatus', { error: err.message }); }
                try { startExpireJourneys(); }        catch (err) { logger.error('Failed to start expireJourneys', { error: err.message }); }
                try { startClearNotifications(); }    catch (err) { logger.error('Failed to start clearNotifications', { error: err.message }); }

                logger.info('Maintenance cron jobs started');
            } else {
                logger.info('Maintenance cron jobs skipped (RUN_MAINTENANCE_CRONS not set)');
            }

            logger.info(`Server running on port ${PORT}`);
        });
    } catch (err) {
        logger.error('Failed to start server', { error: err.message, stack: err.stack });
        process.exit(1);
    }
}

start();
