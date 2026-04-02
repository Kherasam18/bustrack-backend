// =============================================================================
// src/config/firebase.js
// Firebase Admin SDK — initialised once, reused across modules
//
// Requires either:
//   a) GOOGLE_APPLICATION_CREDENTIALS env var pointing to a service account
//      JSON file (recommended for production), OR
//   b) FIREBASE_SERVICE_ACCOUNT_PATH env var with an explicit path.
//
// FIREBASE_DATABASE_URL is required for Realtime Database operations.
// =============================================================================

const admin = require('firebase-admin');

// Prevent double-initialisation (e.g. during hot-reload in development)
if (!admin.apps.length) {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
        || process.env.GOOGLE_APPLICATION_CREDENTIALS;

    const initOptions = {
        databaseURL: process.env.FIREBASE_DATABASE_URL,
    };

    if (serviceAccountPath) {
        // Explicit service account file
        const serviceAccount = require(serviceAccountPath);
        initOptions.credential = admin.credential.cert(serviceAccount);
    } else {
        // Fall back to Application Default Credentials (GCP environments)
        initOptions.credential = admin.credential.applicationDefault();
    }

    admin.initializeApp(initOptions);
    console.log('✅ Firebase Admin initialised');
}

module.exports = admin;
