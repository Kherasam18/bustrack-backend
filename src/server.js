// =============================================================================
// src/utils/response.js
// Consistent API response shape across all endpoints
// =============================================================================

function success(res, data = {}, message = 'Success', statusCode = 200) {
    return res.status(statusCode).json({
        success: true,
        message,
        data,
    });
}

function error(res, message = 'Something went wrong', statusCode = 500, details = null) {
    const body = { success: false, message };
    if (details && process.env.NODE_ENV === 'development') {
        body.details = details;
    }
    return res.status(statusCode).json(body);
}

module.exports = { success, error };
