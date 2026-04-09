// =============================================================================
// src/modules/buses/buses.controller.js
// Controller for Bus, Route, Stop, and Student Assignment management
//
// All endpoints are School Admin only, scoped to their own school.
// Covers: bus CRUD, deactivate/reactivate, route management with ordered stops,
// stop CRUD + reorder, and student assignment/unassignment.
// =============================================================================

const pool = require('../../config/db');
const { success, error } = require('../../utils/response');
const { parsePagination, paginationMeta } = require('../../utils/pagination');
const logger = require('../../config/logger');

// Regex for UUID v1–v5 validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(id) {
    return typeof id === 'string' && UUID_REGEX.test(id);
}

// HH:MM 24-hour time format validation
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTime(t) {
    return typeof t === 'string' && TIME_REGEX.test(t);
}

// =============================================================================
//                              BUS ENDPOINTS
// =============================================================================

// =============================================================================
// createBus
// POST /api/buses
//
// Creates a new bus for the school.
// Body: { bus_number, capacity? }
// - bus_number required; capacity defaults to 40
// - Checks UNIQUE(school_id, bus_number) — 409 if duplicate
// =============================================================================
async function createBus(req, res) {
    try {
        const schoolId = req.schoolId;
        const { bus_number, capacity } = req.body;

        // --- Validation ---
        if (!bus_number || !String(bus_number).trim()) {
            return error(res, 'Bus number is required', 400);
        }

        const trimmedBusNumber = String(bus_number).trim();
        const busCapacity = capacity !== undefined && capacity !== null
            ? parseInt(capacity, 10)
            : 40;

        if (isNaN(busCapacity) || busCapacity <= 0) {
            return error(res, 'Capacity must be a positive integer', 400);
        }

        // --- Check duplicate bus_number within school ---
        const dupCheck = await pool.query(
            `SELECT id FROM buses WHERE school_id = $1 AND bus_number = $2`,
            [schoolId, trimmedBusNumber]
        );

        if (dupCheck.rowCount > 0) {
            return error(res, `Bus number '${trimmedBusNumber}' already exists in this school`, 409);
        }

        // --- Insert ---
        const result = await pool.query(
            `INSERT INTO buses (school_id, bus_number, capacity, is_active, created_at, updated_at)
             VALUES ($1, $2, $3, TRUE, NOW(), NOW())
             RETURNING id, school_id, bus_number, capacity, is_active, created_at, updated_at`,
            [schoolId, trimmedBusNumber, busCapacity]
        );

        return success(res, { bus: result.rows[0] }, 'Bus created successfully', 201);

    } catch (err) {
        logger.error('createBus error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to create bus', 500, err.message);
    }
}

