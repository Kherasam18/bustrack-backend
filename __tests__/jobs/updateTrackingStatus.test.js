'use strict';

// =============================================================================
// __tests__/jobs/updateTrackingStatus.test.js
//
// Unit tests for src/jobs/updateTrackingStatus.js
//
// Strategy: mock all external dependencies (pool, rabbitmq, logger, node-cron)
// and capture the updateTrackingStatus callback via cron.schedule mock.
// All internal functions are exercised through the main orchestrator.
// =============================================================================

// ---------------------------------------------------------------------------
// Mocks — must be declared before any require() of the module under test
// ---------------------------------------------------------------------------

const mockPoolQuery = jest.fn();
const mockConnect    = jest.fn();
const mockPool = { query: mockPoolQuery, connect: mockConnect };

jest.mock('../../src/config/db', () => mockPool);

const mockGetRabbitMQChannel = jest.fn();
jest.mock('../../src/config/rabbitmq', () => ({
    getRabbitMQChannel: mockGetRabbitMQChannel,
}));

const mockLogger = {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
};
jest.mock('../../src/config/logger', () => mockLogger);

let capturedCronCallback = null;
const mockCronSchedule = jest.fn((expression, callback) => {
    capturedCronCallback = callback;
});
jest.mock('node-cron', () => ({ schedule: mockCronSchedule }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock pg client whose .query() calls resolve in sequence.
 * Each element in `responses` maps to successive .query() invocations.
 */
function buildMockClient(responses = []) {
    let callIndex = 0;
    const client = {
        query: jest.fn(() => {
            const resp = responses[callIndex] || { rows: [], rowCount: 0 };
            callIndex++;
            return Promise.resolve(resp);
        }),
        release: jest.fn(),
    };
    return client;
}

/**
 * Invoke the job body (the function passed to cron.schedule) directly.
 */
async function runJob() {
    expect(capturedCronCallback).not.toBeNull();
    await capturedCronCallback();
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let startUpdateTrackingStatus;

beforeEach(() => {
    jest.clearAllMocks();
    capturedCronCallback = null;

    // Re-require to reset module state and re-capture cron callback
    jest.resetModules();

    // Re-apply mocks after resetModules
    jest.mock('../../src/config/db', () => mockPool);
    jest.mock('../../src/config/rabbitmq', () => ({
        getRabbitMQChannel: mockGetRabbitMQChannel,
    }));
    jest.mock('../../src/config/logger', () => mockLogger);
    jest.mock('node-cron', () => ({ schedule: mockCronSchedule }));

    ({ startUpdateTrackingStatus } = require('../../src/jobs/updateTrackingStatus'));

    // Register the cron to capture the callback
    startUpdateTrackingStatus();
});

// ===========================================================================
// describe: startUpdateTrackingStatus
// ===========================================================================
describe('startUpdateTrackingStatus', () => {
    test('registers a cron job with the every-minute schedule', () => {
        expect(mockCronSchedule).toHaveBeenCalledTimes(1);
        expect(mockCronSchedule).toHaveBeenCalledWith('* * * * *', expect.any(Function));
    });

    test('logs the cron registration message', () => {
        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: cron registered (* * * * *)'
        );
    });
});

// ===========================================================================
// describe: updateTrackingStatus — main orchestrator
// ===========================================================================
describe('updateTrackingStatus (main orchestrator)', () => {
    test('logs job started and completed when there are no active journeys', async () => {
        // bulkUpdateTrackingStatus returns empty rows
        mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await runJob();

        expect(mockLogger.info).toHaveBeenCalledWith('updateTrackingStatus: job started');
        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: bulk update complete',
            { totalActive: 0, lostCount: 0, weakCount: 0 }
        );
        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 0, notificationsSent: 0 }
        );
    });

    test('logs error and returns early when bulkUpdateTrackingStatus throws', async () => {
        const dbError = new Error('DB connection refused');
        mockPoolQuery.mockRejectedValueOnce(dbError);

        await runJob();

        expect(mockLogger.error).toHaveBeenCalledWith(
            'updateTrackingStatus: job failed',
            expect.objectContaining({ error: 'DB connection refused' })
        );
        // Should not log "job completed" because we returned early
        const completedCalls = mockLogger.info.mock.calls.filter(
            args => args[0] === 'updateTrackingStatus: job completed'
        );
        expect(completedCalls).toHaveLength(0);
    });

    test('tallies flagsInserted correctly across multiple WEAK journeys', async () => {
        const weakJourneys = [
            { journey_id: 'j-weak-1', school_id: 's-1', bus_id: 'b-1', tracking_status: 'WEAK', last_signal_at: null },
            { journey_id: 'j-weak-2', school_id: 's-1', bus_id: 'b-2', tracking_status: 'WEAK', last_signal_at: null },
        ];
        mockPoolQuery.mockResolvedValueOnce({ rows: weakJourneys, rowCount: 2 });

        // For each processWeakJourney: no existing flag → insert
        // client query sequence per journey: hasUnresolvedFlag(→0), BEGIN, insertFlag, COMMIT
        for (let i = 0; i < 2; i++) {
            const client = buildMockClient([
                { rows: [], rowCount: 0 }, // hasUnresolvedFlag -> false
                { rows: [], rowCount: 0 }, // BEGIN
                { rows: [], rowCount: 1 }, // insertFlag
                { rows: [], rowCount: 0 }, // COMMIT
            ]);
            mockConnect.mockResolvedValueOnce(client);
        }

        await runJob();

        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 2, notificationsSent: 0 }
        );
    });

    test('tallies flagsInserted and notificationsSent for LOST journeys with admin', async () => {
        const lastSignalAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const lostJourney = {
            journey_id: 'j-lost-1',
            school_id:  's-1',
            bus_id:     'b-1',
            tracking_status: 'LOST',
            last_signal_at:  lastSignalAt,
        };
        mockPoolQuery.mockResolvedValueOnce({ rows: [lostJourney], rowCount: 1 });

        const mockChannel = {
            assertQueue:  jest.fn().mockResolvedValue(undefined),
            sendToQueue:  jest.fn(),
        };
        mockGetRabbitMQChannel.mockResolvedValue(mockChannel);

        const client = buildMockClient([
            { rows: [], rowCount: 0 },                             // hasUnresolvedFlag(GPS_LOST) -> false
            { rows: [{ id: 'admin-uuid' }], rowCount: 1 },         // findSchoolAdmin
            { rows: [{ bus_number: 'BUS01', route_name: 'Rt-A' }], rowCount: 1 }, // fetchBusDetails
            { rows: [], rowCount: 0 },                             // BEGIN
            { rows: [], rowCount: 1 },                             // insertFlag(GPS_LOST)
            { rows: [{ id: 'notif-uuid' }], rowCount: 1 },         // insertNotification
            { rows: [], rowCount: 0 },                             // COMMIT
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await runJob();

        // Allow the fire-and-forget publishToQueue promise to settle
        await new Promise(resolve => setImmediate(resolve));

        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 1, notificationsSent: 1 }
        );
    });

    test('handles mixed WEAK and LOST journeys in parallel with Promise.allSettled', async () => {
        const weakJourney = { journey_id: 'j-w1', school_id: 's-1', bus_id: 'b-1', tracking_status: 'WEAK',  last_signal_at: null };
        const lostJourney = { journey_id: 'j-l1', school_id: 's-1', bus_id: 'b-2', tracking_status: 'LOST',  last_signal_at: null };

        mockPoolQuery.mockResolvedValueOnce({ rows: [weakJourney, lostJourney], rowCount: 2 });
        mockGetRabbitMQChannel.mockResolvedValue({
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn(),
        });

        // WEAK journey client
        const weakClient = buildMockClient([
            { rows: [], rowCount: 0 }, // hasUnresolvedFlag -> false
            { rows: [], rowCount: 0 }, // BEGIN
            { rows: [], rowCount: 1 }, // insertFlag
            { rows: [], rowCount: 0 }, // COMMIT
        ]);

        // LOST journey client
        const lostClient = buildMockClient([
            { rows: [], rowCount: 0 },                                               // hasUnresolvedFlag -> false
            { rows: [{ id: 'admin-uuid' }], rowCount: 1 },                           // findSchoolAdmin
            { rows: [{ bus_number: 'BUS02', route_name: 'Rt-B' }], rowCount: 1 },   // fetchBusDetails
            { rows: [], rowCount: 0 },                                               // BEGIN
            { rows: [], rowCount: 1 },                                               // insertFlag
            { rows: [{ id: 'notif-uuid-2' }], rowCount: 1 },                        // insertNotification
            { rows: [], rowCount: 0 },                                               // COMMIT
        ]);

        mockConnect
            .mockResolvedValueOnce(weakClient)
            .mockResolvedValueOnce(lostClient);

        await runJob();
        await new Promise(resolve => setImmediate(resolve));

        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 2, notificationsSent: 1 }
        );
    });

    test('does not count failed individual journeys in the tally', async () => {
        const lostJourney = { journey_id: 'j-fail', school_id: 's-x', bus_id: 'b-x', tracking_status: 'LOST', last_signal_at: null };
        mockPoolQuery.mockResolvedValueOnce({ rows: [lostJourney], rowCount: 1 });

        // Simulate pool.connect() throwing
        mockConnect.mockRejectedValueOnce(new Error('pool exhausted'));

        await runJob();

        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 0, notificationsSent: 0 }
        );
    });
});

