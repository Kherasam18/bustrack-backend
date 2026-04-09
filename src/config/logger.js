// =============================================================================
// src/config/logger.js
// Centralised Winston logger for BusTrack API
//
// Transports:
//   1. Console  — JSON in production, colorised human-readable in dev
//   2. File     — combined.log  (debug level, daily rotation, 14-day retention)
//   3. File     — error.log     (error level, daily rotation, 14-day retention)
//
// Usage:
//   const logger = require('../config/logger');
//   logger.info('message', { key: 'value' });
//   logger.error('message', { error: err.message, stack: err.stack });
// =============================================================================

const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');

const NODE_ENV = process.env.NODE_ENV || 'development';

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

// Shared fields added to every log entry
const baseFormat = format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.errors({ stack: true }),
);

// Console: human-readable in dev, JSON in prod
const consoleFormat =
    NODE_ENV === 'production'
        ? format.combine(baseFormat, format.json())
        : format.combine(
              baseFormat,
              format.colorize(),
              format.printf(({ timestamp, level, message, ...meta }) => {
                  const metaStr = Object.keys(meta).length
                      ? `  ${JSON.stringify(meta)}`
                      : '';
                  return `${timestamp}  ${level}  ${message}${metaStr}`;
              }),
          );

// File: always JSON for machine parsing
const fileFormat = format.combine(baseFormat, format.json());

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

const consoleTransport = new transports.Console({
    level: NODE_ENV === 'production' ? 'info' : 'debug',
    format: consoleFormat,
});

const combinedFileTransport = new transports.DailyRotateFile({
    level: 'debug',
    filename: 'logs/combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d',
    format: fileFormat,
});

const errorFileTransport = new transports.DailyRotateFile({
    level: 'error',
    filename: 'logs/error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d',
    format: fileFormat,
});

// ---------------------------------------------------------------------------
// Logger instance
// ---------------------------------------------------------------------------

const logger = createLogger({
    level: 'debug',
    transports: [consoleTransport, combinedFileTransport, errorFileTransport],
    exitOnError: false,
});

module.exports = logger;
