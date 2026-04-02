// =============================================================================
// src/modules/location/location.controller.js
// Controller for GPS location tracking endpoints
//
// POST /api/location/update         — Driver pushes GPS coordinate
// GET  /api/location/journey/:id    — School Admin views location log
//
// All DB/Firebase logic is delegated to location.service.js.
// =============================================================================

const { success, error } = require('../../utils/response');
const { isValidUUID } = require('../journeys/journeys.service');
const locationService = require('./location.service');

// =============================================================================
// updateLocation — POST /api/location/update
// Receives a GPS update from the driver app and persists it.
// =============================================================================
async function updateLocation(req, res) {
    try {
        const driverId = req.user.userId;
        const schoolId = req.user.school_id;

        const result = await locationService.processLocationUpdate(driverId, schoolId, req.body);

        if (result.error) {
            return error(res, result.error, result.status);
        }

        return success(res, result.data, 'Location updated');
    } catch (err) {
        console.error('updateLocation error:', err);
        return error(res, 'Internal server error', 500);
    }
}

// =============================================================================
// getJourneyLocations — GET /api/location/journey/:journeyId
// Returns the full GPS location log for a journey (School Admin only).
// =============================================================================
async function getJourneyLocations(req, res) {
    try {
        const schoolId = req.schoolId;
        const { journeyId } = req.params;

        // Validate UUID format before hitting DB
        if (!isValidUUID(journeyId)) {
            return error(res, 'Invalid journey ID format', 400);
        }

        const result = await locationService.getJourneyLocationLog(journeyId, schoolId);

        if (result.error) {
            return error(res, result.error, result.status);
        }

        return success(res, result.data, 'Location log retrieved');
    } catch (err) {
        console.error('getJourneyLocations error:', err);
        return error(res, 'Internal server error', 500);
    }
}

module.exports = {
    updateLocation,
    getJourneyLocations,
};