// ===========================================================================
// describe: processWeakJourney (exercised via orchestrator)
// ===========================================================================
describe('processWeakJourney', () => {
    const weakJourney = {
        journey_id: 'j-weak-abc',
        school_id:  's-school-1',
        bus_id:     'b-bus-1',
        tracking_status: 'WEAK',
        last_signal_at:  null,
    };

    function setupBulkUpdate(journeys) {
        mockPoolQuery.mockResolvedValueOnce({ rows: journeys, rowCount: journeys.length });
    }

    test('returns flagInserted:false when GPS_WEAK flag already exists (duplicate guard)', async () => {
        setupBulkUpdate([weakJourney]);

        const client = buildMockClient([
            { rows: [{ '?column?': 1 }], rowCount: 1 }, // hasUnresolvedFlag -> true (flag exists)
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await runJob();

        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 0, notificationsSent: 0 }
        );
        // Should not have issued BEGIN
        const beginCalls = client.query.mock.calls.filter(args => args[0] === 'BEGIN');
        expect(beginCalls).toHaveLength(0);
    });

    test('inserts GPS_WEAK flag in a transaction when none exists', async () => {
        setupBulkUpdate([weakJourney]);

        const client = buildMockClient([
            { rows: [], rowCount: 0 }, // hasUnresolvedFlag -> false
            { rows: [], rowCount: 0 }, // BEGIN
            { rows: [], rowCount: 1 }, // insertFlag
            { rows: [], rowCount: 0 }, // COMMIT
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await runJob();

        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 1, notificationsSent: 0 }
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'updateTrackingStatus: GPS_WEAK detected',
            expect.objectContaining({ journeyId: 'j-weak-abc' })
        );
        // Verify transaction lifecycle
        const queryCalls = client.query.mock.calls.map(c => c[0]);
        expect(queryCalls).toContain('BEGIN');
        expect(queryCalls).toContain('COMMIT');
    });

    test('rolls back and returns flagInserted:false when insertFlag throws', async () => {
        setupBulkUpdate([weakJourney]);

        const client = buildMockClient([
            { rows: [], rowCount: 0 }, // hasUnresolvedFlag -> false
            { rows: [], rowCount: 0 }, // BEGIN
        ]);
        // Make insertFlag (3rd call) throw
        client.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // hasUnresolvedFlag
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
            .mockRejectedValueOnce(new Error('insert failed'))  // insertFlag throws
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
        mockConnect.mockResolvedValueOnce(client);

        await runJob();

        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 0, notificationsSent: 0 }
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
            'updateTrackingStatus: error processing journey',
            expect.objectContaining({ journeyId: 'j-weak-abc', error: 'insert failed' })
        );
        const queryCalls = client.query.mock.calls.map(c => c[0]);
        expect(queryCalls).toContain('ROLLBACK');
    });

    test('releases client even when an exception occurs during pool.connect', async () => {
        setupBulkUpdate([weakJourney]);

        const connectError = new Error('timeout acquiring client');
        mockConnect.mockRejectedValueOnce(connectError);

        await runJob();

        // Client was never acquired so release cannot be called,
        // but the orchestrator should still complete without throwing.
        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 0, notificationsSent: 0 }
        );
    });
});

