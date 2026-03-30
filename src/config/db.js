// =============================================================================
// src/config/db.js
// PostgreSQL connection pool
// =============================================================================

const { Pool } = require('pg');

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
        console.error('❌ Failed to connect to PostgreSQL:', err.message);
        process.exit(1);
    }
    release();
    console.log('✅ PostgreSQL connected');
});

module.exports = pool;
