// =============================================================================
// src/modules/routes/routes.controller.js
// Controller for route-centric views, stop-student management, and driver route
//
// School Admin endpoints:
//   - List all routes across buses (route-centric view)
//   - Get full route detail with stops + students
//   - Assign/remove students to/from specific stops
//   - List students at a specific stop
//
// Driver endpoint:
//   - Fetch assigned route for today (journey lookup → fallback to default)
// =============================================================================

const pool = require('../../config/db');
const { success, error } = require('../../utils/response');
const { parsePagination, paginationMeta } = require('../../utils/pagination');

// Regex for UUID v1–v5 validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(id) {
    return typeof id === 'string' && UUID_REGEX.test(id);
}

// =============================================================================
//                         SCHOOL ADMIN ENDPOINTS
// =============================================================================

// =============================================================================
// listRoutes
// GET /api/routes
//
// Lists all routes across all buses for this school (route-centric view).
// Query: ?page&limit&search&status=active|inactive|all
// - search: ILIKE on route_name and bus_number
// - status default: active
// - Each row includes route, bus, driver, stop count, student count
// =============================================================================
async function listRoutes(req, res) {
    try {
        const schoolId = req.schoolId;
        const { limit, offset, page } = parsePagination(req.query);
        const search = req.query.search ? String(req.query.search).trim() : '';
        const status = req.query.status ? String(req.query.status).trim().toLowerCase() : 'active';

        const conditions = [`br.school_id = $1`];
        const params = [schoolId];
        let paramIndex = 2;

        // Status filter (default: active)
        if (status === 'active') {
            conditions.push(`br.is_active = TRUE`);
        } else if (status === 'inactive') {
            conditions.push(`br.is_active = FALSE`);
        }
        // 'all' — no status filter

        // Search filter (ILIKE on route_name and bus_number)
        if (search) {
            conditions.push(
                `(br.route_name ILIKE $${paramIndex} OR b.bus_number ILIKE $${paramIndex})`
            );
            params.push(`%${search}%`);
            paramIndex++;
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        // Count
        const countResult = await pool.query(
            `SELECT COUNT(*) AS total
             FROM bus_routes br
             JOIN buses b ON b.id = br.bus_id
             ${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].total, 10);

        // Fetch with LEFT JOINs for driver, stop count, student count
        const dataResult = await pool.query(
            `SELECT
                br.id,
                br.route_name,
                br.scheduled_departure,
                br.is_active,
                b.bus_number,
                b.capacity,
                d.name AS default_driver_name,
                COALESCE(sc.stop_count, 0)::int AS total_stops,
                COALESCE(stc.student_count, 0)::int AS total_students
             FROM bus_routes br
             JOIN buses b ON b.id = br.bus_id
             LEFT JOIN users d ON d.id = br.default_driver_id
             LEFT JOIN (
                 SELECT route_id, COUNT(*) AS stop_count
                 FROM route_stops
                 GROUP BY route_id
             ) sc ON sc.route_id = br.id
             LEFT JOIN (
                 SELECT rs.route_id, COUNT(DISTINCT ss.student_id) AS student_count
                 FROM stop_students ss
                 JOIN route_stops rs ON rs.id = ss.stop_id
                 GROUP BY rs.route_id
             ) stc ON stc.route_id = br.id
             ${whereClause}
             ORDER BY br.route_name ASC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...params, limit, offset]
        );

        return success(res, {
            routes: dataResult.rows,
            pagination: paginationMeta(total, limit, page),
        }, 'Routes retrieved successfully');

    } catch (err) {
        console.error('listRoutes error:', err);
        return error(res, 'Failed to retrieve routes', 500, err.message);
    }
}

