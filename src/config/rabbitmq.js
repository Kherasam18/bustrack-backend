// =============================================================================
// src/config/rabbitmq.js
// RabbitMQ connection manager — singleton pattern
//
// Creates one connection + channel on first call and reuses it.
// If the connection drops, the next call creates a fresh pair.
// =============================================================================

const amqplib = require('amqplib');

let connection = null;
let channel = null;

// Returns a live amqplib channel, creating one if needed
async function getRabbitMQChannel() {
    // Return existing channel if connection is still open
    if (channel && connection) {
        return channel;
    }

    const url = process.env.RABBITMQ_URL;

    connection = await amqplib.connect(url);
    channel = await connection.createChannel();

    console.log('RabbitMQ connected');

    // Reset module-level refs when the connection closes unexpectedly
    connection.on('close', () => {
        console.log('RabbitMQ connection closed');
        connection = null;
        channel = null;
    });

    connection.on('error', (err) => {
        console.error('RabbitMQ connection error:', err.message);
        connection = null;
        channel = null;
    });

    return channel;
}

module.exports = { getRabbitMQChannel };
