'use strict';

const { ApiError } = require('./web');

// Current date as YYYY-MM-DD. Overridable for deterministic runs (tests, demos).
function today() {
  return process.env.MDC_TODAY || new Date().toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireIsoDate(value, field) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new ApiError(422, 'invalid_date', `${field} must be a YYYY-MM-DD date`);
  }
  return value;
}

function shiftDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function requireString(body, field) {
  const v = body?.[field];
  if (typeof v !== 'string' || !v.trim()) {
    throw new ApiError(422, 'missing_field', `${field} is required`);
  }
  return v.trim();
}

// Accepts amountCents (integer) or amount ("$1,240,000" / "1240000.50") → integer cents.
function parseAmountCents(body) {
  if (body.amountCents !== undefined && body.amountCents !== null) {
    if (!Number.isInteger(body.amountCents) || body.amountCents < 0) {
      throw new ApiError(422, 'invalid_amount', 'amountCents must be a non-negative integer');
    }
    return body.amountCents;
  }
  if (body.amount === undefined || body.amount === null || body.amount === '') return null;
  const cleaned = String(body.amount).replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) {
    throw new ApiError(422, 'invalid_amount', `Could not parse amount ${JSON.stringify(body.amount)}`);
  }
  return Math.round(n * 100);
}

// Spreadsheet placeholders that mean "no value": blank, NA, N/A, TBD, dashes.
const NA_TOKENS = new Set(['na', 'n/a', 'n.a.', 'none', 'tbd', '-', '--', '—']);
function isBlankLike(v) {
  return v === undefined || v === null
    || (typeof v === 'string' && (v.trim() === '' || NA_TOKENS.has(v.trim().toLowerCase())));
}

// Reads a named money field from a body: `${key}Cents` (integer) wins,
// otherwise `${key}` as dollars ("$460,474.37" or 460474.37). Returns
// undefined when neither is present, null when explicitly cleared or a
// blank/NA-style placeholder.
function parseMoneyField(body, key) {
  const cents = body[`${key}Cents`];
  if (cents !== undefined && cents !== null) {
    if (!Number.isInteger(cents) || cents < 0) {
      throw new ApiError(422, 'invalid_amount', `${key}Cents must be a non-negative integer`);
    }
    return cents;
  }
  if (!(key in body)) return undefined;
  const v = body[key];
  if (isBlankLike(v)) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) {
    throw new ApiError(422, 'invalid_amount', `Could not parse ${key} ${JSON.stringify(v)}`);
  }
  return Math.round(n * 100);
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function biddingOpen(project, asOf = today()) {
  // Mirrors the Plan Room UI: bidding closes ON the go-hard date.
  return Boolean(project.go_hard_date) && asOf < project.go_hard_date;
}

module.exports = {
  today,
  requireIsoDate,
  shiftDays,
  requireString,
  parseAmountCents,
  parseMoneyField,
  isBlankLike,
  toBool,
  biddingOpen,
};
