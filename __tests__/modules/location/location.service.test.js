'use strict';

// =============================================================================
// __tests__/modules/location/location.service.test.js
//
// Unit tests for src/modules/location/location.service.js
//
// SCOPE: This file only covers the changes introduced in the PR, specifically
// step 5b — resolving open GPS_WEAK / GPS_LOST flags on a successful location
// update (lines 138-161 of location.service.js).
//
// The full processLocationUpdate flow is set up so we can reach step 5b.
// Calls prior to step 5b are mocked to succeed with minimal stubs.
// =============================================================================

// ---------------------------------------------------------------------------
// Mocks — declared before any require() of the module under test
// ---------------------------------------------------------------------------

const mockPoolQuery = jest.fn();
jest.mock('../../../src/config/db', () => ({ query: mockPoolQuery }));

// Firebase must be mocked before require because admin.database() is called
// at module load in location.service.js (const db = admin.database())
const mockFirebaseSet = jest.fn().mockResolvedValue(undefined);
const mockFirebaseRef = jest.fn(() => ({ set: mockFirebaseSet }));
const mockDatabase    = jest.fn(() => ({ ref: mockFirebaseRef }));
jest.mock('../../../src/config/firebase', () => ({ database: mockDatabase }));

// isValidUUID is imported from journeys.service — mock the whole module
jest.mock('../../../src/modules/journeys/journeys.service', () => ({
    isValidUUID: jest.fn(() => true),
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../../src/config/logger', () => mockLogger);

// ---------------------------------------------------------------------------
// Module under test (loaded after mocks are in place)
// ---------------------------------------------------------------------------
const { processLocationUpdate } = require('../../../src/modules/location/location.service');

// ---------------------------------------------------------------------------
// Fixed test data
// ---------------------------------------------------------------------------
const DRIVER_ID  = 'driver-uuid-001';
const SCHOOL_ID  = 'school-uuid-001';
const JOURNEY_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
const BUS_ID     = 'bus-uuid-001';

const VALID_BODY = {
    journey_id: JOURNEY_ID,
    lat:        37.7749,
    lng:        -122.4194,
    speed:      30,
};

const ACTIVE_JOURNEY = {
    id:              JOURNEY_ID,
    school_id:       SCHOOL_ID,
    bus_id:          BUS_ID,
    driver_id:       DRIVER_ID,
    status:          'PICKUP_STARTED',
    tracking_status: 'LOST',
};

const LAST_SIGNAL_AT = new Date().toISOString();

/**
 * Set up pool.query mocks for a standard happy-path run through processLocationUpdate.
 * @param {object} opts - optional overrides
 * @param {object} opts.flagUpdateResult - what step 5b's pool.query resolves to
 * @param {Error|null} opts.flagUpdateError - if set, step 5b's pool.query rejects with this
 */
function setupHappyPathMocks({ flagUpdateResult, flagUpdateError } = {}) {
    // Call 1: fetchJourneyForDriver SELECT
    mockPoolQuery.mockResolvedValueOnce({ rows: [ACTIVE_JOURNEY], rowCount: 1 });
    // Call 2: INSERT INTO location_logs
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Call 3: UPDATE journeys SET last_known_lat ... RETURNING last_signal_at
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ last_signal_at: LAST_SIGNAL_AT }], rowCount: 1 });
    // Call 4: step 5b — UPDATE journey_flags SET resolved_at ...
    if (flagUpdateError) {
        mockPoolQuery.mockRejectedValueOnce(flagUpdateError);
    } else {
        mockPoolQuery.mockResolvedValueOnce(flagUpdateResult || { rows: [], rowCount: 0 });
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
    jest.clearAllMocks();
});