// =============================================================================
// listBuses
// GET /api/buses
//
// Returns a paginated list of buses for the school.
// Query: ?page&limit&search&status=active|inactive|all
// - search: ILIKE on bus_number
// - Each row includes route info, student count, available seats, seat_status
// =============================================================================
async function listBuses(req, res) {
    try {
        const schoolId = req.schoolId;
        const { limit, offset, page } = parsePagination(req.query);
        const search = req.query.search ? String(req.query.search).trim() : '';
        const status = req.query.status ? String(req.query.status).trim().toLowerCase() : 'all';

        const conditions = [`b.school_id = $1`];
        const params = [schoolId];
        let paramIndex = 2;

        // Status filter
        if (status === 'active') {
            conditions.push(`b.is_active = TRUE`);
        } else if (status === 'inactive') {
            conditions.push(`b.is_active = FALSE`);
        }

        // Search filter
        if (search) {
            conditions.push(`b.bus_number ILIKE $${paramIndex}`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        // Count
        const countResult = await pool.query(
            `SELECT COUNT(*) AS total FROM buses b ${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].total, 10);

        // Fetch with LEFT JOINs for route, driver, and student count
        const dataResult = await pool.query(
            `SELECT
                b.id, b.bus_number, b.capacity, b.is_active, b.created_at,
                br.route_name,
                br.scheduled_departure,
                d.name AS default_driver_name,
                COALESCE(sc.student_count, 0)::int AS student_count,
                (b.capacity - COALESCE(sc.student_count, 0))::int AS available_seats
             FROM buses b
             LEFT JOIN bus_routes br
               ON br.bus_id = b.id AND br.is_active = TRUE
             LEFT JOIN users d
               ON d.id = br.default_driver_id
             LEFT JOIN (
                 SELECT bus_id, COUNT(*) AS student_count
                 FROM student_bus_assignments
                 WHERE is_current = TRUE
                 GROUP BY bus_id
             ) sc ON sc.bus_id = b.id
             ${whereClause}
             ORDER BY b.bus_number ASC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...params, limit, offset]
        );

        // Compute seat_status for each row
        const buses = dataResult.rows.map(row => {
            let seatStatus;
            if (row.student_count >= row.capacity) {
                seatStatus = 'FULL';
            } else if (row.student_count >= row.capacity * 0.9) {
                seatStatus = 'ALMOST_FULL';
            } else {
                seatStatus = 'AVAILABLE';
            }
            return { ...row, seat_status: seatStatus };
        });

        return success(res, {
            buses,
            pagination: paginationMeta(total, limit, page),
        }, 'Buses retrieved successfully');

    } catch (err) {
        logger.error('listBuses error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to retrieve buses', 500, err.message);
    }
}

// =============================================================================
// getBus
// GET /api/buses/:busId
//
// Fetches a single bus with:
//   1. Bus details
//   2. Active route with default driver
//   3. Route stops ordered by sequence, each with assigned students
//   4. Currently assigned students list
// =============================================================================
async function getBus(req, res) {
    try {
        const { busId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            return error(res, 'Invalid bus ID format', 400);
        }

        // Fetch bus
        const busResult = await pool.query(
            `SELECT id, school_id, bus_number, capacity, is_active, created_at, updated_at
             FROM buses
             WHERE id = $1 AND school_id = $2`,
            [busId, schoolId]
        );

        if (busResult.rowCount === 0) {
            return error(res, 'Bus not found', 404);
        }

        const bus = busResult.rows[0];

        // Fetch active route with default driver
        const routeResult = await pool.query(
            `SELECT br.id, br.route_name, br.scheduled_departure, br.is_active,
                    br.default_driver_id, d.name AS default_driver_name,
                    br.created_at, br.updated_at
             FROM bus_routes br
             LEFT JOIN users d ON d.id = br.default_driver_id
             WHERE br.bus_id = $1 AND br.school_id = $2 AND br.is_active = TRUE`,
            [busId, schoolId]
        );

        let activeRoute = null;

        if (routeResult.rowCount > 0) {
            activeRoute = routeResult.rows[0];

            // Fetch stops ordered by sequence
            const stopsResult = await pool.query(
                `SELECT id, stop_name, stop_sequence, lat, lng, created_at, updated_at
                 FROM route_stops
                 WHERE route_id = $1
                 ORDER BY stop_sequence ASC`,
                [activeRoute.id]
            );

            // For each stop, fetch assigned students
            const stops = [];
            for (const stop of stopsResult.rows) {
                const stopStudents = await pool.query(
                    `SELECT s.id, s.name, s.class, s.section, s.roll_no
                     FROM stop_students ss
                     JOIN students s ON s.id = ss.student_id
                     WHERE ss.stop_id = $1`,
                    [stop.id]
                );
                stops.push({ ...stop, students: stopStudents.rows });
            }

            activeRoute.stops = stops;
        }

        // Fetch currently assigned students
        const studentsResult = await pool.query(
            `SELECT s.id, s.name, s.class, s.section, s.roll_no
             FROM student_bus_assignments sba
             JOIN students s ON s.id = sba.student_id
             WHERE sba.bus_id = $1 AND sba.is_current = TRUE
             ORDER BY s.class ASC, s.section ASC, s.roll_no ASC`,
            [busId]
        );

        return success(res, {
            bus: {
                ...bus,
                active_route: activeRoute,
                assigned_students: {
                    count: studentsResult.rowCount,
                    students: studentsResult.rows,
                },
            },
        }, 'Bus retrieved successfully');

    } catch (err) {
        logger.error('getBus error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to retrieve bus', 500, err.message);
    }
}

// =============================================================================
// updateBus
// PATCH /api/buses/:busId
//
// Updates bus details.
// Body: { bus_number?, capacity? }
// - Checks bus_number uniqueness if changed — 409 if conflict
// =============================================================================
async function updateBus(req, res) {
    try {
        const { busId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            return error(res, 'Invalid bus ID format', 400);
        }

        const { bus_number, capacity } = req.body;

        const hasBusNumber = bus_number !== undefined && bus_number !== null;
        const hasCapacity = capacity !== undefined && capacity !== null;

        if (!hasBusNumber && !hasCapacity) {
            return error(res, 'At least one field (bus_number, capacity) must be provided', 400);
        }

        // Check existence
        const existing = await pool.query(
            `SELECT id FROM buses WHERE id = $1 AND school_id = $2`,
            [busId, schoolId]
        );
        if (existing.rowCount === 0) {
            return error(res, 'Bus not found', 404);
        }

        // Validate capacity if provided
        if (hasCapacity) {
            const parsedCapacity = parseInt(capacity, 10);
            if (isNaN(parsedCapacity) || parsedCapacity <= 0) {
                return error(res, 'Capacity must be a positive integer', 400);
            }
        }

        // Check bus_number uniqueness if being changed
        if (hasBusNumber) {
            const trimmedBusNumber = String(bus_number).trim();
            if (!trimmedBusNumber) {
                return error(res, 'Bus number cannot be empty', 400);
            }
            const dupCheck = await pool.query(
                `SELECT id FROM buses WHERE school_id = $1 AND bus_number = $2 AND id != $3`,
                [schoolId, trimmedBusNumber, busId]
            );
            if (dupCheck.rowCount > 0) {
                return error(res, `Bus number '${trimmedBusNumber}' already exists in this school`, 409);
            }
        }

        // Build dynamic SET
        const setClauses = [];
        const params = [];
        let paramIndex = 1;

        if (hasBusNumber) {
            setClauses.push(`bus_number = $${paramIndex++}`);
            params.push(String(bus_number).trim());
        }
        if (hasCapacity) {
            setClauses.push(`capacity = $${paramIndex++}`);
            params.push(parseInt(capacity, 10));
        }

        setClauses.push(`updated_at = NOW()`);
        params.push(busId);
        params.push(schoolId);

        const result = await pool.query(
            `UPDATE buses
             SET ${setClauses.join(', ')}
             WHERE id = $${paramIndex} AND school_id = $${paramIndex + 1}
             RETURNING id, school_id, bus_number, capacity, is_active, created_at, updated_at`,
            params
        );

        return success(res, { bus: result.rows[0] }, 'Bus updated successfully');

    } catch (err) {
        logger.error('updateBus error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to update bus', 500, err.message);
    }
}

// =============================================================================
// deactivateBus
// DELETE /api/buses/:busId/deactivate
//
// Transaction:
//   1. Set buses.is_active = FALSE
//   2. Set student_bus_assignments.is_current = FALSE where bus_id
//   3. Set bus_routes.is_active = FALSE where bus_id
// Returns 400 if already inactive, 404 if not found.
// =============================================================================
async function deactivateBus(req, res) {
    const client = await pool.connect();

    try {
        const { busId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            client.release();
            return error(res, 'Invalid bus ID format', 400);
        }

        // Check existence
        const existing = await client.query(
            `SELECT id, is_active FROM buses WHERE id = $1 AND school_id = $2`,
            [busId, schoolId]
        );

        if (existing.rowCount === 0) {
            client.release();
            return error(res, 'Bus not found', 404);
        }

        if (!existing.rows[0].is_active) {
            client.release();
            return error(res, 'Bus is already inactive', 400);
        }

        // --- Transaction ---
        await client.query('BEGIN');

        // Deactivate bus
        await client.query(
            `UPDATE buses SET is_active = FALSE, updated_at = NOW()
             WHERE id = $1 AND school_id = $2`,
            [busId, schoolId]
        );

        // Remove current student assignments
        await client.query(
            `UPDATE student_bus_assignments
             SET is_current = FALSE, effective_until = CURRENT_DATE, updated_at = NOW()
             WHERE bus_id = $1 AND is_current = TRUE`,
            [busId]
        );

        // Deactivate active route
        await client.query(
            `UPDATE bus_routes SET is_active = FALSE, updated_at = NOW()
             WHERE bus_id = $1 AND is_active = TRUE`,
            [busId]
        );

        await client.query('COMMIT');
        client.release();

        return success(res, { busId }, 'Bus deactivated successfully');

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        logger.error('deactivateBus error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to deactivate bus', 500, err.message);
    }
}

// =============================================================================
// reactivateBus
// PUT /api/buses/:busId/reactivate
//
// Sets buses.is_active = TRUE only.
// Does NOT auto-reactivate routes or student assignments.
// Returns 400 if already active, 404 if not found.
// =============================================================================
async function reactivateBus(req, res) {
    try {
        const { busId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            return error(res, 'Invalid bus ID format', 400);
        }

        const existing = await pool.query(
            `SELECT id, is_active FROM buses WHERE id = $1 AND school_id = $2`,
            [busId, schoolId]
        );

        if (existing.rowCount === 0) {
            return error(res, 'Bus not found', 404);
        }

        if (existing.rows[0].is_active) {
            return error(res, 'Bus is already active', 400);
        }

        const result = await pool.query(
            `UPDATE buses SET is_active = TRUE, updated_at = NOW()
             WHERE id = $1 AND school_id = $2
             RETURNING id, school_id, bus_number, capacity, is_active, created_at, updated_at`,
            [busId, schoolId]
        );

        return success(res, { bus: result.rows[0] }, 'Bus reactivated successfully');

    } catch (err) {
        logger.error('reactivateBus error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to reactivate bus', 500, err.message);
    }
}

// =============================================================================
//                              ROUTE ENDPOINTS
// =============================================================================

// =============================================================================
// createRoute
// POST /api/buses/:busId/route
//
// Creates a route for the given bus.
// Body: { route_name, scheduled_departure, default_driver_id? }
// - scheduled_departure format: HH:MM (24hr)
// - Only one active route per bus — 409 if exists
// - Validates driver belongs to same school with role=DRIVER if provided
// =============================================================================
async function createRoute(req, res) {
    try {
        const { busId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            return error(res, 'Invalid bus ID format', 400);
        }

        const { route_name, scheduled_departure, default_driver_id } = req.body;

        // --- Validation ---
        if (!route_name || !String(route_name).trim()) {
            return error(res, 'Route name is required', 400);
        }
        if (!scheduled_departure || !String(scheduled_departure).trim()) {
            return error(res, 'Scheduled departure time is required', 400);
        }

        const trimmedRouteName = String(route_name).trim();
        const trimmedDeparture = String(scheduled_departure).trim();

        if (!isValidTime(trimmedDeparture)) {
            return error(res, 'Scheduled departure must be in HH:MM (24-hour) format', 400);
        }

        // Check bus exists and belongs to school
        const busCheck = await pool.query(
            `SELECT id FROM buses WHERE id = $1 AND school_id = $2`,
            [busId, schoolId]
        );
        if (busCheck.rowCount === 0) {
            return error(res, 'Bus not found', 404);
        }

        // Check no active route already exists
        const routeCheck = await pool.query(
            `SELECT id FROM bus_routes WHERE bus_id = $1 AND is_active = TRUE`,
            [busId]
        );
        if (routeCheck.rowCount > 0) {
            return error(res, 'An active route already exists for this bus. Deactivate it first.', 409);
        }

        // Validate default_driver_id if provided
        let driverId = null;
        if (default_driver_id) {
            if (!isValidUUID(default_driver_id)) {
                return error(res, 'Invalid driver ID format', 400);
            }
            const driverCheck = await pool.query(
                `SELECT id FROM users
                 WHERE id = $1 AND school_id = $2 AND role = 'DRIVER' AND is_active = TRUE`,
                [default_driver_id, schoolId]
            );
            if (driverCheck.rowCount === 0) {
                return error(res, 'Driver not found in this school or is inactive', 400);
            }
            driverId = default_driver_id;
        }

        // --- Insert ---
        const result = await pool.query(
            `INSERT INTO bus_routes
                (school_id, bus_id, default_driver_id, route_name, scheduled_departure,
                 is_active, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, TRUE, NOW(), NOW())
             RETURNING id, school_id, bus_id, default_driver_id, route_name,
                       scheduled_departure, is_active, created_at, updated_at`,
            [schoolId, busId, driverId, trimmedRouteName, trimmedDeparture]
        );

        return success(res, { route: result.rows[0] }, 'Route created successfully', 201);

    } catch (err) {
        logger.error('createRoute error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to create route', 500, err.message);
    }
}

// =============================================================================
// getRoute
// GET /api/buses/:busId/route
//
// Fetches the active route for a bus, including all stops ordered by sequence.
// Each stop includes students assigned to it via stop_students.
// Returns 404 if no active route.
// =============================================================================
async function getRoute(req, res) {
    try {
        const { busId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            return error(res, 'Invalid bus ID format', 400);
        }

        // Check bus exists
        const busCheck = await pool.query(
            `SELECT id FROM buses WHERE id = $1 AND school_id = $2`,
            [busId, schoolId]
        );
        if (busCheck.rowCount === 0) {
            return error(res, 'Bus not found', 404);
        }

        // Fetch active route
        const routeResult = await pool.query(
            `SELECT br.id, br.route_name, br.scheduled_departure, br.is_active,
                    br.default_driver_id, d.name AS default_driver_name,
                    br.created_at, br.updated_at
             FROM bus_routes br
             LEFT JOIN users d ON d.id = br.default_driver_id
             WHERE br.bus_id = $1 AND br.school_id = $2 AND br.is_active = TRUE`,
            [busId, schoolId]
        );

        if (routeResult.rowCount === 0) {
            return error(res, 'No active route found for this bus', 404);
        }

        const route = routeResult.rows[0];

        // Fetch stops with students
        const stopsResult = await pool.query(
            `SELECT id, stop_name, stop_sequence, lat, lng, created_at, updated_at
             FROM route_stops
             WHERE route_id = $1
             ORDER BY stop_sequence ASC`,
            [route.id]
        );

        const stops = [];
        for (const stop of stopsResult.rows) {
            const stopStudents = await pool.query(
                `SELECT s.id, s.name, s.class, s.section, s.roll_no
                 FROM stop_students ss
                 JOIN students s ON s.id = ss.student_id
                 WHERE ss.stop_id = $1`,
                [stop.id]
            );
            stops.push({ ...stop, students: stopStudents.rows });
        }

        route.stops = stops;

        return success(res, { route }, 'Route retrieved successfully');

    } catch (err) {
        logger.error('getRoute error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to retrieve route', 500, err.message);
    }
}

// =============================================================================
// updateRoute
// PATCH /api/buses/:busId/route
//
// Updates the active route for a bus.
// Body: { route_name?, scheduled_departure?, default_driver_id? }
// - Validates scheduled_departure format if provided
// - Validates default_driver_id if provided
// =============================================================================
async function updateRoute(req, res) {
    try {
        const { busId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            return error(res, 'Invalid bus ID format', 400);
        }

        const { route_name, scheduled_departure, default_driver_id } = req.body;

        const hasRouteName = route_name !== undefined && route_name !== null;
        const hasDeparture = scheduled_departure !== undefined && scheduled_departure !== null;
        const hasDriver = default_driver_id !== undefined;

        if (!hasRouteName && !hasDeparture && !hasDriver) {
            return error(res, 'At least one field (route_name, scheduled_departure, default_driver_id) must be provided', 400);
        }

        // Find active route for this bus
        const routeCheck = await pool.query(
            `SELECT id FROM bus_routes WHERE bus_id = $1 AND school_id = $2 AND is_active = TRUE`,
            [busId, schoolId]
        );
        if (routeCheck.rowCount === 0) {
            return error(res, 'No active route found for this bus', 404);
        }

        const routeId = routeCheck.rows[0].id;

        // Validate scheduled_departure if provided
        if (hasDeparture) {
            const trimmedDep = String(scheduled_departure).trim();
            if (!isValidTime(trimmedDep)) {
                return error(res, 'Scheduled departure must be in HH:MM (24-hour) format', 400);
            }
        }

        // Validate default_driver_id if provided (null is allowed to unset)
        if (hasDriver && default_driver_id !== null) {
            if (!isValidUUID(default_driver_id)) {
                return error(res, 'Invalid driver ID format', 400);
            }
            const driverCheck = await pool.query(
                `SELECT id FROM users
                 WHERE id = $1 AND school_id = $2 AND role = 'DRIVER' AND is_active = TRUE`,
                [default_driver_id, schoolId]
            );
            if (driverCheck.rowCount === 0) {
                return error(res, 'Driver not found in this school or is inactive', 400);
            }
        }

        // Build dynamic SET
        const setClauses = [];
        const params = [];
        let paramIndex = 1;

        if (hasRouteName) {
            const trimmedName = String(route_name).trim();
            if (!trimmedName) {
                return error(res, 'Route name cannot be empty', 400);
            }
            setClauses.push(`route_name = $${paramIndex++}`);
            params.push(trimmedName);
        }
        if (hasDeparture) {
            setClauses.push(`scheduled_departure = $${paramIndex++}`);
            params.push(String(scheduled_departure).trim());
        }
        if (hasDriver) {
            setClauses.push(`default_driver_id = $${paramIndex++}`);
            params.push(default_driver_id); // can be null to unset
        }

        setClauses.push(`updated_at = NOW()`);
        params.push(routeId);

        const result = await pool.query(
            `UPDATE bus_routes
             SET ${setClauses.join(', ')}
             WHERE id = $${paramIndex}
             RETURNING id, school_id, bus_id, default_driver_id, route_name,
                       scheduled_departure, is_active, created_at, updated_at`,
            params
        );

        return success(res, { route: result.rows[0] }, 'Route updated successfully');

    } catch (err) {
        logger.error('updateRoute error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to update route', 500, err.message);
    }
}

// =============================================================================
//                              STOP ENDPOINTS
// =============================================================================

// =============================================================================
// addStop
// POST /api/buses/:busId/route/stops
//
// Adds a stop to the active route.
// Body: { stop_name, stop_sequence, lat, lng }
// - All fields required
// - lat: -90 to 90, lng: -180 to 180
// - stop_sequence: positive integer, must not conflict — 409 if taken
// =============================================================================
async function addStop(req, res) {
    try {
        const { busId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            return error(res, 'Invalid bus ID format', 400);
        }

        const { stop_name, stop_sequence, lat, lng } = req.body;

        // --- Validation ---
        if (!stop_name || !String(stop_name).trim()) {
            return error(res, 'Stop name is required', 400);
        }
        if (stop_sequence === undefined || stop_sequence === null) {
            return error(res, 'Stop sequence is required', 400);
        }
        if (lat === undefined || lat === null) {
            return error(res, 'Latitude is required', 400);
        }
        if (lng === undefined || lng === null) {
            return error(res, 'Longitude is required', 400);
        }

        const trimmedStopName = String(stop_name).trim();
        const parsedSequence = parseInt(stop_sequence, 10);
        const parsedLat = parseFloat(lat);
        const parsedLng = parseFloat(lng);

        if (isNaN(parsedSequence) || parsedSequence <= 0) {
            return error(res, 'Stop sequence must be a positive integer', 400);
        }
        if (isNaN(parsedLat) || parsedLat < -90 || parsedLat > 90) {
            return error(res, 'Latitude must be between -90 and 90', 400);
        }
        if (isNaN(parsedLng) || parsedLng < -180 || parsedLng > 180) {
            return error(res, 'Longitude must be between -180 and 180', 400);
        }

        // Find active route for this bus
        const routeCheck = await pool.query(
            `SELECT id FROM bus_routes WHERE bus_id = $1 AND school_id = $2 AND is_active = TRUE`,
            [busId, schoolId]
        );
        if (routeCheck.rowCount === 0) {
            return error(res, 'No active route found for this bus', 404);
        }

        const routeId = routeCheck.rows[0].id;

        // Check stop_sequence not already taken
        const seqCheck = await pool.query(
            `SELECT id FROM route_stops WHERE route_id = $1 AND stop_sequence = $2`,
            [routeId, parsedSequence]
        );
        if (seqCheck.rowCount > 0) {
            return error(res, `Stop sequence ${parsedSequence} is already taken in this route`, 409);
        }

        // --- Insert ---
        const result = await pool.query(
            `INSERT INTO route_stops (route_id, stop_name, stop_sequence, lat, lng, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
             RETURNING id, route_id, stop_name, stop_sequence, lat, lng, created_at, updated_at`,
            [routeId, trimmedStopName, parsedSequence, parsedLat, parsedLng]
        );

        return success(res, { stop: result.rows[0] }, 'Stop added successfully', 201);

    } catch (err) {
        logger.error('addStop error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to add stop', 500, err.message);
    }
}

// =============================================================================
// updateStop
// PATCH /api/buses/:busId/route/stops/:stopId
//
// Updates a stop on the active route.
// Body: { stop_name?, stop_sequence?, lat?, lng? }
// - At least one field required
// - If stop_sequence changing, checks for conflict — 409
// - 404 if stop not found or doesn't belong to this bus route
// =============================================================================
async function updateStop(req, res) {
    try {
        const { busId, stopId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            return error(res, 'Invalid bus ID format', 400);
        }
        if (!isValidUUID(stopId)) {
            return error(res, 'Invalid stop ID format', 400);
        }

        const { stop_name, stop_sequence, lat, lng } = req.body;

        const hasStopName = stop_name !== undefined && stop_name !== null;
        const hasSequence = stop_sequence !== undefined && stop_sequence !== null;
        const hasLat = lat !== undefined && lat !== null;
        const hasLng = lng !== undefined && lng !== null;

        if (!hasStopName && !hasSequence && !hasLat && !hasLng) {
            return error(res, 'At least one field (stop_name, stop_sequence, lat, lng) must be provided', 400);
        }

        // Find active route for this bus
        const routeCheck = await pool.query(
            `SELECT id FROM bus_routes WHERE bus_id = $1 AND school_id = $2 AND is_active = TRUE`,
            [busId, schoolId]
        );
        if (routeCheck.rowCount === 0) {
            return error(res, 'No active route found for this bus', 404);
        }

        const routeId = routeCheck.rows[0].id;

        // Check stop belongs to this route
        const stopCheck = await pool.query(
            `SELECT id FROM route_stops WHERE id = $1 AND route_id = $2`,
            [stopId, routeId]
        );
        if (stopCheck.rowCount === 0) {
            return error(res, 'Stop not found in this route', 404);
        }

        // Validate fields
        if (hasSequence) {
            const parsedSeq = parseInt(stop_sequence, 10);
            if (isNaN(parsedSeq) || parsedSeq <= 0) {
                return error(res, 'Stop sequence must be a positive integer', 400);
            }
            // Check for sequence conflict
            const seqConflict = await pool.query(
                `SELECT id FROM route_stops WHERE route_id = $1 AND stop_sequence = $2 AND id != $3`,
                [routeId, parsedSeq, stopId]
            );
            if (seqConflict.rowCount > 0) {
                return error(res, `Stop sequence ${parsedSeq} is already taken in this route`, 409);
            }
        }
        if (hasLat) {
            const parsedLat = parseFloat(lat);
            if (isNaN(parsedLat) || parsedLat < -90 || parsedLat > 90) {
                return error(res, 'Latitude must be between -90 and 90', 400);
            }
        }
        if (hasLng) {
            const parsedLng = parseFloat(lng);
            if (isNaN(parsedLng) || parsedLng < -180 || parsedLng > 180) {
                return error(res, 'Longitude must be between -180 and 180', 400);
            }
        }

        // Build dynamic SET
        const setClauses = [];
        const params = [];
        let paramIndex = 1;

        if (hasStopName) {
            const trimmed = String(stop_name).trim();
            if (!trimmed) {
                return error(res, 'Stop name cannot be empty', 400);
            }
            setClauses.push(`stop_name = $${paramIndex++}`);
            params.push(trimmed);
        }
        if (hasSequence) {
            setClauses.push(`stop_sequence = $${paramIndex++}`);
            params.push(parseInt(stop_sequence, 10));
        }
        if (hasLat) {
            setClauses.push(`lat = $${paramIndex++}`);
            params.push(parseFloat(lat));
        }
        if (hasLng) {
            setClauses.push(`lng = $${paramIndex++}`);
            params.push(parseFloat(lng));
        }

        setClauses.push(`updated_at = NOW()`);
        params.push(stopId);

        const result = await pool.query(
            `UPDATE route_stops
             SET ${setClauses.join(', ')}
             WHERE id = $${paramIndex}
             RETURNING id, route_id, stop_name, stop_sequence, lat, lng, created_at, updated_at`,
            params
        );

        return success(res, { stop: result.rows[0] }, 'Stop updated successfully');

    } catch (err) {
        logger.error('updateStop error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to update stop', 500, err.message);
    }
}

// =============================================================================
// deleteStop
// DELETE /api/buses/:busId/route/stops/:stopId
//
// Deletes a stop from the active route.
// Cascades to stop_students via ON DELETE CASCADE.
// =============================================================================
async function deleteStop(req, res) {
    try {
        const { busId, stopId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            return error(res, 'Invalid bus ID format', 400);
        }
        if (!isValidUUID(stopId)) {
            return error(res, 'Invalid stop ID format', 400);
        }

        // Find active route for this bus
        const routeCheck = await pool.query(
            `SELECT id FROM bus_routes WHERE bus_id = $1 AND school_id = $2 AND is_active = TRUE`,
            [busId, schoolId]
        );
        if (routeCheck.rowCount === 0) {
            return error(res, 'No active route found for this bus', 404);
        }

        const routeId = routeCheck.rows[0].id;

        // Delete stop (validates it belongs to this route)
        const deleteResult = await pool.query(
            `DELETE FROM route_stops WHERE id = $1 AND route_id = $2`,
            [stopId, routeId]
        );

        if (deleteResult.rowCount === 0) {
            return error(res, 'Stop not found in this route', 404);
        }

        return success(res, {}, 'Stop deleted successfully');

    } catch (err) {
        logger.error('deleteStop error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to delete stop', 500, err.message);
    }
}

// =============================================================================
// reorderStops
// PUT /api/buses/:busId/route/stops/reorder
//
// Reorders all stops in the active route.
// Body: { stops: [ { id, stop_sequence }, ... ] }
// - Validates all stop IDs belong to this bus route
// - Validates no duplicate stop_sequence values
// - Updates all stops in a single transaction
// =============================================================================
async function reorderStops(req, res) {
    const client = await pool.connect();

    try {
        const { busId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            client.release();
            return error(res, 'Invalid bus ID format', 400);
        }

        const { stops } = req.body;

        if (!Array.isArray(stops) || stops.length === 0) {
            client.release();
            return error(res, 'Request body must include a non-empty "stops" array', 400);
        }

        // Validate each entry
        const sequences = new Set();
        for (let i = 0; i < stops.length; i++) {
            const entry = stops[i];
            if (!entry.id || !isValidUUID(entry.id)) {
                client.release();
                return error(res, `Invalid stop ID format at index ${i}`, 400);
            }
            if (entry.stop_sequence === undefined || entry.stop_sequence === null) {
                client.release();
                return error(res, `stop_sequence is required at index ${i}`, 400);
            }
            const seq = parseInt(entry.stop_sequence, 10);
            if (isNaN(seq) || seq <= 0) {
                client.release();
                return error(res, `stop_sequence must be a positive integer at index ${i}`, 400);
            }
            if (sequences.has(seq)) {
                client.release();
                return error(res, `Duplicate stop_sequence value: ${seq}`, 400);
            }
            sequences.add(seq);
        }

        // Find active route for this bus
        const routeCheck = await client.query(
            `SELECT id FROM bus_routes WHERE bus_id = $1 AND school_id = $2 AND is_active = TRUE`,
            [busId, schoolId]
        );
        if (routeCheck.rowCount === 0) {
            client.release();
            return error(res, 'No active route found for this bus', 404);
        }

        const routeId = routeCheck.rows[0].id;

        // Validate all stop IDs belong to this route
        const stopIds = stops.map(s => s.id);
        const validStops = await client.query(
            `SELECT id FROM route_stops WHERE route_id = $1 AND id = ANY($2)`,
            [routeId, stopIds]
        );

        if (validStops.rowCount !== stopIds.length) {
            const validIds = new Set(validStops.rows.map(r => r.id));
            const invalidIds = stopIds.filter(id => !validIds.has(id));
            client.release();
            return error(res, `Stop IDs not found in this route: ${invalidIds.join(', ')}`, 400);
        }

        // --- Transaction: update all sequences ---
        await client.query('BEGIN');

        // Temporarily set all sequences to negative to avoid unique constraint
        // violations during reorder
        await client.query(
            `UPDATE route_stops SET stop_sequence = -stop_sequence
             WHERE route_id = $1 AND id = ANY($2)`,
            [routeId, stopIds]
        );

        for (const entry of stops) {
            await client.query(
                `UPDATE route_stops SET stop_sequence = $1, updated_at = NOW()
                 WHERE id = $2 AND route_id = $3`,
                [parseInt(entry.stop_sequence, 10), entry.id, routeId]
            );
        }

        await client.query('COMMIT');

        // Fetch updated stops
        const updatedStops = await client.query(
            `SELECT id, route_id, stop_name, stop_sequence, lat, lng, created_at, updated_at
             FROM route_stops
             WHERE route_id = $1
             ORDER BY stop_sequence ASC`,
            [routeId]
        );

        client.release();

        return success(res, { stops: updatedStops.rows }, 'Stops reordered successfully');

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        logger.error('reorderStops error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to reorder stops', 500, err.message);
    }
}

// =============================================================================
//                         STUDENT ASSIGNMENT ENDPOINTS
// =============================================================================

// =============================================================================
// assignStudent
// POST /api/buses/:busId/students
//
// Assigns a student to a bus.
// Body: { student_id, stop_id? }
// - Validates student belongs to same school and is active
// - Checks student not already on another bus (is_current=TRUE) — 409
// - Checks bus capacity — 400 if full
// - If stop_id provided: validates stop belongs to bus route, inserts stop_students
// - Transaction: deactivate any existing assignment → insert new → link stop
// =============================================================================
async function assignStudent(req, res) {
    const client = await pool.connect();

    try {
        const { busId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            client.release();
            return error(res, 'Invalid bus ID format', 400);
        }

        const { student_id, stop_id } = req.body;

        if (!student_id || !isValidUUID(student_id)) {
            client.release();
            return error(res, 'Valid student_id is required', 400);
        }

        if (stop_id && !isValidUUID(stop_id)) {
            client.release();
            return error(res, 'Invalid stop_id format', 400);
        }

        // --- Validate bus exists and belongs to school ---
        const busCheck = await client.query(
            `SELECT id, capacity FROM buses WHERE id = $1 AND school_id = $2 AND is_active = TRUE`,
            [busId, schoolId]
        );
        if (busCheck.rowCount === 0) {
            client.release();
            return error(res, 'Bus not found or inactive', 404);
        }

        const busCapacity = busCheck.rows[0].capacity;

        // --- Validate student exists in same school and is active ---
        const studentCheck = await client.query(
            `SELECT id, name FROM students
             WHERE id = $1 AND school_id = $2 AND is_active = TRUE`,
            [student_id, schoolId]
        );
        if (studentCheck.rowCount === 0) {
            client.release();
            return error(res, 'Student not found in this school or is inactive', 404);
        }

        // --- Check student not already assigned to any bus ---
        const existingAssignment = await client.query(
            `SELECT id, bus_id FROM student_bus_assignments
             WHERE student_id = $1 AND is_current = TRUE`,
            [student_id]
        );
        if (existingAssignment.rowCount > 0) {
            client.release();
            return error(
                res,
                'Student is already assigned to a bus. Unassign them first.',
                409
            );
        }

        // --- Check bus capacity ---
        const countResult = await client.query(
            `SELECT COUNT(*) AS cnt FROM student_bus_assignments
             WHERE bus_id = $1 AND is_current = TRUE`,
            [busId]
        );
        const currentCount = parseInt(countResult.rows[0].cnt, 10);
        if (currentCount >= busCapacity) {
            client.release();
            return error(res, 'Bus is at full capacity. Cannot assign more students.', 400);
        }

        // --- Validate stop_id if provided ---
        if (stop_id) {
            const routeCheck = await client.query(
                `SELECT br.id AS route_id
                 FROM bus_routes br
                 WHERE br.bus_id = $1 AND br.school_id = $2 AND br.is_active = TRUE`,
                [busId, schoolId]
            );
            if (routeCheck.rowCount === 0) {
                client.release();
                return error(res, 'No active route found for this bus. Cannot assign to a stop.', 400);
            }

            const routeId = routeCheck.rows[0].route_id;
            const stopCheck = await client.query(
                `SELECT id FROM route_stops WHERE id = $1 AND route_id = $2`,
                [stop_id, routeId]
            );
            if (stopCheck.rowCount === 0) {
                client.release();
                return error(res, 'Stop not found in this bus route', 400);
            }
        }

        // --- Transaction ---
        await client.query('BEGIN');

        // Safety: deactivate any stale current assignments for this student
        await client.query(
            `UPDATE student_bus_assignments
             SET is_current = FALSE, effective_until = CURRENT_DATE, updated_at = NOW()
             WHERE student_id = $1 AND is_current = TRUE`,
            [student_id]
        );

        // Insert new assignment
        const assignResult = await client.query(
            `INSERT INTO student_bus_assignments
                (school_id, student_id, bus_id, effective_from, is_current, created_at, updated_at)
             VALUES ($1, $2, $3, CURRENT_DATE, TRUE, NOW(), NOW())
             RETURNING id, school_id, student_id, bus_id, effective_from, is_current, created_at`,
            [schoolId, student_id, busId]
        );

        // Link to stop if provided
        if (stop_id) {
            await client.query(
                `INSERT INTO stop_students (stop_id, student_id)
                 VALUES ($1, $2)
                 ON CONFLICT (stop_id, student_id) DO NOTHING`,
                [stop_id, student_id]
            );
        }

        await client.query('COMMIT');
        client.release();

        return success(res, {
            assignment: assignResult.rows[0],
            student_name: studentCheck.rows[0].name,
        }, 'Student assigned to bus successfully', 201);

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        logger.error('assignStudent error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to assign student to bus', 500, err.message);
    }
}

// =============================================================================
// unassignStudent
// DELETE /api/buses/:busId/students/:studentId
//
// Unassigns a student from a bus.
// Transaction:
//   1. Set is_current=FALSE + effective_until=CURRENT_DATE on assignment
//   2. Delete from stop_students for stops belonging to this bus route
// =============================================================================
async function unassignStudent(req, res) {
    const client = await pool.connect();

    try {
        const { busId, studentId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            client.release();
            return error(res, 'Invalid bus ID format', 400);
        }
        if (!isValidUUID(studentId)) {
            client.release();
            return error(res, 'Invalid student ID format', 400);
        }

        // Check bus belongs to school
        const busCheck = await client.query(
            `SELECT id FROM buses WHERE id = $1 AND school_id = $2`,
            [busId, schoolId]
        );
        if (busCheck.rowCount === 0) {
            client.release();
            return error(res, 'Bus not found', 404);
        }

        // Check current assignment exists
        const assignCheck = await client.query(
            `SELECT id FROM student_bus_assignments
             WHERE bus_id = $1 AND student_id = $2 AND is_current = TRUE`,
            [busId, studentId]
        );
        if (assignCheck.rowCount === 0) {
            client.release();
            return error(res, 'No current assignment found for this student on this bus', 404);
        }

        // --- Transaction ---
        await client.query('BEGIN');

        // Deactivate assignment
        await client.query(
            `UPDATE student_bus_assignments
             SET is_current = FALSE, effective_until = CURRENT_DATE, updated_at = NOW()
             WHERE bus_id = $1 AND student_id = $2 AND is_current = TRUE`,
            [busId, studentId]
        );

        // Remove student from all stops on this bus route
        await client.query(
            `DELETE FROM stop_students
             WHERE student_id = $1
               AND stop_id IN (
                   SELECT rs.id FROM route_stops rs
                   JOIN bus_routes br ON br.id = rs.route_id
                   WHERE br.bus_id = $2
               )`,
            [studentId, busId]
        );

        await client.query('COMMIT');
        client.release();

        return success(res, {}, 'Student unassigned from bus successfully');

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        logger.error('unassignStudent error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to unassign student from bus', 500, err.message);
    }
}

// =============================================================================
// listBusStudents
// GET /api/buses/:busId/students
//
// Lists students currently assigned to a bus.
// Query: ?search (ILIKE on student name and roll_no)
// Each row includes the assigned stop info if any.
// =============================================================================
async function listBusStudents(req, res) {
    try {
        const { busId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(busId)) {
            return error(res, 'Invalid bus ID format', 400);
        }

        // Check bus belongs to school
        const busCheck = await pool.query(
            `SELECT id FROM buses WHERE id = $1 AND school_id = $2`,
            [busId, schoolId]
        );
        if (busCheck.rowCount === 0) {
            return error(res, 'Bus not found', 404);
        }

        const search = req.query.search ? String(req.query.search).trim() : '';

        const conditions = [
            `sba.bus_id = $1`,
            `sba.is_current = TRUE`,
        ];
        const params = [busId];
        let paramIndex = 2;

        if (search) {
            conditions.push(`(s.name ILIKE $${paramIndex} OR s.roll_no ILIKE $${paramIndex})`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        // Fetch students with optional stop info
        // LEFT JOIN through the active route's stops to find the student's stop
        const result = await pool.query(
            `SELECT s.id, s.name, s.class, s.section, s.roll_no,
                    rs.stop_name, rs.stop_sequence
             FROM student_bus_assignments sba
             JOIN students s ON s.id = sba.student_id
             LEFT JOIN bus_routes br
               ON br.bus_id = sba.bus_id AND br.is_active = TRUE
             LEFT JOIN route_stops rs
               ON rs.route_id = br.id
             LEFT JOIN stop_students ss
               ON ss.stop_id = rs.id AND ss.student_id = s.id
             ${whereClause}
             ORDER BY s.class ASC, s.section ASC, s.roll_no ASC`,
            params
        );

        return success(res, {
            total: result.rowCount,
            students: result.rows,
        }, 'Bus students retrieved successfully');

    } catch (err) {
        logger.error('listBusStudents error', { error: err.message, stack: err.stack });
        return error(res, 'Failed to retrieve bus students', 500, err.message);
    }
}

// =============================================================================
// Exports
// =============================================================================
module.exports = {
    // Bus CRUD
    createBus,
    listBuses,
    getBus,
    updateBus,
    deactivateBus,
    reactivateBus,
    // Route management
    createRoute,
    getRoute,
    updateRoute,
    // Stop management
    addStop,
    updateStop,
    deleteStop,
    reorderStops,
    // Student assignments
    assignStudent,
    unassignStudent,
    listBusStudents,
};
