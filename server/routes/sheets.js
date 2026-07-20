'use strict';

const { ApiError, created } = require('../web');
const { requireString, requireIsoDate, toBool, today } = require('../util');
const { getProjectOr404 } = require('./projects');

async function sheetJson(db, row) {
  const current = await db.prepare(
    'SELECT * FROM sheet_revisions WHERE sheet_id = ? AND is_current = 1'
  ).get(row.id);
  const revisionCount = (await db.prepare(
    'SELECT COUNT(*) c FROM sheet_revisions WHERE sheet_id = ?'
  ).get(row.id)).c;
  const openRfiCount = (await db.prepare(
    "SELECT COUNT(*) c FROM rfis WHERE sheet_id = ? AND status = 'open'"
  ).get(row.id)).c;
  return {
    id: row.id,
    projectId: row.project_id,
    sheetNumber: row.sheet_number,
    title: row.title,
    discipline: row.discipline,
    superseded: Boolean(row.superseded),
    currentRev: current ? current.rev : null,
    currentRevIssuedDate: current ? current.issued_date : null,
    revisionCount,
    openRfiCount,
  };
}

async function getSheetOr404(db, id) {
  const row = await db.prepare('SELECT * FROM sheets WHERE id = ?').get(Number(id));
  if (!row) throw new ApiError(404, 'sheet_not_found', `No sheet with id ${id}`);
  return row;
}

function register(app, db) {
  // Sheet index — flat list; ?discipline= filters, ?includeSuperseded=false hides superseded.
  app.get('/api/projects/:id/sheets', async ({ params, query }) => {
    const project = await getProjectOr404(db, params.id);
    let rows = await db.prepare(
      'SELECT * FROM sheets WHERE project_id = ? ORDER BY discipline, sheet_number'
    ).all(project.id);
    if (query.get('discipline')) {
      rows = rows.filter((r) => r.discipline === query.get('discipline'));
    }
    if (query.get('includeSuperseded') === 'false') {
      rows = rows.filter((r) => !r.superseded);
    }
    const out = [];
    for (const r of rows) out.push(await sheetJson(db, r));
    return out;
  });

  app.post('/api/projects/:id/sheets', async ({ params, body }) => {
    const project = await getProjectOr404(db, params.id);
    const sheetNumber = requireString(body, 'sheetNumber');
    const title = requireString(body, 'title');
    const discipline = requireString(body, 'discipline');
    const dup = await db.prepare(
      'SELECT id FROM sheets WHERE project_id = ? AND sheet_number = ?'
    ).get(project.id, sheetNumber);
    if (dup) {
      throw new ApiError(409, 'duplicate_sheet', `Sheet ${sheetNumber} already exists on this project`);
    }
    const rev = body.rev === undefined ? 1 : body.rev;
    if (!Number.isInteger(rev) || rev < 0) {
      throw new ApiError(422, 'invalid_rev', 'rev must be a non-negative integer');
    }
    const result = await db.prepare(
      'INSERT INTO sheets (project_id, sheet_number, title, discipline, superseded) VALUES (?, ?, ?, ?, ?)'
    ).run(project.id, sheetNumber, title, discipline, toBool(body.superseded) ? 1 : 0);
    await db.prepare(
      'INSERT INTO sheet_revisions (sheet_id, rev, is_current, issued_date, file_name) VALUES (?, ?, 1, ?, ?)'
    ).run(result.lastInsertRowid,
      rev,
      body.issuedDate ? requireIsoDate(body.issuedDate, 'issuedDate') : today(),
      body.fileName || null);
    return created(await sheetJson(db, await getSheetOr404(db, result.lastInsertRowid)));
  });

  app.get('/api/sheets/:id', async ({ params }) => {
    const sheet = await getSheetOr404(db, params.id);
    const revisions = (await db.prepare(
      'SELECT * FROM sheet_revisions WHERE sheet_id = ? ORDER BY rev DESC'
    ).all(sheet.id)).map((r) => ({
      id: r.id,
      rev: r.rev,
      isCurrent: Boolean(r.is_current),
      issuedDate: r.issued_date,
      fileName: r.file_name,
    }));
    const rfis = (await db.prepare(
      'SELECT id, rfi_number, subject, status, pin_x, pin_y FROM rfis WHERE sheet_id = ? ORDER BY rfi_number'
    ).all(sheet.id)).map((r) => ({
      id: r.id,
      rfiNumber: r.rfi_number,
      subject: r.subject,
      status: r.status,
      pin: r.pin_x === null ? null : { x: r.pin_x, y: r.pin_y },
    }));
    return { ...(await sheetJson(db, sheet)), revisions, rfis };
  });

  app.patch('/api/sheets/:id', async ({ params, body }) => {
    const sheet = await getSheetOr404(db, params.id);
    const updates = {};
    if (body.title !== undefined) updates.title = requireString(body, 'title');
    if (body.discipline !== undefined) updates.discipline = requireString(body, 'discipline');
    if (body.superseded !== undefined) updates.superseded = toBool(body.superseded) ? 1 : 0;
    if (Object.keys(updates).length === 0) {
      throw new ApiError(422, 'no_updates', 'No updatable fields provided');
    }
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    await db.prepare(`UPDATE sheets SET ${sets} WHERE id = ?`).run(...Object.values(updates), sheet.id);
    return sheetJson(db, await getSheetOr404(db, sheet.id));
  });

  // Issue a new revision — supersedes the current one.
  app.post('/api/sheets/:id/revisions', async ({ params, body }) => {
    const sheet = await getSheetOr404(db, params.id);
    const maxRev = (await db.prepare(
      'SELECT MAX(rev) m FROM sheet_revisions WHERE sheet_id = ?'
    ).get(sheet.id)).m;
    const rev = body.rev === undefined ? (maxRev === null ? 1 : maxRev + 1) : body.rev;
    if (!Number.isInteger(rev) || rev < 0) {
      throw new ApiError(422, 'invalid_rev', 'rev must be a non-negative integer');
    }
    if (maxRev !== null && rev <= maxRev) {
      throw new ApiError(409, 'stale_rev', `rev must be greater than current max (${maxRev})`);
    }
    await db.prepare('UPDATE sheet_revisions SET is_current = 0 WHERE sheet_id = ?').run(sheet.id);
    await db.prepare(
      'INSERT INTO sheet_revisions (sheet_id, rev, is_current, issued_date, file_name) VALUES (?, ?, 1, ?, ?)'
    ).run(sheet.id,
      rev,
      body.issuedDate ? requireIsoDate(body.issuedDate, 'issuedDate') : today(),
      body.fileName || null);
    return created(await sheetJson(db, sheet));
  });
}

module.exports = { register, getSheetOr404 };
