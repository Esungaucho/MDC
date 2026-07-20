'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { openDb } = require('./db');
const { createApp } = require('./web');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function buildApp(db) {
  const app = createApp();

  app.get('/api/health', () => ({ ok: true, service: 'mdc-plan-room' }));

  require('./routes/projects').register(app, db);
  require('./routes/sheets').register(app, db);
  require('./routes/rfis').register(app, db);
  require('./routes/bids').register(app, db);
  require('./routes/pipeline').register(app, db);

  // Pipeline dashboard (static page that renders GET /api/pipeline).
  const dashboard = ({ res }) => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  };
  app.get('/', dashboard);
  app.get('/dashboard', dashboard);

  return app;
}

function createServer({ dbPath } = {}) {
  const db = openDb(dbPath);
  const app = buildApp(db);
  const server = http.createServer((req, res) => app.handle(req, res));
  return { server, db };
}

module.exports = { createServer, buildApp };
