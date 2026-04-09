// =============================================================================
// src/modules/dashboard/dashboard.service.js
// Service layer for School Admin dashboard operations
//
// All DB logic lives here. Controllers import and call these functions.
// Every function receives school_id explicitly — never from globals.
// All queries are parameterised and scoped to school_id.
// =============================================================================

const pool = require('../../config/db');

// =============================================================================
// Helper: buildJourneyObject
// Builds a consistent pickup/drop object with null defaults for missing fields.
// =============================================================================
function buildJourneyObject(row, prefix, flags) {
    return {
        journey_id: row[`${prefix}_journey_id`] || null,
        status: row[`${prefix}_status`] || null,
        tracking_status: row[`${prefix}_tracking_status`] || null,
        started_at: row[`${prefix}_started_at`] || null,
        ended_at: row[`${prefix}_ended_at`] || null,
        last_known_lat: row[`${prefix}_last_lat`] !== undefined ? row[`${prefix}_last_lat`] : null,
        last_known_lng: row[`${prefix}_last_lng`] !== undefined ? row[`${prefix}_last_lng`] : null,
        last_location_at: row[`${prefix}_last_location_at`] || null,
        last_signal_at: row[`${prefix}_last_signal_at`] || null,
        flags: flags,
    };
}

// =============================================================================
// Helper: buildDetailJourneyObject
// Builds a full journey object for the bus-detail endpoint with all fields.
// =============================================================================
function buildDetailJourneyObject(journey, flags) {
    if (!journey) {
        return {
            journey_id: null,
            status: null,
            tracking_status: null,
            journey_type: null,
            journey_date: null,
            started_at: null,
            ended_at: null,
            last_known_lat: null,
            last_known_lng: null,
            last_location_at: null,
            last_signal_at: null,
            is_auto_started: null,
            is_auto_ended: null,
            created_at: null,
            updated_at: null,
            flags: [],
        };
    }

    return {
        journey_id: journey.id,
        status: journey.status,
        tracking_status: journey.tracking_status,
        journey_type: journey.journey_type,
        journey_date: journey.journey_date,
        started_at: journey.started_at,
        ended_at: journey.ended_at,
        last_known_lat: journey.last_known_lat || null,
        last_known_lng: journey.last_known_lng || null,
        last_location_at: journey.last_location_at || null,
        last_signal_at: journey.last_signal_at || null,
        is_auto_started: journey.is_auto_started,
        is_auto_ended: journey.is_auto_ended,
        created_at: journey.created_at,
        updated_at: journey.updated_at,
        flags: flags,
    };
}

