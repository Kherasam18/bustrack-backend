// =============================================================================
// src/modules/journeys/journeys.controller.js
// Controller for Journey lifecycle and read endpoints
//
// Driver actions: startPickup, arrivedSchool, startDrop, endJourney, myToday
// School Admin reads: todayJourneys, getJourney, journeyHistory
//
// All DB logic is delegated to journeys.service.js.
// =============================================================================

const pool = require('../../config/db');
const { success, error } = require('../../utils/response');
const { parsePagination, paginationMeta } = require('../../utils/pagination');
const journeyService = require('./journeys.service');
const logger = require('../../config/logger');

// =============================================================================
// startPickup — POST /api/journeys/start-pickup
// Creates a PICKUP journey row with status PICKUP_STARTED for the driver's bus.
// =============================================================================
async function startPickup(req, res) {
    try {
        const driverId = req.user.userId;
        const schoolId = req.user.school_id;

        const result = await journeyService.startPickup(driverId, schoolId);

        if (result.error) {
            return error(res, result.error, result.status);
        }

        return success(res, { journey: result.journey }, 'Pickup journey started', 201);
    } catch (err) {
        logger.error('startPickup error', { error: err.message, stack: err.stack });
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// arrivedSchool — POST /api/journeys/arrived-school
// Updates the PICKUP journey to ARRIVED_SCHOOL and sets ended_at.
// =============================================================================
async function arrivedSchool(req, res) {
    try {
        const driverId = req.user.userId;
        const schoolId = req.user.school_id;

        const result = await journeyService.arrivedSchool(driverId, schoolId);

        if (result.error) {
            return error(res, result.error, result.status);
        }

        return success(res, { journey: result.journey }, 'Arrived at school');
    } catch (err) {
        logger.error('arrivedSchool error', { error: err.message, stack: err.stack });
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// startDrop — POST /api/journeys/start-drop
// Creates a DROP journey row with status DROP_STARTED for the driver's bus.
// =============================================================================
async function startDrop(req, res) {
    try {
        const driverId = req.user.userId;
        const schoolId = req.user.school_id;

        const result = await journeyService.startDrop(driverId, schoolId);

        if (result.error) {
            return error(res, result.error, result.status);
        }

        return success(res, { journey: result.journey }, 'Drop journey started', 201);
    } catch (err) {
        logger.error('startDrop error', { error: err.message, stack: err.stack });
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// endJourney — POST /api/journeys/end-journey
// Updates the DROP journey to COMPLETED and sets ended_at.
// =============================================================================
async function endJourney(req, res) {
    try {
        const driverId = req.user.userId;
        const schoolId = req.user.school_id;

        const result = await journeyService.endJourney(driverId, schoolId);

        if (result.error) {
            return error(res, result.error, result.status);
        }

        return success(res, { journey: result.journey }, 'Journey completed');
    } catch (err) {
        logger.error('endJourney error', { error: err.message, stack: err.stack });
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// myToday — GET /api/journeys/my-today
// Returns the driver's own today journey rows (0–2) with bus_number and route_name.
// =============================================================================
async function myToday(req, res) {
    try {
        const driverId = req.user.userId;
        const schoolId = req.user.school_id;

        const result = await journeyService.getDriverTodayJourneys(driverId, schoolId);

        return success(res, { journeys: result.journeys }, 'Today\'s journeys retrieved');
    } catch (err) {
        logger.error('myToday error', { error: err.message, stack: err.stack });
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// todayJourneys — GET /api/journeys/today
// Returns all journeys for the school today, with optional bus_id filter.
// =============================================================================
async function todayJourneys(req, res) {
    try {
        const schoolId = req.schoolId;
        const busIdFilter = req.query.bus_id || null;

        // Validate bus_id filter if provided
        if (busIdFilter && !journeyService.isValidUUID(busIdFilter)) {
            return error(res, 'Invalid bus_id format', 400);
        }

        const result = await journeyService.getTodayJourneys(schoolId, busIdFilter);

        return success(res, { journeys: result.journeys }, 'Today\'s journeys retrieved');
    } catch (err) {
        logger.error('todayJourneys error', { error: err.message, stack: err.stack });
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// getJourney — GET /api/journeys/:journeyId
// Returns a single journey by ID, scoped to the school.
// =============================================================================
async function getJourney(req, res) {
    try {
        const schoolId = req.schoolId;
        const { journeyId } = req.params;

        // Validate UUID format
        if (!journeyService.isValidUUID(journeyId)) {
            return error(res, 'Invalid journey ID format', 400);
        }

        const journey = await journeyService.getJourneyById(journeyId, schoolId);

        if (!journey) {
            return error(res, 'Journey not found', 404);
        }

        return success(res, { journey }, 'Journey retrieved');
    } catch (err) {
        logger.error('getJourney error', { error: err.message, stack: err.stack });
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// journeyHistory — GET /api/journeys
// Paginated journey history for the school with optional filters.
// Query params: ?bus_id, ?journey_type, ?date, ?page, ?limit
// =============================================================================
async function journeyHistory(req, res) {
    try {
        const schoolId = req.schoolId;
        const { limit, offset, page } = parsePagination(req.query);

        const busId = req.query.bus_id || null;
        const journeyType = req.query.journey_type || null;
        const date = req.query.date || null;

        // Validate optional bus_id filter
        if (busId && !journeyService.isValidUUID(busId)) {
            return error(res, 'Invalid bus_id format', 400);
        }

        // Validate optional journey_type filter
        if (journeyType && !journeyService.VALID_JOURNEY_TYPES.includes(journeyType)) {
            return error(res, 'Invalid journey_type. Must be PICKUP or DROP', 400);
        }

        // Validate optional date filter
        if (date && !journeyService.isValidDate(date)) {
            return error(res, 'Invalid date format. Use YYYY-MM-DD', 400);
        }

        const result = await journeyService.getJourneyHistory(schoolId, {
            busId,
            journeyType,
            date,
            limit,
            offset,
        });

        return success(res, {
            journeys: result.journeys,
            pagination: paginationMeta(result.total, limit, page),
        }, 'Journey history retrieved');
    } catch (err) {
        logger.error('journeyHistory error', { error: err.message, stack: err.stack });
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// getParentContext — GET /api/journeys/parent-context
// Returns each child linked to the parent, with their bus, route, and
// the most relevant active journey for today (if any).
// =============================================================================
async function getParentContext(req, res) {
    try {
        const userId = req.user.userId;
        const schoolId = req.user.school_id;

        const query = `
            SELECT
                s.id                 AS student_id,
                s.name               AS student_name,
                b.id                 AS bus_id,
                b.bus_number,
                br.route_name,
                du.name               AS driver_name,
                du.phone              AS driver_phone,
                j.id                 AS journey_id,
                j.journey_type,
                j.status             AS journey_status,
                j.tracking_status,
                j.last_known_lat,
                j.last_known_lng,
                j.last_signal_at,
                j.started_at
            FROM parent_students ps
            JOIN students s
                ON s.id = ps.student_id
                AND s.school_id = $2::uuid
            JOIN student_bus_assignments sba
                ON sba.student_id = s.id
                AND sba.is_current = TRUE
            JOIN buses b
                ON b.id = sba.bus_id
            LEFT JOIN bus_routes br
                ON br.bus_id = b.id
                AND br.is_active = TRUE
            LEFT JOIN users du
                ON du.id = br.default_driver_id
            LEFT JOIN LATERAL (
                SELECT
                    id, journey_type, status, tracking_status,
                    last_known_lat, last_known_lng, last_signal_at, started_at
                FROM journeys
                WHERE bus_id = b.id
                    AND journey_date = CURRENT_DATE
                    AND school_id = $2::uuid
                ORDER BY
                    CASE status
                        WHEN 'PICKUP_STARTED'  THEN 1
                        WHEN 'DROP_STARTED'    THEN 2
                        WHEN 'ARRIVED_SCHOOL'  THEN 3
                        WHEN 'COMPLETED'       THEN 4
                        ELSE 5
                    END ASC
                LIMIT 1
            ) j ON TRUE
            WHERE ps.parent_id = $1::uuid
        `;

        const { rows } = await pool.query(query, [userId, schoolId]);

        const children = rows.map((row) => ({
            student_id:   row.student_id,
            student_name: row.student_name,
            bus_id:       row.bus_id,
            bus_number:   row.bus_number,
            route_name:   row.route_name,
            driver_name:  row.driver_name  || null,
            driver_phone: row.driver_phone || null,
            active_journey: row.journey_id ? {
                id:              row.journey_id,
                journey_type:    row.journey_type,
                journey_status:  row.journey_status,
                tracking_status: row.tracking_status,
                last_known_lat:  row.last_known_lat !== null ? parseFloat(row.last_known_lat) : null,
                last_known_lng:  row.last_known_lng !== null ? parseFloat(row.last_known_lng) : null,
                last_signal_at:  row.last_signal_at,
                started_at:      row.started_at,
            } : null,
        }));

        return success(res, { children }, 'Parent context retrieved');
    } catch (err) {
        logger.error('getParentContext error', { error: err.message, stack: err.stack });
        return error(res, 'Internal server error', 500);
    }
}

module.exports = {
    startPickup,
    arrivedSchool,
    startDrop,
    endJourney,
    myToday,
    todayJourneys,
    getJourney,
    journeyHistory,
    getParentContext,
};
