// =============================================================================
// src/config/db.js
// PostgreSQL connection pool
// =============================================================================

const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,

    // Connection pool sizing — suitable for MVP load
    min: 2,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

// Verify connection on startup
pool.connect((err, client, release) => {
    if (err) {
        logger.error('Failed to connect to PostgreSQL', { error: err.message });
        process.exit(1);
    }
    release();
    logger.info('PostgreSQL connected');
});

module.exports = pool;