// =============================================================================
// getLiveFleet
// Returns ALL active buses for the school today with journey status,
// tracking status, driver name, route name, scheduled departure, and
// unresolved flags. Includes buses with no journey started yet today.
// =============================================================================
async function getLiveFleet(schoolId) {
    // 1. Main fleet query — LEFT JOINs buses → routes → journeys → drivers
    const mainResult = await pool.query(
        `SELECT
            b.id                        AS bus_id,
            b.bus_number,
            b.capacity,
            b.is_active,
            br.id                       AS route_id,
            br.route_name,
            br.scheduled_departure,
            pj.id                       AS pickup_journey_id,
            pj.status                   AS pickup_status,
            pj.tracking_status          AS pickup_tracking_status,
            pj.started_at               AS pickup_started_at,
            pj.ended_at                 AS pickup_ended_at,
            pj.last_known_lat           AS pickup_last_lat,
            pj.last_known_lng           AS pickup_last_lng,
            pj.last_location_at         AS pickup_last_location_at,
            pj.last_signal_at           AS pickup_last_signal_at,
            dj.id                       AS drop_journey_id,
            dj.status                   AS drop_status,
            dj.tracking_status          AS drop_tracking_status,
            dj.started_at               AS drop_started_at,
            dj.ended_at                 AS drop_ended_at,
            dj.last_known_lat           AS drop_last_lat,
            dj.last_known_lng           AS drop_last_lng,
            dj.last_location_at         AS drop_last_location_at,
            dj.last_signal_at           AS drop_last_signal_at,
            COALESCE(su.name, du.name)  AS driver_name,
            COALESCE(su.id, du.id)      AS driver_id
        FROM buses b
        LEFT JOIN bus_routes br
            ON br.bus_id = b.id
            AND br.school_id = $1::uuid
            AND br.is_active = TRUE
        LEFT JOIN journeys pj
            ON pj.bus_id = b.id
            AND pj.journey_date = CURRENT_DATE
            AND pj.journey_type = 'PICKUP'
            AND pj.school_id = $1::uuid
        LEFT JOIN journeys dj
            ON dj.bus_id = b.id
            AND dj.journey_date = CURRENT_DATE
            AND dj.journey_type = 'DROP'
            AND dj.school_id = $1::uuid
        LEFT JOIN substitute_assignments sa
            ON sa.bus_id = b.id
            AND sa.assignment_date = CURRENT_DATE
            AND sa.school_id = $1::uuid
        LEFT JOIN users su
            ON su.id = sa.substitute_driver_id
        LEFT JOIN users du
            ON du.id = br.default_driver_id
        WHERE b.school_id = $1::uuid
            AND b.is_active = TRUE
        ORDER BY b.bus_number ASC`,
        [schoolId]
    );

    const rows = mainResult.rows;

    // 2. Collect all journey IDs for the flags batch query
    const journeyIds = [];
    for (const row of rows) {
        if (row.pickup_journey_id) journeyIds.push(row.pickup_journey_id);
        if (row.drop_journey_id) journeyIds.push(row.drop_journey_id);
    }

    // 3. Fetch unresolved flags for all active journeys in a single query
    let flagsByJourneyId = {};
    if (journeyIds.length > 0) {
        const flagsResult = await pool.query(
            `SELECT jf.journey_id, jf.id AS flag_id, jf.type, jf.created_at
             FROM journey_flags jf
             WHERE jf.school_id = $1::uuid
               AND jf.journey_id = ANY($2::uuid[])
               AND jf.resolved_at IS NULL
             ORDER BY jf.created_at ASC`,
            [schoolId, journeyIds]
        );

        // Group flags by journey_id
        for (const flag of flagsResult.rows) {
            if (!flagsByJourneyId[flag.journey_id]) {
                flagsByJourneyId[flag.journey_id] = [];
            }
            flagsByJourneyId[flag.journey_id].push({
                flag_id: flag.flag_id,
                type: flag.type,
                created_at: flag.created_at,
            });
        }
    }

    // 4. Assemble the response with consistent object shape
    const buses = rows.map(row => {
        const pickupFlags = row.pickup_journey_id
            ? (flagsByJourneyId[row.pickup_journey_id] || [])
            : [];
        const dropFlags = row.drop_journey_id
            ? (flagsByJourneyId[row.drop_journey_id] || [])
            : [];

        return {
            bus_id: row.bus_id,
            bus_number: row.bus_number,
            capacity: row.capacity,
            route_id: row.route_id || null,
            route_name: row.route_name || null,
            scheduled_departure: row.scheduled_departure || null,
            driver_name: row.driver_name || null,
            driver_id: row.driver_id || null,
            pickup: buildJourneyObject(row, 'pickup', pickupFlags),
            drop: buildJourneyObject(row, 'drop', dropFlags),
        };
    });

    return { buses, total_buses: buses.length };
}

