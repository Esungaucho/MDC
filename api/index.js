'use strict';

// Vercel serverless entry point.
//
// With DATABASE_URL set (Neon Postgres attached via the Vercel Storage tab)
// this runs in production mode: persistent storage, no demo data. Without it,
// it falls back to demo mode: SQLite in /tmp — the only writable path in a
// serverless function — seeded on cold start so the demo always has data.

const { buildApp } = require('../server/app');
const { openStorage } = require('../server/db');
const { seed } = require('../server/seed');

let appPromise;

function getApp() {
  appPromise ??= (async () => {
    const db = await openStorage(
      process.env.DATABASE_URL ? {} : { dbPath: process.env.MDC_DB || '/tmp/planroom.db' }
    );
    if (db.dialect === 'sqlite') await seed(db); // demo mode only; no-op if already seeded
    return buildApp(db);
  })();
  return appPromise;
}

module.exports = async (req, res) => (await getApp()).handle(req, res);
