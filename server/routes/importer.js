'use strict';

// POST /api/import/projects — bulk import from an uploaded .xlsx workbook or
// CSV/TSV text. Columns are matched by header name when a header row is
// present (any order), falling back to the pipeline spreadsheet's positional
// layout. Owner contact and address columns are recognized and discarded —
// proprietary data is never stored.

const { ApiError } = require('../web');
const { readFirstSheet, excelSerialToIsoDate } = require('../xlsx');
const { createProject } = require('./projects');

// normalized header → API field. null = recognized but intentionally dropped.
const HEADER_MAP = {
  projectname: 'name',
  name: 'name',
  phase: 'phase',
  notes: 'notes',
  priority: 'priority',
  category: 'category',
  account: 'account',
  code: 'code',
  initialcontactdate: 'initialContactDate',
  sitevisitdate: 'siteVisitDate',
  rfidate: 'rfiDate',
  bidduedate: 'goHardDate',
  goharddate: 'goHardDate',
  proposalsubmitteddate: 'proposalSubmittedDate',
  proposalamount: 'proposalAmount',
  finalcontractamount: 'finalContractAmount',
  proposalcontractnotes: 'proposalNotes',
  proposalnotes: 'proposalNotes',
  ownername: null,
  owneremail: null,
  ownerphone: null,
  projectaddress: null,
  address: null,
};

// The spreadsheet's column order, used when no header row is present.
// Positions 6-9 are the owner/address columns, intentionally dropped.
const POSITIONAL = [
  'name', 'phase', 'notes', 'priority', 'category', 'account',
  null, null, null, null,
  'initialContactDate', 'siteVisitDate', 'rfiDate', 'goHardDate',
  'proposalSubmittedDate', 'proposalAmount', 'finalContractAmount', 'proposalNotes',
];

const DATE_FIELDS = new Set([
  'initialContactDate', 'siteVisitDate', 'rfiDate', 'goHardDate', 'proposalSubmittedDate',
]);
const MONEY_FIELDS = new Set(['proposalAmount', 'finalContractAmount']);

function normalizeHeader(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

function phaseSlug(text) {
  const key = String(text ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const map = {
    '': 'bidding',
    'initiation': 'initiation',
    'bidding': 'bidding',
    'submitted pending': 'submitted_pending',
    'submitted': 'submitted_pending',
    'pending': 'submitted_pending',
    'awarded mobilizing': 'awarded_mobilizing',
    'awarded in progress': 'awarded_in_progress',
    'awarded closed': 'awarded_closed',
    'no bid': 'no_bid',
    'lost': 'lost',
    'withdraw by client': 'client_withdraw',
    'client withdraw': 'client_withdraw',
    'withdrawn by client': 'client_withdraw',
  };
  return map[key] ?? null;
}

function toIsoDate(value) {
  if (typeof value === 'number') return excelSerialToIsoDate(value);
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new ApiError(422, 'invalid_date', `Could not parse date ${JSON.stringify(s)}`);
  }
  // Interpret bare dates like "8/17/2026" in local time, then take the date.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function splitLine(line, delim) {
  if (!line.includes('"')) return line.split(delim).map((s) => s.trim());
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseDelimitedText(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = lines[0].includes('\t') ? '\t' : ',';
  return lines.map((line) => splitLine(line, delim));
}

function codeFromName(name) {
  const initials = name.split(/\s+/).map((w) => w[0]).join('')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  return `${initials || 'PRJ'}-${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
}

// Decides field mapping from the first row. Returns { fields, dataStart }.
function detectLayout(rows) {
  const first = rows[0] || [];
  const mapped = first.map((cell) => {
    const key = normalizeHeader(cell);
    return key in HEADER_MAP ? HEADER_MAP[key] : undefined;
  });
  const recognized = mapped.filter((m) => m !== undefined).length;
  if (recognized >= 2 && mapped.includes('name')) {
    return { fields: mapped.map((m) => m ?? null), dataStart: 1 };
  }
  return { fields: POSITIONAL, dataStart: 0 };
}

function rowToBody(row, fields) {
  const body = {};
  fields.forEach((field, i) => {
    const value = row[i];
    if (!field || value === null || value === undefined || value === '') return;
    if (DATE_FIELDS.has(field)) body[field] = toIsoDate(value);
    else if (MONEY_FIELDS.has(field) && typeof value === 'number') {
      body[`${field}Cents`] = Math.round(value * 100);
    } else body[field] = String(value).trim();
  });
  return body;
}

function register(app, db) {
  app.post('/api/import/projects', async ({ body, rawBody }) => {
    let rows;
    if (rawBody && rawBody.length >= 4 && rawBody.readUInt32LE(0) === 0x04034b50) {
      rows = readFirstSheet(rawBody); // "PK\x03\x04" — an .xlsx upload
    } else if (body && Array.isArray(body.rows)) {
      rows = body.rows; // pre-parsed rows as JSON
    } else if (rawBody && rawBody.length) {
      rows = parseDelimitedText(rawBody.toString('utf8'));
    } else {
      throw new ApiError(422, 'empty_import', 'Upload an .xlsx file, CSV/TSV text, or JSON {rows: [...]}');
    }
    if (!rows.length) throw new ApiError(422, 'empty_import', 'No rows found in the upload');

    const { fields, dataStart } = detectLayout(rows);
    const results = { created: 0, skipped: 0, failed: [] };
    for (let i = dataStart; i < rows.length; i++) {
      const rowNum = i + 1;
      let payload;
      try {
        payload = rowToBody(rows[i], fields);
      } catch (err) {
        results.failed.push({ row: rowNum, error: err.message });
        continue;
      }
      if (!payload.name) { results.skipped++; continue; }
      const phase = phaseSlug(payload.phase);
      if (phase === null) {
        results.failed.push({ row: rowNum, name: payload.name, error: `Unknown phase "${payload.phase}"` });
        continue;
      }
      payload.phase = phase;
      if (!payload.code) payload.code = codeFromName(payload.name);
      try {
        await createProject(db, payload);
        results.created++;
      } catch (err) {
        results.failed.push({ row: rowNum, name: payload.name, error: err.message });
      }
    }
    return results;
  });
}

module.exports = { register };