// ===========================================================================
// describe: step 5b — GPS flag resolution on successful location update
// ===========================================================================
describe('processLocationUpdate — step 5b: GPS flag resolution', () => {
    test('resolves open GPS flags when location update succeeds', async () => {
        setupHappyPathMocks({ flagUpdateResult: { rows: [], rowCount: 2 } });

        const result = await processLocationUpdate(DRIVER_ID, SCHOOL_ID, VALID_BODY);

        // Overall request still succeeds
        expect(result.error).toBeUndefined();
        expect(result.data).toBeDefined();
        expect(result.data.tracking_status).toBe('ACTIVE');

        // The step 5b UPDATE must have been called
        const flagUpdateCall = mockPoolQuery.mock.calls.find(
            args =>
                typeof args[0] === 'string' &&
                args[0].includes('journey_flags') &&
                args[0].includes('resolved_at = NOW()')
        );
        expect(flagUpdateCall).toBeDefined();

        // Parameterised with the journey_id
        expect(flagUpdateCall[1][0]).toBe(JOURNEY_ID);
    });

    test('targets only GPS_WEAK and GPS_LOST flags (not other flag types)', async () => {
        setupHappyPathMocks({ flagUpdateResult: { rows: [], rowCount: 1 } });

        await processLocationUpdate(DRIVER_ID, SCHOOL_ID, VALID_BODY);

        const flagUpdateCall = mockPoolQuery.mock.calls.find(
            args =>
                typeof args[0] === 'string' &&
                args[0].includes('journey_flags') &&
                args[0].includes('resolved_at = NOW()')
        );
        const sql = flagUpdateCall[0];
        expect(sql).toContain("type IN ('GPS_WEAK', 'GPS_LOST')");
        expect(sql).toContain('resolved_at IS NULL');
    });

    test('logs info when at least one GPS flag was resolved', async () => {
        setupHappyPathMocks({ flagUpdateResult: { rows: [], rowCount: 3 } });

        await processLocationUpdate(DRIVER_ID, SCHOOL_ID, VALID_BODY);

        expect(mockLogger.info).toHaveBeenCalledWith(
            'locationService: GPS flags resolved on recovery',
            expect.objectContaining({
                journeyId:    JOURNEY_ID,
                rowsResolved: 3,
            })
        );
    });

    test('does not log info when no GPS flags were resolved (rowCount === 0)', async () => {
        setupHappyPathMocks({ flagUpdateResult: { rows: [], rowCount: 0 } });

        await processLocationUpdate(DRIVER_ID, SCHOOL_ID, VALID_BODY);

        const resolvedInfoCalls = mockLogger.info.mock.calls.filter(
            args => args[0] === 'locationService: GPS flags resolved on recovery'
        );
        expect(resolvedInfoCalls).toHaveLength(0);
    });

    test('does not block the response when the flag UPDATE throws (best-effort)', async () => {
        setupHappyPathMocks({ flagUpdateError: new Error('DB timeout on flags') });

        const result = await processLocationUpdate(DRIVER_ID, SCHOOL_ID, VALID_BODY);

        // GPS update still succeeds despite flag resolution failure
        expect(result.error).toBeUndefined();
        expect(result.data).toBeDefined();
        expect(result.data.tracking_status).toBe('ACTIVE');
    });

    test('logs a warning when the flag UPDATE throws', async () => {
        setupHappyPathMocks({ flagUpdateError: new Error('connection reset') });

        await processLocationUpdate(DRIVER_ID, SCHOOL_ID, VALID_BODY);

        expect(mockLogger.warn).toHaveBeenCalledWith(
            'locationService: failed to resolve GPS flags',
            expect.objectContaining({
                journeyId: JOURNEY_ID,
                error:     'connection reset',
            })
        );
    });

    test('still returns correct data fields after a flag resolution failure', async () => {
        setupHappyPathMocks({ flagUpdateError: new Error('something broke') });

        const result = await processLocationUpdate(DRIVER_ID, SCHOOL_ID, VALID_BODY);

        expect(result.data).toMatchObject({
            journey_id:       JOURNEY_ID,
            tracking_status:  'ACTIVE',
            last_known_lat:   VALID_BODY.lat,
            last_known_lng:   VALID_BODY.lng,
            last_signal_at:   LAST_SIGNAL_AT,
        });
    });

    test('resolves flags scoped to the correct journey_id (not other journeys)', async () => {
        setupHappyPathMocks({ flagUpdateResult: { rows: [], rowCount: 1 } });

        await processLocationUpdate(DRIVER_ID, SCHOOL_ID, VALID_BODY);

        // The WHERE clause must use the journey_id from the request
        const flagUpdateCall = mockPoolQuery.mock.calls.find(
            args =>
                typeof args[0] === 'string' &&
                args[0].includes('journey_flags') &&
                args[0].includes('resolved_at = NOW()')
        );
        expect(flagUpdateCall[1]).toEqual([JOURNEY_ID]);
    });

    test('step 5b runs after the tracking status UPDATE (correct ordering)', async () => {
        setupHappyPathMocks({ flagUpdateResult: { rows: [], rowCount: 0 } });

        await processLocationUpdate(DRIVER_ID, SCHOOL_ID, VALID_BODY);

        // Collect SQL of all pool.query calls in order
        const sqlCalls = mockPoolQuery.mock.calls.map(args => args[0]);

        const trackingUpdateIdx = sqlCalls.findIndex(
            sql => sql.includes('UPDATE journeys') && sql.includes('last_signal_at = NOW()')
        );
        const flagUpdateIdx = sqlCalls.findIndex(
            sql => sql.includes('journey_flags') && sql.includes('resolved_at = NOW()')
        );

        expect(trackingUpdateIdx).toBeGreaterThanOrEqual(0);
        expect(flagUpdateIdx).toBeGreaterThan(trackingUpdateIdx);
    });

    test('does not call flag update when journey is not found (pre-step-5b guard)', async () => {
        // fetchJourneyForDriver returns null → early 404 return
        mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await processLocationUpdate(DRIVER_ID, SCHOOL_ID, VALID_BODY);

        expect(result.error).toBe('Journey not found');
        expect(result.status).toBe(404);

        // Only 1 pool.query call (the fetchJourney one); no flag update
        expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });

    test('does not call flag update when journey status is not active', async () => {
        // Journey exists but is COMPLETED
        const completedJourney = { ...ACTIVE_JOURNEY, status: 'COMPLETED' };
        mockPoolQuery.mockResolvedValueOnce({ rows: [completedJourney], rowCount: 1 });

        const result = await processLocationUpdate(DRIVER_ID, SCHOOL_ID, VALID_BODY);

        expect(result.status).toBe(409);

        // Only 1 pool.query call; no flag update
        expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });
});