// =============================================================================
// getBusDetail
// Returns full detail for a single bus — today's PICKUP and DROP journey
// rows with all fields, all flags (resolved and unresolved), and student count.
// Returns null if the bus does not exist or does not belong to the school.
// =============================================================================
async function getBusDetail(busId, schoolId) {
    // 1. Fetch bus + route + driver
    const busResult = await pool.query(
        `SELECT
            b.id                        AS bus_id,
            b.bus_number,
            b.capacity,
            br.id                       AS route_id,
            br.route_name,
            br.scheduled_departure,
            COALESCE(su.name, du.name)  AS driver_name,
            COALESCE(su.id, du.id)      AS driver_id
        FROM buses b
        LEFT JOIN bus_routes br
            ON br.bus_id = b.id
            AND br.school_id = $2::uuid
            AND br.is_active = TRUE
        LEFT JOIN substitute_assignments sa
            ON sa.bus_id = b.id
            AND sa.assignment_date = CURRENT_DATE
            AND sa.school_id = $2::uuid
        LEFT JOIN users su
            ON su.id = sa.substitute_driver_id
        LEFT JOIN users du
            ON du.id = br.default_driver_id
        WHERE b.id = $1::uuid
            AND b.school_id = $2::uuid`,
        [busId, schoolId]
    );

    if (busResult.rowCount === 0) {
        return null;
    }

    const busRow = busResult.rows[0];

    // 2. Fetch today's journeys for this bus (both types)
    const journeysResult = await pool.query(
        `SELECT id, school_id, bus_id, driver_id, route_id, journey_type,
                status, journey_date, started_at, ended_at,
                last_known_lat, last_known_lng, last_location_at,
                tracking_status, last_signal_at,
                is_auto_started, is_auto_ended,
                created_at, updated_at
         FROM journeys
         WHERE bus_id = $1::uuid
           AND journey_date = CURRENT_DATE
           AND school_id = $2::uuid
         ORDER BY journey_type ASC`,
        [busId, schoolId]
    );

    const pickupJourney = journeysResult.rows.find(j => j.journey_type === 'PICKUP') || null;
    const dropJourney = journeysResult.rows.find(j => j.journey_type === 'DROP') || null;

    // 3. Fetch ALL flags for today's journeys (resolved and unresolved)
    const journeyIds = journeysResult.rows.map(j => j.id);
    let pickupFlags = [];
    let dropFlags = [];

    if (journeyIds.length > 0) {
        const flagsResult = await pool.query(
            `SELECT jf.id, jf.journey_id, jf.type,
                    jf.resolved_at, jf.created_at
             FROM journey_flags jf
             WHERE jf.journey_id = ANY($1::uuid[])
               AND jf.school_id = $2::uuid
             ORDER BY jf.created_at ASC`,
            [journeyIds, schoolId]
        );

        // Separate flags by journey type
        for (const flag of flagsResult.rows) {
            const flagObj = {
                flag_id: flag.id,
                type: flag.type,
                resolved_at: flag.resolved_at || null,
                created_at: flag.created_at,
            };

            if (pickupJourney && flag.journey_id === pickupJourney.id) {
                pickupFlags.push(flagObj);
            } else if (dropJourney && flag.journey_id === dropJourney.id) {
                dropFlags.push(flagObj);
            }
        }
    }

    // 4. Fetch student count assigned to this bus
    const studentResult = await pool.query(
        `SELECT COUNT(*) AS student_count
         FROM student_bus_assignments
         WHERE bus_id = $1::uuid
           AND is_current = TRUE
           AND school_id = $2::uuid`,
        [busId, schoolId]
    );

    const studentCount = parseInt(studentResult.rows[0].student_count, 10);

    // 5. Assemble the response
    return {
        bus_id: busRow.bus_id,
        bus_number: busRow.bus_number,
        capacity: busRow.capacity,
        student_count: studentCount,
        route_id: busRow.route_id || null,
        route_name: busRow.route_name || null,
        scheduled_departure: busRow.scheduled_departure || null,
        driver_name: busRow.driver_name || null,
        driver_id: busRow.driver_id || null,
        pickup: buildDetailJourneyObject(pickupJourney, pickupFlags),
        drop: buildDetailJourneyObject(dropJourney, dropFlags),
    };
}

// =============================================================================
// getStats
// Returns summary counts for the school today using a single SQL query
// with conditional aggregation. Used for the stats strip on the dashboard.
// =============================================================================
async function getStats(schoolId) {
    const result = await pool.query(
        `SELECT
            COUNT(DISTINCT b.id)                                    AS total_buses,
            COUNT(DISTINCT j.bus_id)
                FILTER (WHERE j.id IS NOT NULL)                     AS buses_with_journey,
            COUNT(j.id)
                FILTER (WHERE j.status = 'PICKUP_STARTED'
                           OR j.status = 'DROP_STARTED')            AS journeys_active,
            COUNT(j.id)
                FILTER (WHERE j.status = 'COMPLETED')               AS journeys_completed,
            COUNT(j.id)
                FILTER (WHERE j.status = 'ARRIVED_SCHOOL')          AS arrived_school,
            COUNT(DISTINCT jf.journey_id)
                FILTER (WHERE jf.resolved_at IS NULL)               AS buses_with_flags
        FROM buses b
        LEFT JOIN journeys j
            ON j.bus_id = b.id
            AND j.journey_date = CURRENT_DATE
            AND j.school_id = $1::uuid
        LEFT JOIN journey_flags jf
            ON jf.journey_id = j.id
            AND jf.school_id = $1::uuid
        WHERE b.school_id = $1::uuid
            AND b.is_active = TRUE`,
        [schoolId]
    );

    const row = result.rows[0];

    return {
        total_buses: parseInt(row.total_buses, 10),
        buses_with_journey: parseInt(row.buses_with_journey, 10),
        journeys_active: parseInt(row.journeys_active, 10),
        journeys_completed: parseInt(row.journeys_completed, 10),
        arrived_school: parseInt(row.arrived_school, 10),
        buses_with_flags: parseInt(row.buses_with_flags, 10),
    };
}

module.exports = {
    getLiveFleet,
    getBusDetail,
    getStats,
};