// =============================================================================
// getRoute
// GET /api/routes/:routeId
//
// Fetches full route details with:
//   1. Route details
//   2. Bus details (bus_number, capacity)
//   3. Default driver (id, name, employee_id)
//   4. Stops array ordered by stop_sequence, each with students array
// =============================================================================
async function getRoute(req, res) {
    try {
        const { routeId } = req.params;
        const schoolId = req.schoolId;

        if (!isValidUUID(routeId)) {
            return error(res, 'Invalid route ID format', 400);
        }

        // Fetch route with bus and driver info
        const routeResult = await pool.query(
            `SELECT
                br.id,
                br.route_name,
                br.scheduled_departure,
                br.is_active,
                br.created_at,
                br.updated_at,
                b.id AS bus_id,
                b.bus_number,
                b.capacity,
                d.id AS default_driver_id,
                d.name AS default_driver_name,
                d.employee_id AS default_driver_employee_id
             FROM bus_routes br
             JOIN buses b ON b.id = br.bus_id
             LEFT JOIN users d ON d.id = br.default_driver_id
             WHERE br.id = $1 AND br.school_id = $2`,
            [routeId, schoolId]
        );

        if (routeResult.rowCount === 0) {
            return error(res, 'Route not found', 404);
        }

        const row = routeResult.rows[0];

        // Build route response object
        const route = {
            id: row.id,
            route_name: row.route_name,
            scheduled_departure: row.scheduled_departure,
            is_active: row.is_active,
            created_at: row.created_at,
            updated_at: row.updated_at,
            bus: {
                id: row.bus_id,
                bus_number: row.bus_number,
                capacity: row.capacity,
            },
            default_driver: row.default_driver_id
                ? {
                      id: row.default_driver_id,
                      name: row.default_driver_name,
                      employee_id: row.default_driver_employee_id,
                  }
                : null,
        };

        // Fetch stops ordered by sequence
        const stopsResult = await pool.query(
            `SELECT id, stop_name, stop_sequence, lat, lng
             FROM route_stops
             WHERE route_id = $1
             ORDER BY stop_sequence ASC`,
            [routeId]
        );

        // For each stop, fetch assigned students
        const stops = [];
        for (const stop of stopsResult.rows) {
            const studentsResult = await pool.query(
                `SELECT s.id, s.name, s.class, s.section, s.roll_no
                 FROM stop_students ss
                 JOIN students s ON s.id = ss.student_id
                 WHERE ss.stop_id = $1
                 ORDER BY s.class ASC, s.section ASC, s.roll_no ASC`,
                [stop.id]
            );
            stops.push({ ...stop, students: studentsResult.rows });
        }

        route.stops = stops;

        return success(res, { route }, 'Route retrieved successfully');

    } catch (err) {
        console.error('getRoute error:', err);
        return error(res, 'Failed to retrieve route', 500, err.message);
    }
}

// =============================================================================
// assignStudentToStop
// POST /api/routes/:routeId/stops/:stopId/students
//
// Assigns a student to a specific stop on a route.
// Body: { student_id }
// - Route must belong to school
// - Stop must belong to route
// - Student must be in same school and active
// - Student must be assigned to this route's bus (is_current=TRUE)
// - Student must not already be at a stop on this route — 409
// =============================================================================
async function assignStudentToStop(req, res) {
    try {
        const { routeId, stopId } = req.params;
        const schoolId = req.schoolId;
        const { student_id } = req.body;

        // --- UUID validation ---
        if (!isValidUUID(routeId)) {
            return error(res, 'Invalid route ID format', 400);
        }
        if (!isValidUUID(stopId)) {
            return error(res, 'Invalid stop ID format', 400);
        }
        if (!student_id || !isValidUUID(student_id)) {
            return error(res, 'Valid student_id is required', 400);
        }

        // --- Validate route belongs to school ---
        const routeCheck = await pool.query(
            `SELECT id, bus_id FROM bus_routes WHERE id = $1 AND school_id = $2`,
            [routeId, schoolId]
        );
        if (routeCheck.rowCount === 0) {
            return error(res, 'Route not found', 404);
        }

        const busId = routeCheck.rows[0].bus_id;

        // --- Validate stop belongs to route ---
        const stopCheck = await pool.query(
            `SELECT id, stop_name FROM route_stops WHERE id = $1 AND route_id = $2`,
            [stopId, routeId]
        );
        if (stopCheck.rowCount === 0) {
            return error(res, 'Stop not found in this route', 404);
        }

        const stopName = stopCheck.rows[0].stop_name;

        // --- Validate student belongs to same school and is active ---
        const studentCheck = await pool.query(
            `SELECT id, name, is_active FROM students WHERE id = $1 AND school_id = $2`,
            [student_id, schoolId]
        );
        if (studentCheck.rowCount === 0) {
            return error(res, 'Student not found in this school', 404);
        }
        if (!studentCheck.rows[0].is_active) {
            return error(res, 'Student is inactive', 400);
        }

        const studentName = studentCheck.rows[0].name;

        // --- Validate student is assigned to this route's bus ---
        const busAssignCheck = await pool.query(
            `SELECT id FROM student_bus_assignments
             WHERE student_id = $1 AND bus_id = $2 AND is_current = TRUE`,
            [student_id, busId]
        );
        if (busAssignCheck.rowCount === 0) {
            return error(
                res,
                'Student must be assigned to this bus before they can be assigned to a stop',
                400
            );
        }

        // --- Check student not already at a stop on this route ---
        const existingStopCheck = await pool.query(
            `SELECT ss.stop_id, rs.stop_name
             FROM stop_students ss
             JOIN route_stops rs ON rs.id = ss.stop_id
             WHERE ss.student_id = $1 AND rs.route_id = $2`,
            [student_id, routeId]
        );
        if (existingStopCheck.rowCount > 0) {
            const currentStop = existingStopCheck.rows[0].stop_name;
            return error(
                res,
                `Student is already assigned to stop '${currentStop}' on this route`,
                409
            );
        }

        // --- Insert into stop_students ---
        await pool.query(
            `INSERT INTO stop_students (stop_id, student_id, created_at)
             VALUES ($1, $2, NOW())`,
            [stopId, student_id]
        );

        return success(res, {
            student_name: studentName,
            stop_name: stopName,
        }, 'Student assigned to stop successfully', 201);

    } catch (err) {
        console.error('assignStudentToStop error:', err);
        return error(res, 'Failed to assign student to stop', 500, err.message);
    }
}

