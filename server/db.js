'use strict';

// Storage layer with two interchangeable backends behind one async API:
//   - SQLite (node:sqlite)  — local dev, tests, and the no-database demo mode
//   - Postgres (Neon)       — production, selected by DATABASE_URL
//
// Every statement object exposes async get/all/run regardless of backend, so
// routes are written once. SQL must stay in the shared dialect subset:
//   - `?` placeholders (translated to $n for Postgres)
//   - camelCase result aliases always double-quoted (Postgres lowercases
//     unquoted identifiers)
//   - case-insensitive name matching via LOWER(...), not COLLATE

const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'planroom.db');

function schemaStatements(dialect) {
  const pg = dialect === 'postgres';
  const ID = pg ? 'id SERIAL PRIMARY KEY' : 'id INTEGER PRIMARY KEY AUTOINCREMENT';
  const NOW = pg ? 'now()' : "(datetime('now'))";
  const statements = [
    `CREATE TABLE IF NOT EXISTS projects (
      ${ID},
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'bidding'
        CHECK (status IN ('planning','bidding','awarded','active','closed')),
      phase TEXT,
      category TEXT,
      proposal_amount_cents INTEGER,
      final_contract_amount_cents INTEGER,
      notes TEXT,
      priority TEXT,
      account TEXT,
      owner_name TEXT,
      owner_email TEXT,
      owner_phone TEXT,
      address TEXT,
      initial_contact_date TEXT,
      site_visit_date TEXT,
      rfi_date TEXT,
      proposal_submitted_date TEXT,
      proposal_notes TEXT,
      go_hard_date TEXT,
      reminders_automated INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT ${NOW}
    )`,
    // Migrations for databases created before these columns existed. Postgres
    // supports IF NOT EXISTS; the SQLite backend swallows duplicate-column
    // errors in init() instead.
    ...[
      'phase TEXT', 'category TEXT', 'proposal_amount_cents INTEGER',
      'final_contract_amount_cents INTEGER', 'notes TEXT', 'priority TEXT',
      'account TEXT', 'owner_name TEXT', 'owner_email TEXT', 'owner_phone TEXT',
      'address TEXT', 'initial_contact_date TEXT', 'site_visit_date TEXT',
      'rfi_date TEXT', 'proposal_submitted_date TEXT', 'proposal_notes TEXT',
    ].map((col) => (pg
      ? `ALTER TABLE projects ADD COLUMN IF NOT EXISTS ${col}`
      : `ALTER TABLE projects ADD COLUMN ${col}`)),
    `CREATE TABLE IF NOT EXISTS sheets (
      ${ID},
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sheet_number TEXT NOT NULL,
      title TEXT NOT NULL,
      discipline TEXT NOT NULL,
      superseded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      UNIQUE (project_id, sheet_number)
    )`,
    `CREATE TABLE IF NOT EXISTS sheet_revisions (
      ${ID},
      sheet_id INTEGER NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
      rev INTEGER NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 1,
      issued_date TEXT,
      file_name TEXT,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      UNIQUE (sheet_id, rev)
    )`,
    pg
      ? `CREATE TABLE IF NOT EXISTS companies (
          ${ID},
          name TEXT NOT NULL,
          trade TEXT,
          contact_name TEXT,
          email TEXT,
          phone TEXT,
          in_directory INTEGER NOT NULL DEFAULT 0,
          w9_received INTEGER NOT NULL DEFAULT 0,
          coi_received INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT ${NOW}
        )`
      : `CREATE TABLE IF NOT EXISTS companies (
          ${ID},
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          trade TEXT,
          contact_name TEXT,
          email TEXT,
          phone TEXT,
          in_directory INTEGER NOT NULL DEFAULT 0,
          w9_received INTEGER NOT NULL DEFAULT 0,
          coi_received INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT ${NOW}
        )`,
    ...(pg ? ['CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name_lower ON companies (LOWER(name))'] : []),
    `CREATE TABLE IF NOT EXISTS rfis (
      ${ID},
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      rfi_number INTEGER NOT NULL,
      subject TEXT NOT NULL,
      question TEXT,
      sheet_id INTEGER REFERENCES sheets(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
      answer TEXT,
      submitted_by TEXT,
      pin_x REAL,
      pin_y REAL,
      created_at TEXT NOT NULL DEFAULT ${NOW},
      updated_at TEXT NOT NULL DEFAULT ${NOW},
      UNIQUE (project_id, rfi_number)
    )`,
    `CREATE TABLE IF NOT EXISTS bids (
      ${ID},
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id),
      trade TEXT NOT NULL,
      amount_cents INTEGER,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted','final_list','awarded','declined')),
      submitted_at TEXT NOT NULL DEFAULT ${NOW},
      UNIQUE (project_id, company_id, trade)
    )`,
    `CREATE TABLE IF NOT EXISTS reminders (
      ${ID},
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('one_week','final')),
      scheduled_for TEXT NOT NULL,
      sent_at TEXT,
      sent_via TEXT CHECK (sent_via IN ('auto','manual')),
      UNIQUE (project_id, kind)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_sheets_project ON sheets(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_revisions_sheet ON sheet_revisions(sheet_id)',
    'CREATE INDEX IF NOT EXISTS idx_rfis_project ON rfis(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_rfis_sheet ON rfis(sheet_id)',
    'CREATE INDEX IF NOT EXISTS idx_bids_project ON bids(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_reminders_project ON reminders(project_id)',
  ];
  return statements;
}

class SqliteDb {
  constructor(file) {
    const { DatabaseSync } = require('node:sqlite');
    this.dialect = 'sqlite';
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.file = file;
  }

  async init() {
    this.raw.exec('PRAGMA foreign_keys = ON;');
    if (this.file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
    for (const stmt of schemaStatements('sqlite')) {
      try {
        this.raw.exec(stmt);
      } catch (err) {
        // SQLite has no ADD COLUMN IF NOT EXISTS; ignore re-run migrations.
        if (!/duplicate column name/i.test(err.message)) throw err;
      }
    }
  }

  prepare(sql) {
    const raw = this.raw;
    return {
      async get(...params) { return raw.prepare(sql).get(...params); },
      async all(...params) { return raw.prepare(sql).all(...params); },
      async run(...params) { return raw.prepare(sql).run(...params); },
    };
  }
}

class PgDb {
  constructor(url) {
    // Lazy require: the driver is only needed (and only installed) where
    // Postgres is actually used, keeping local dev dependency-free.
    const { neon } = require('@neondatabase/serverless');
    this.dialect = 'postgres';
    const client = neon(url, { fullResults: true });
    this.rawQuery = typeof client.query === 'function' ? client.query.bind(client) : client;
  }

  async init() {
    for (const stmt of schemaStatements('postgres')) await this.rawQuery(stmt, []);
  }

  async query(sql, params) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const res = await this.rawQuery(pgSql, params);
    // node-postgres returns int8 (20) and numeric (1700) as strings; the
    // SQLite backend returns numbers, so coerce for parity.
    const numericTypes = new Set([20, 1700]);
    const numericFields = (res.fields || []).filter((f) => numericTypes.has(f.dataTypeID));
    if (numericFields.length) {
      for (const row of res.rows) {
        for (const f of numericFields) {
          if (typeof row[f.name] === 'string') row[f.name] = Number(row[f.name]);
        }
      }
    }
    return res;
  }

  prepare(sql) {
    const self = this;
    return {
      async get(...params) { return (await self.query(sql, params)).rows[0]; },
      async all(...params) { return (await self.query(sql, params)).rows; },
      async run(...params) {
        const isInsert = /^\s*insert\b/i.test(sql) && !/\breturning\b/i.test(sql);
        const res = await self.query(isInsert ? `${sql} RETURNING id` : sql, params);
        return {
          lastInsertRowid: isInsert ? res.rows[0]?.id : undefined,
          changes: res.rowCount,
        };
      },
    };
  }
}

// Chooses the backend: an explicit dbPath always means SQLite (tests, CLI);
// otherwise DATABASE_URL selects Postgres, with SQLite as the fallback.
async function openStorage({ dbPath } = {}) {
  const db = (!dbPath && process.env.DATABASE_URL)
    ? new PgDb(process.env.DATABASE_URL)
    : new SqliteDb(dbPath || process.env.MDC_DB || DEFAULT_DB_PATH);
  await db.init();
  return db;
}

module.exports = { openStorage, DEFAULT_DB_PATH };