// ===========================================================================
// describe: processLostJourney (exercised via orchestrator)
// ===========================================================================
describe('processLostJourney', () => {
    const lostJourney = {
        journey_id:      'j-lost-xyz',
        school_id:       's-school-2',
        bus_id:          'b-bus-2',
        tracking_status: 'LOST',
        last_signal_at:  null,
    };

    function setupBulkUpdate(journeys) {
        mockPoolQuery.mockResolvedValueOnce({ rows: journeys, rowCount: journeys.length });
    }

    test('returns flagInserted:false when GPS_LOST flag already exists (duplicate guard)', async () => {
        setupBulkUpdate([lostJourney]);

        const client = buildMockClient([
            { rows: [{ '?column?': 1 }], rowCount: 1 }, // hasUnresolvedFlag -> true
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await runJob();

        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 0, notificationsSent: 0 }
        );
    });

    test('inserts GPS_LOST flag only (no notification) when no school admin found', async () => {
        setupBulkUpdate([lostJourney]);

        const client = buildMockClient([
            { rows: [], rowCount: 0 },                                             // hasUnresolvedFlag -> false
            { rows: [], rowCount: 0 },                                             // findSchoolAdmin -> null
            { rows: [{ bus_number: 'BUS99', route_name: 'Rt-Z' }], rowCount: 1 }, // fetchBusDetails
            { rows: [], rowCount: 0 },                                             // BEGIN
            { rows: [], rowCount: 1 },                                             // insertFlag
            { rows: [], rowCount: 0 },                                             // COMMIT
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await runJob();

        expect(mockLogger.warn).toHaveBeenCalledWith(
            'updateTrackingStatus: no active School Admin found',
            expect.objectContaining({ schoolId: 's-school-2' })
        );
        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 1, notificationsSent: 0 }
        );
    });

    test('inserts GPS_LOST flag and sends notification when admin exists', async () => {
        const lastSignalAt = new Date(Date.now() - 8 * 60 * 1000).toISOString();
        const journeyWithSignal = { ...lostJourney, last_signal_at: lastSignalAt };
        setupBulkUpdate([journeyWithSignal]);

        const mockChannel = {
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn(),
        };
        mockGetRabbitMQChannel.mockResolvedValue(mockChannel);

        const client = buildMockClient([
            { rows: [], rowCount: 0 },                                             // hasUnresolvedFlag -> false
            { rows: [{ id: 'admin-id-001' }], rowCount: 1 },                       // findSchoolAdmin
            { rows: [{ bus_number: 'BUS42', route_name: 'Route X' }], rowCount: 1 }, // fetchBusDetails
            { rows: [], rowCount: 0 },                                             // BEGIN
            { rows: [], rowCount: 1 },                                             // insertFlag
            { rows: [{ id: 'notif-id-999' }], rowCount: 1 },                      // insertNotification
            { rows: [], rowCount: 0 },                                             // COMMIT
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await runJob();
        await new Promise(resolve => setImmediate(resolve));

        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 1, notificationsSent: 1 }
        );

        // Verify RabbitMQ publish
        expect(mockGetRabbitMQChannel).toHaveBeenCalledTimes(1);
        expect(mockChannel.assertQueue).toHaveBeenCalledWith('bustrack.notifications', { durable: true });
        expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
            'bustrack.notifications',
            expect.any(Buffer),
            { persistent: true }
        );

        // Verify the queued payload contains the notification id
        const sentBuffer = mockChannel.sendToQueue.mock.calls[0][1];
        const sentPayload = JSON.parse(sentBuffer.toString());
        expect(sentPayload).toEqual({ notification_id: 'notif-id-999' });
    });

    test('uses Unknown fallback when fetchBusDetails returns no rows', async () => {
        setupBulkUpdate([lostJourney]);

        const mockChannel = {
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn(),
        };
        mockGetRabbitMQChannel.mockResolvedValue(mockChannel);

        const client = buildMockClient([
            { rows: [], rowCount: 0 },                      // hasUnresolvedFlag -> false
            { rows: [{ id: 'admin-id-002' }], rowCount: 1 }, // findSchoolAdmin
            { rows: [], rowCount: 0 },                      // fetchBusDetails -> no rows → fallback
            { rows: [], rowCount: 0 },                      // BEGIN
            { rows: [], rowCount: 1 },                      // insertFlag
            { rows: [{ id: 'notif-id-fallback' }], rowCount: 1 }, // insertNotification
            { rows: [], rowCount: 0 },                      // COMMIT
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await runJob();
        await new Promise(resolve => setImmediate(resolve));

        // Notification body should use 'Unknown' bus number
        const insertNotifCall = client.query.mock.calls.find(
            args => typeof args[0] === 'string' && args[0].includes('TRACKING_LOST_ALERT')
        );
        expect(insertNotifCall).toBeDefined();
        const notifBody = insertNotifCall[1][3];
        expect(notifBody).toContain('Bus Unknown');
    });

    test('notification body says "No signal received" when lastSignalAt is null', async () => {
        setupBulkUpdate([lostJourney]); // lostJourney.last_signal_at is null

        const mockChannel = {
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn(),
        };
        mockGetRabbitMQChannel.mockResolvedValue(mockChannel);

        const client = buildMockClient([
            { rows: [], rowCount: 0 },
            { rows: [{ id: 'admin-id-003' }], rowCount: 1 },
            { rows: [{ bus_number: 'BUS77', route_name: 'Rt-C' }], rowCount: 1 },
            { rows: [], rowCount: 0 },
            { rows: [], rowCount: 1 },
            { rows: [{ id: 'notif-id-null' }], rowCount: 1 },
            { rows: [], rowCount: 0 },
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await runJob();

        const insertNotifCall = client.query.mock.calls.find(
            args => typeof args[0] === 'string' && args[0].includes('TRACKING_LOST_ALERT')
        );
        const notifBody = insertNotifCall[1][3];
        expect(notifBody).toBe('GPS signal lost for Bus BUS77. No signal received.');
    });

    test('notification body includes "minutes ago" when lastSignalAt is set', async () => {
        const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const journeyWithSignal = { ...lostJourney, last_signal_at: tenMinsAgo };
        setupBulkUpdate([journeyWithSignal]);

        const mockChannel = {
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn(),
        };
        mockGetRabbitMQChannel.mockResolvedValue(mockChannel);

        const client = buildMockClient([
            { rows: [], rowCount: 0 },
            { rows: [{ id: 'admin-id-004' }], rowCount: 1 },
            { rows: [{ bus_number: 'BUS55', route_name: 'Rt-D' }], rowCount: 1 },
            { rows: [], rowCount: 0 },
            { rows: [], rowCount: 1 },
            { rows: [{ id: 'notif-id-time' }], rowCount: 1 },
            { rows: [], rowCount: 0 },
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await runJob();

        const insertNotifCall = client.query.mock.calls.find(
            args => typeof args[0] === 'string' && args[0].includes('TRACKING_LOST_ALERT')
        );
        const notifBody = insertNotifCall[1][3];
        expect(notifBody).toMatch(/GPS signal lost for Bus BUS55\. Last seen \d+ minutes ago\./);
    });

    test('rolls back transaction and returns flagInserted:false when insertFlag throws', async () => {
        setupBulkUpdate([lostJourney]);

        const client = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [], rowCount: 0 })           // hasUnresolvedFlag -> false
                .mockResolvedValueOnce({ rows: [{ id: 'admin-id' }], rowCount: 1 }) // findSchoolAdmin
                .mockResolvedValueOnce({ rows: [{ bus_number: 'B1', route_name: 'R1' }], rowCount: 1 }) // fetchBusDetails
                .mockResolvedValueOnce({ rows: [], rowCount: 0 })           // BEGIN
                .mockRejectedValueOnce(new Error('constraint violation'))   // insertFlag throws
                .mockResolvedValueOnce({ rows: [], rowCount: 0 }),          // ROLLBACK
            release: jest.fn(),
        };
        mockConnect.mockResolvedValueOnce(client);

        await runJob();

        expect(mockLogger.error).toHaveBeenCalledWith(
            'updateTrackingStatus: error processing journey',
            expect.objectContaining({ error: 'constraint violation' })
        );
        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 0, notificationsSent: 0 }
        );
        const queryCalls = client.query.mock.calls.map(c => c[0]);
        expect(queryCalls).toContain('ROLLBACK');
    });

    test('releases client in the finally block after an error', async () => {
        setupBulkUpdate([lostJourney]);

        const client = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // hasUnresolvedFlag
                .mockRejectedValueOnce(new Error('admin query failed')), // findSchoolAdmin
            release: jest.fn(),
        };
        mockConnect.mockResolvedValueOnce(client);

        await runJob();

        expect(client.release).toHaveBeenCalledTimes(1);
    });

    test('notification meta contains expected fields', async () => {
        const lastSignalAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
        const journeyMeta = { ...lostJourney, last_signal_at: lastSignalAt };
        setupBulkUpdate([journeyMeta]);

        const mockChannel = {
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn(),
        };
        mockGetRabbitMQChannel.mockResolvedValue(mockChannel);

        const client = buildMockClient([
            { rows: [], rowCount: 0 },
            { rows: [{ id: 'admin-meta' }], rowCount: 1 },
            { rows: [{ bus_number: 'BUS-META', route_name: 'Meta-Route' }], rowCount: 1 },
            { rows: [], rowCount: 0 },
            { rows: [], rowCount: 1 },
            { rows: [{ id: 'notif-meta' }], rowCount: 1 },
            { rows: [], rowCount: 0 },
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await runJob();

        const insertNotifCall = client.query.mock.calls.find(
            args => typeof args[0] === 'string' && args[0].includes('TRACKING_LOST_ALERT')
        );
        const metaArg = insertNotifCall[1][4]; // 5th param: JSON.stringify(meta)
        const meta = JSON.parse(metaArg);

        expect(meta).toMatchObject({
            journey_id:     'j-lost-xyz',
            bus_id:         'b-bus-2',
            bus_number:     'BUS-META',
            route_name:     'Meta-Route',
            last_signal_at: lastSignalAt,
        });
    });
});

// ===========================================================================
// describe: publishToQueue (exercised via processLostJourney)
// ===========================================================================
describe('publishToQueue', () => {
    const lostJourney = {
        journey_id:      'j-pub-1',
        school_id:       's-pub-1',
        bus_id:          'b-pub-1',
        tracking_status: 'LOST',
        last_signal_at:  null,
    };

    function setupClientForPublish(notifId) {
        return {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [], rowCount: 0 })
                .mockResolvedValueOnce({ rows: [{ id: 'admin-pub' }], rowCount: 1 })
                .mockResolvedValueOnce({ rows: [{ bus_number: 'BPUB', route_name: 'R-PUB' }], rowCount: 1 })
                .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
                .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // insertFlag
                .mockResolvedValueOnce({ rows: [{ id: notifId }], rowCount: 1 }) // insertNotification
                .mockResolvedValueOnce({ rows: [], rowCount: 0 }), // COMMIT
            release: jest.fn(),
        };
    }

    test('calls assertQueue and sendToQueue on the RabbitMQ channel', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [lostJourney], rowCount: 1 });

        const mockChannel = {
            assertQueue: jest.fn().mockResolvedValue(undefined),
            sendToQueue: jest.fn(),
        };
        mockGetRabbitMQChannel.mockResolvedValue(mockChannel);

        const client = setupClientForPublish('pub-notif-001');
        mockConnect.mockResolvedValueOnce(client);

        await runJob();
        await new Promise(resolve => setImmediate(resolve));

        expect(mockChannel.assertQueue).toHaveBeenCalledWith('bustrack.notifications', { durable: true });
        expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
            'bustrack.notifications',
            expect.any(Buffer),
            { persistent: true }
        );
    });

    test('logs error but does not throw when getRabbitMQChannel rejects (fire-and-forget)', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [lostJourney], rowCount: 1 });

        mockGetRabbitMQChannel.mockRejectedValue(new Error('RabbitMQ unreachable'));

        const client = setupClientForPublish('pub-notif-002');
        mockConnect.mockResolvedValueOnce(client);

        await runJob();
        await new Promise(resolve => setImmediate(resolve));

        // The job should still complete successfully
        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: job completed',
            { flagsInserted: 1, notificationsSent: 1 }
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
            'updateTrackingStatus: RabbitMQ publish failed',
            expect.objectContaining({ error: 'RabbitMQ unreachable', notificationId: 'pub-notif-002' })
        );
    });

    test('logs error when assertQueue throws (fire-and-forget)', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [lostJourney], rowCount: 1 });

        const mockChannel = {
            assertQueue: jest.fn().mockRejectedValue(new Error('channel closed')),
            sendToQueue: jest.fn(),
        };
        mockGetRabbitMQChannel.mockResolvedValue(mockChannel);

        const client = setupClientForPublish('pub-notif-003');
        mockConnect.mockResolvedValueOnce(client);

        await runJob();
        await new Promise(resolve => setImmediate(resolve));

        expect(mockLogger.error).toHaveBeenCalledWith(
            'updateTrackingStatus: RabbitMQ publish failed',
            expect.objectContaining({ error: 'channel closed' })
        );
        // sendToQueue should not have been called
        expect(mockChannel.sendToQueue).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// describe: bulkUpdateTrackingStatus (exercised via orchestrator)