// =============================================================================
// removeStudentFromStop
// DELETE /api/routes/:routeId/stops/:stopId/students/:studentId
//
// Removes a student from a specific stop.
// - Validates stop belongs to route
// - Validates assignment exists — 404 if not
// =============================================================================
async function removeStudentFromStop(req, res) {
    try {
        const { routeId, stopId, studentId } = req.params;
        const schoolId = req.schoolId;

        // --- UUID validation ---
        if (!isValidUUID(routeId)) {
            return error(res, 'Invalid route ID format', 400);
        }
        if (!isValidUUID(stopId)) {
            return error(res, 'Invalid stop ID format', 400);
        }
        if (!isValidUUID(studentId)) {
            return error(res, 'Invalid student ID format', 400);
        }

        // --- Validate route belongs to school ---
        const routeCheck = await pool.query(
            `SELECT id FROM bus_routes WHERE id = $1 AND school_id = $2`,
            [routeId, schoolId]
        );
        if (routeCheck.rowCount === 0) {
            return error(res, 'Route not found', 404);
        }

        // --- Validate stop belongs to route ---
        const stopCheck = await pool.query(
            `SELECT id FROM route_stops WHERE id = $1 AND route_id = $2`,
            [stopId, routeId]
        );
        if (stopCheck.rowCount === 0) {
            return error(res, 'Stop not found in this route', 404);
        }

        // --- Delete assignment ---
        const deleteResult = await pool.query(
            `DELETE FROM stop_students WHERE stop_id = $1 AND student_id = $2`,
            [stopId, studentId]
        );

        if (deleteResult.rowCount === 0) {
            return error(res, 'Student is not assigned to this stop', 404);
        }

        return success(res, {}, 'Student removed from stop successfully');

    } catch (err) {
        console.error('removeStudentFromStop error:', err);
        return error(res, 'Failed to remove student from stop', 500, err.message);
    }
}

// =============================================================================
// listStopStudents
// GET /api/routes/:routeId/stops/:stopId/students
//
// Lists all students assigned to a specific stop.
// - Validates route and stop belong to school
// - Each student: id, name, class, section, roll_no, is_active
// =============================================================================
async function listStopStudents(req, res) {
    try {
        const { routeId, stopId } = req.params;
        const schoolId = req.schoolId;

        // --- UUID validation ---
        if (!isValidUUID(routeId)) {
            return error(res, 'Invalid route ID format', 400);
        }
        if (!isValidUUID(stopId)) {
            return error(res, 'Invalid stop ID format', 400);
        }

        // --- Validate route belongs to school ---
        const routeCheck = await pool.query(
            `SELECT id FROM bus_routes WHERE id = $1 AND school_id = $2`,
            [routeId, schoolId]
        );
        if (routeCheck.rowCount === 0) {
            return error(res, 'Route not found', 404);
        }

        // --- Validate stop belongs to route ---
        const stopCheck = await pool.query(
            `SELECT id, stop_name FROM route_stops WHERE id = $1 AND route_id = $2`,
            [stopId, routeId]
        );
        if (stopCheck.rowCount === 0) {
            return error(res, 'Stop not found in this route', 404);
        }

        // --- Fetch students at this stop ---
        const studentsResult = await pool.query(
            `SELECT s.id, s.name, s.class, s.section, s.roll_no, s.is_active
             FROM stop_students ss
             JOIN students s ON s.id = ss.student_id
             WHERE ss.stop_id = $1
             ORDER BY s.class ASC, s.section ASC, s.roll_no ASC`,
            [stopId]
        );

        return success(res, {
            stop_name: stopCheck.rows[0].stop_name,
            total: studentsResult.rowCount,
            students: studentsResult.rows,
        }, 'Stop students retrieved successfully');

    } catch (err) {
        console.error('listStopStudents error:', err);
        return error(res, 'Failed to retrieve stop students', 500, err.message);
    }
}

