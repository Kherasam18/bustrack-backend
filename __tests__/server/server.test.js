'use strict';

// =============================================================================
// __tests__/server/server.test.js
//
// Tests for the server.js changes introduced in this PR:
// - Registration of the startUpdateTrackingStatus cron job inside app.listen
//
// Strategy:
//   - Mock all dependencies (express, routes, db, etc.) so server.js loads
//   - Capture the app.listen() callback via a mock
//   - Invoke the callback to exercise the new cron registration block
// =============================================================================

// ---------------------------------------------------------------------------
// Mock setup — must happen before any require() that triggers server.js load
// ---------------------------------------------------------------------------

// Express mock — include Router, json, urlencoded so route files don't fail
let listenCallback = null;

const mockRouter = {
    get:    jest.fn().mockReturnThis(),
    post:   jest.fn().mockReturnThis(),
    put:    jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    patch:  jest.fn().mockReturnThis(),
    use:    jest.fn().mockReturnThis(),
};

const mockListen = jest.fn((port, cb) => { listenCallback = cb; });
const mockApp    = {
    use:    jest.fn(),
    get:    jest.fn(),
    listen: mockListen,
};

const mockExpress          = jest.fn(() => mockApp);
mockExpress.Router         = jest.fn(() => mockRouter);
mockExpress.json           = jest.fn(() => jest.fn());
mockExpress.urlencoded     = jest.fn(() => jest.fn());
jest.mock('express', () => mockExpress);

// Logger
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../src/config/logger', () => mockLogger);

// OTP store
jest.mock('../../src/modules/otp/otpStore', () => ({
    initOTPStore: jest.fn().mockResolvedValue(undefined),
}));

// Mailer (side-effect import only)
jest.mock('../../src/config/mailer', () => ({}));

// DB pool (needed by route modules / middleware)
jest.mock('../../src/config/db', () => ({ query: jest.fn(), connect: jest.fn() }));

// Firebase (needed by location.service which is pulled in by location.routes)
jest.mock('../../src/config/firebase', () => ({
    database: jest.fn(() => ({ ref: jest.fn(() => ({ set: jest.fn() })) })),
    auth:     jest.fn(() => ({ verifyIdToken: jest.fn() })),
}));

// Route modules — return a plain function so app.use() accepts them
jest.mock('../../src/modules/auth/auth.routes',       () => jest.fn());
jest.mock('../../src/modules/schools/schools.routes', () => jest.fn());

// Journeys service (imported by location.service)
jest.mock('../../src/modules/journeys/journeys.service', () => ({
    isValidUUID: jest.fn(() => true),
}));

// Notification worker
const mockStartWorker = jest.fn();
jest.mock('../../src/workers/notificationWorker', () => ({
    startWorker: mockStartWorker,
}));

// detectLateStart cron
const mockStartDetectLateStart = jest.fn();
jest.mock('../../src/jobs/detectLateStart', () => ({
    startDetectLateStart: mockStartDetectLateStart,
}));

// The job under test
const mockStartUpdateTrackingStatus = jest.fn();
jest.mock('../../src/jobs/updateTrackingStatus', () => ({
    startUpdateTrackingStatus: mockStartUpdateTrackingStatus,
}));

// dotenv
jest.mock('dotenv', () => ({ config: jest.fn() }));

// ---------------------------------------------------------------------------
// Load server.js — this triggers start() immediately
// ---------------------------------------------------------------------------
beforeAll(async () => {
    jest.resetModules();

    // Re-apply key mocks after resetModules
    jest.mock('../../src/jobs/updateTrackingStatus', () => ({
        startUpdateTrackingStatus: mockStartUpdateTrackingStatus,
    }));
    jest.mock('../../src/modules/otp/otpStore', () => ({
        initOTPStore: jest.fn().mockResolvedValue(undefined),
    }));

    require('../../src/server');

    // Wait for start()'s async initOTPStore to resolve and listen to be called
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('server.js — startUpdateTrackingStatus registration (PR change)', () => {
    test('app.listen is called during startup', () => {
        expect(mockListen).toHaveBeenCalledTimes(1);
        expect(listenCallback).toBeInstanceOf(Function);
    });

    test('startUpdateTrackingStatus is called inside the listen callback', () => {
        mockStartUpdateTrackingStatus.mockClear();
        listenCallback();
        expect(mockStartUpdateTrackingStatus).toHaveBeenCalledTimes(1);
    });

    test('logs an error (and does not throw) when startUpdateTrackingStatus throws', () => {
        mockStartUpdateTrackingStatus.mockImplementationOnce(() => {
            throw new Error('cron init failed');
        });
        mockLogger.error.mockClear();

        expect(() => listenCallback()).not.toThrow();

        expect(mockLogger.error).toHaveBeenCalledWith(
            'updateTrackingStatus cron failed to start',
            { error: 'cron init failed' }
        );
    });

    test('startUpdateTrackingStatus is registered alongside the other jobs', () => {
        mockStartWorker.mockClear();
        mockStartDetectLateStart.mockClear();
        mockStartUpdateTrackingStatus.mockClear();

        listenCallback();

        expect(mockStartWorker).toHaveBeenCalled();
        expect(mockStartDetectLateStart).toHaveBeenCalled();
        expect(mockStartUpdateTrackingStatus).toHaveBeenCalled();
    });
});