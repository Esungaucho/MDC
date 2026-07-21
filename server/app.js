'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { openStorage } = require('./db');
const { createApp } = require('./web');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function buildApp(db) {
  const app = createApp();

  app.get('/api/health', () => ({ ok: true, service: 'mdc-plan-room', storage: db.dialect }));

  require('./routes/projects').register(app, db);
  require('./routes/sheets').register(app, db);
  require('./routes/rfis').register(app, db);
  require('./routes/bids').register(app, db);
  require('./routes/pipeline').register(app, db);
  require('./routes/importer').register(app, db);

  // Static pages: pipeline dashboard and the bidding section.
  const page = (file) => ({ res }) => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  };
  app.get('/', page('dashboard.html'));
  app.get('/dashboard', page('dashboard.html'));
  app.get('/bidding', page('bidding.html'));

  return app;
}

async function createServer({ dbPath } = {}) {
  const db = await openStorage({ dbPath });
  const app = buildApp(db);
  const server = http.createServer((req, res) => app.handle(req, res));
  return { server, db };
}

module.exports = { createServer, buildApp };