// ===========================================================================
describe('bulkUpdateTrackingStatus', () => {
    test('returns empty array when no journeys are active', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        await runJob();

        expect(mockPoolQuery).toHaveBeenCalledTimes(1);
        expect(mockPoolQuery.mock.calls[0][0]).toContain('UPDATE journeys');
        expect(mockPoolQuery.mock.calls[0][0]).toContain("status IN ('PICKUP_STARTED', 'DROP_STARTED')");
    });

    test('correctly filters WEAK and LOST journeys from bulk update rows', async () => {
        const rows = [
            { journey_id: 'j1', tracking_status: 'ACTIVE', school_id: 's1', bus_id: 'b1', last_signal_at: new Date().toISOString() },
            { journey_id: 'j2', tracking_status: 'WEAK',   school_id: 's1', bus_id: 'b2', last_signal_at: null },
            { journey_id: 'j3', tracking_status: 'LOST',   school_id: 's1', bus_id: 'b3', last_signal_at: null },
        ];
        mockPoolQuery.mockResolvedValueOnce({ rows, rowCount: 3 });

        // Only WEAK and LOST trigger pool.connect; ACTIVE rows are skipped
        const weakClient = buildMockClient([
            { rows: [], rowCount: 0 }, // hasUnresolvedFlag -> false
            { rows: [], rowCount: 0 }, // BEGIN
            { rows: [], rowCount: 1 }, // insertFlag
            { rows: [], rowCount: 0 }, // COMMIT
        ]);
        const lostClient = buildMockClient([
            { rows: [], rowCount: 0 },
            { rows: [], rowCount: 0 },           // findSchoolAdmin -> no admin
            { rows: [], rowCount: 0 },           // fetchBusDetails -> fallback
            { rows: [], rowCount: 0 },           // BEGIN
            { rows: [], rowCount: 1 },           // insertFlag
            { rows: [], rowCount: 0 },           // COMMIT
        ]);

        mockConnect
            .mockResolvedValueOnce(weakClient)
            .mockResolvedValueOnce(lostClient);

        await runJob();

        // ACTIVE journey skipped → pool.connect called exactly twice
        expect(mockConnect).toHaveBeenCalledTimes(2);

        expect(mockLogger.info).toHaveBeenCalledWith(
            'updateTrackingStatus: bulk update complete',
            { totalActive: 3, lostCount: 1, weakCount: 1 }
        );
    });
});