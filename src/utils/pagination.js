// =============================================================================
// src/utils/pagination.js
// Reusable pagination helpers for list endpoints
// =============================================================================

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_PAGE = 1;

/**
 * parsePagination
 * Reads `limit` and `page` from req.query and returns sanitised values.
 * - Defaults: limit = 20, page = 1
 * - Maximum limit is capped at 100
 * - Negative / non-numeric values fall back to defaults
 *
 * @param  {Object} query  req.query object
 * @returns {{ limit: number, offset: number, page: number }}
 */
function parsePagination(query = {}) {
    let limit = parseInt(query.limit, 10);
    let page = parseInt(query.page, 10);

    // Fall back to defaults for invalid / missing values
    if (isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (isNaN(page) || page < 1) page = DEFAULT_PAGE;

    // Cap limit to prevent excessively large queries
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const offset = (page - 1) * limit;

    return { limit, offset, page };
}

/**
 * paginationMeta
 * Builds standard pagination metadata for list responses.
 *
 * @param  {number} total  Total row count (before pagination)
 * @param  {number} limit  Rows per page
 * @param  {number} page   Current page number
 * @returns {{ total: number, page: number, limit: number, totalPages: number }}
 */
function paginationMeta(total, limit, page) {
    return {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
    };
}

module.exports = { parsePagination, paginationMeta };