// =============================================================================
//                            DRIVER ENDPOINT
// =============================================================================

// =============================================================================
// getMyRoute
// GET /api/routes/my-route
//
// Driver fetches their assigned route for today.
// Lookup order:
//   1. Check journeys table for today's journey → use its route_id
//   2. Fall back to bus_routes WHERE default_driver_id = userId AND is_active
//   3. If neither found → 404 "No route assigned for today"
//
// Returns full route with bus, stops, and students at each stop.
// This is the primary endpoint the driver app calls on startup.
// =============================================================================
async function getMyRoute(req, res) {
    try {
        const driverId = req.user.userId;
        const schoolId = req.user.school_id;

        let routeId = null;

        // --- Step 1: Check journeys for today ---
        // Use a safe query that won't fail if journeys table doesn't exist yet
        try {
            const journeyResult = await pool.query(
                `SELECT route_id FROM journeys
                 WHERE driver_id = $1 AND journey_date = CURRENT_DATE
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [driverId]
            );
            if (journeyResult.rowCount > 0 && journeyResult.rows[0].route_id) {
                routeId = journeyResult.rows[0].route_id;
            }
        } catch (journeyErr) {
            // journeys table may not exist yet — fall through to default lookup
            console.warn('getMyRoute: journeys lookup skipped —', journeyErr.message);
        }

        // --- Step 2: Fall back to default_driver assignment ---
        if (!routeId) {
            const defaultResult = await pool.query(
                `SELECT id FROM bus_routes
                 WHERE default_driver_id = $1 AND is_active = TRUE
                 LIMIT 1`,
                [driverId]
            );
            if (defaultResult.rowCount > 0) {
                routeId = defaultResult.rows[0].id;
            }
        }

        // --- No route found ---
        if (!routeId) {
            return error(res, 'No route assigned for today', 404);
        }

        // --- Fetch full route details ---
        const routeResult = await pool.query(
            `SELECT
                br.id,
                br.route_name,
                br.scheduled_departure,
                br.school_id,
                b.id AS bus_id,
                b.bus_number
             FROM bus_routes br
             JOIN buses b ON b.id = br.bus_id
             WHERE br.id = $1`,
            [routeId]
        );

        if (routeResult.rowCount === 0) {
            return error(res, 'Route not found', 404);
        }

        const routeRow = routeResult.rows[0];

        // --- School scope security: ensure the route belongs to driver's school ---
        if (routeRow.school_id !== schoolId) {
            return error(res, 'Access denied: route does not belong to your school', 403);
        }

        const route = {
            id: routeRow.id,
            route_name: routeRow.route_name,
            scheduled_departure: routeRow.scheduled_departure,
            bus: {
                id: routeRow.bus_id,
                bus_number: routeRow.bus_number,
            },
        };

        // --- Fetch stops ordered by sequence ---
        const stopsResult = await pool.query(
            `SELECT id, stop_name, stop_sequence, lat, lng
             FROM route_stops
             WHERE route_id = $1
             ORDER BY stop_sequence ASC`,
            [routeId]
        );

        // For each stop, fetch assigned students
        const stops = [];
        for (const stop of stopsResult.rows) {
            const studentsResult = await pool.query(
                `SELECT s.id, s.name, s.class, s.section, s.roll_no
                 FROM stop_students ss
                 JOIN students s ON s.id = ss.student_id
                 WHERE ss.stop_id = $1
                 ORDER BY s.name ASC`,
                [stop.id]
            );
            stops.push({ ...stop, students: studentsResult.rows });
        }

        route.stops = stops;

        return success(res, { route }, 'Route retrieved successfully');

    } catch (err) {
        console.error('getMyRoute error:', err);
        return error(res, 'Failed to retrieve your route', 500, err.message);
    }
}

// =============================================================================
// Exports
// =============================================================================
module.exports = {
    // School Admin
    listRoutes,
    getRoute,
    assignStudentToStop,
    removeStudentFromStop,
    listStopStudents,
    // Driver
    getMyRoute,
};
