// =============================================================================
// src/modules/dashboard/dashboard.controller.js
// Controller for School Admin dashboard endpoints
//
// Endpoints:
//   GET /api/dashboard/live          Live fleet overview
//   GET /api/dashboard/buses/:busId  Single bus detail
//   GET /api/dashboard/stats         Summary counts
//
// All DB logic is delegated to dashboard.service.js.
// =============================================================================

const { success, error } = require('../../utils/response');
const { isValidUUID } = require('../journeys/journeys.service');
const dashboardService = require('./dashboard.service');
const logger = require('../../config/logger');

// =============================================================================
// getLive — GET /api/dashboard/live
// Returns all active buses for the school today with journey status, tracking,
// driver, route, and unresolved flags for the live operations board.
// =============================================================================
async function getLive(req, res) {
    try {
        const schoolId = req.user.school_id;

        const result = await dashboardService.getLiveFleet(schoolId);

        return success(res, {
            buses: result.buses,
            total_buses: result.total_buses,
        }, 'Live fleet data retrieved');
    } catch (err) {
        logger.error('getLive error', { error: err.message, stack: err.stack });
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// getBusDetail — GET /api/dashboard/buses/:busId
// Returns full detail for a single bus including today's journeys, all flags,
// and student count assigned to this bus.
// =============================================================================
async function getBusDetail(req, res) {
    try {
        const schoolId = req.user.school_id;
        const { busId } = req.params;

        // Validate UUID format
        if (!isValidUUID(busId)) {
            return error(res, 'Invalid bus ID format', 400);
        }

        const bus = await dashboardService.getBusDetail(busId, schoolId);

        if (!bus) {
            return error(res, 'Bus not found', 404);
        }

        return success(res, { bus }, 'Bus detail retrieved');
    } catch (err) {
        logger.error('getBusDetail error', { error: err.message, stack: err.stack });
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// getStats — GET /api/dashboard/stats
// Returns summary counts for the school today for the stats strip.
// =============================================================================
async function getStats(req, res) {
    try {
        const schoolId = req.user.school_id;

        const stats = await dashboardService.getStats(schoolId);

        return success(res, { stats }, 'Dashboard stats retrieved');
    } catch (err) {
        logger.error('getStats error', { error: err.message, stack: err.stack });
        return error(res, 'Internal server error', 500);
    }
}

module.exports = {
    getLive,
    getBusDetail,
    getStats,
};
