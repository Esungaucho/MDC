'use strict';

// Vercel serverless entry point. Wraps the same app the standalone server
// runs, but keeps SQLite in /tmp — the only writable path in a serverless
// function — and seeds it on cold start so the demo always has data.
//
// NOTE: /tmp is per-instance and ephemeral. Data entered on the deployed demo
// lasts only as long as the warm instance. Point MDC_DB (or swap the storage
// layer) at a hosted database before real bid/RFI entry moves here.

const { buildApp } = require('../server/app');
const { openDb } = require('../server/db');
const { seed } = require('../server/seed');

let app;

function getApp() {
  if (!app) {
    const db = openDb(process.env.MDC_DB || '/tmp/planroom.db');
    seed(db); // no-op when the database already has projects
    app = buildApp(db);
  }
  return app;
}

module.exports = (req, res) => getApp().handle(req, res);
