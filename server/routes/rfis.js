'use strict';

const { ApiError, created } = require('../web');
const { requireString } = require('../util');
const { getProjectOr404 } = require('./projects');

const STATUSES = ['open', 'answered', 'closed'];

async function rfiJson(db, row) {
  const sheet = row.sheet_id
    ? await db.prepare('SELECT sheet_number, discipline FROM sheets WHERE id = ?').get(row.sheet_id)
    : null;
  return {
    id: row.id,
    projectId: row.project_id,
    rfiNumber: row.rfi_number,
    displayId: `RFI-${String(row.rfi_number).padStart(3, '0')}`,
    subject: row.subject,
    question: row.question,
    sheetId: row.sheet_id,
    sheetNumber: sheet ? sheet.sheet_number : null,
    discipline: sheet ? sheet.discipline : null,
    status: row.status,
    answer: row.answer,
    submittedBy: row.submitted_by,
    pin: row.pin_x === null ? null : { x: row.pin_x, y: row.pin_y },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function resolveSheet(db, projectId, body) {
  if (body.sheetId !== undefined && body.sheetId !== null) {
    const sheet = await db.prepare('SELECT * FROM sheets WHERE id = ? AND project_id = ?')
      .get(Number(body.sheetId), projectId);
    if (!sheet) throw new ApiError(422, 'unknown_sheet', `sheetId ${body.sheetId} is not on this project`);
    return sheet;
  }
  if (body.sheetNumber) {
    const sheet = await db.prepare('SELECT * FROM sheets WHERE project_id = ? AND sheet_number = ?')
      .get(projectId, body.sheetNumber);
    if (!sheet) throw new ApiError(422, 'unknown_sheet', `Sheet ${body.sheetNumber} is not on this project`);
    return sheet;
  }
  return null;
}

function validatePin(pin) {
  if (pin === undefined || pin === null) return null;
  const x = Number(pin.x);
  const y = Number(pin.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
    throw new ApiError(422, 'invalid_pin', 'pin.x and pin.y must be percentages between 0 and 100');
  }
  return { x, y };
}

function register(app, db) {
  app.get('/api/projects/:id/rfis', async ({ params, query }) => {
    const project = await getProjectOr404(db, params.id);
    let sql = 'SELECT * FROM rfis WHERE project_id = ?';
    const args = [project.id];
    const status = query.get('status');
    if (status) {
      if (!STATUSES.includes(status)) {
        throw new ApiError(422, 'invalid_status', `status must be one of ${STATUSES.join('|')}`);
      }
      sql += ' AND status = ?';
      args.push(status);
    }
    sql += ' ORDER BY rfi_number DESC';
    const rows = await db.prepare(sql).all(...args);
    const out = [];
    for (const r of rows) out.push(await rfiJson(db, r));
    return out;
  });

  app.post('/api/projects/:id/rfis', async ({ params, body }) => {
    const project = await getProjectOr404(db, params.id);
    const subject = requireString(body, 'subject');
    const sheet = await resolveSheet(db, project.id, body);
    const pin = validatePin(body.pin);
    if (pin && !sheet) {
      throw new ApiError(422, 'pin_requires_sheet', 'A pinned RFI must reference a sheet');
    }
    const next = (await db.prepare(
      'SELECT COALESCE(MAX(rfi_number), 0) + 1 n FROM rfis WHERE project_id = ?'
    ).get(project.id)).n;
    const result = await db.prepare(`
      INSERT INTO rfis (project_id, rfi_number, subject, question, sheet_id, submitted_by, pin_x, pin_y)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(project.id, next, subject, body.question || null,
      sheet ? sheet.id : null, body.submittedBy || null,
      pin ? pin.x : null, pin ? pin.y : null);
    return created(await rfiJson(db,
      await db.prepare('SELECT * FROM rfis WHERE id = ?').get(result.lastInsertRowid)));
  });

  app.get('/api/rfis/:id', async ({ params }) => {
    const row = await db.prepare('SELECT * FROM rfis WHERE id = ?').get(Number(params.id));
    if (!row) throw new ApiError(404, 'rfi_not_found', `No RFI with id ${params.id}`);
    return rfiJson(db, row);
  });

  app.patch('/api/rfis/:id', async ({ params, body }) => {
    const row = await db.prepare('SELECT * FROM rfis WHERE id = ?').get(Number(params.id));
    if (!row) throw new ApiError(404, 'rfi_not_found', `No RFI with id ${params.id}`);
    const updates = {};
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) {
        throw new ApiError(422, 'invalid_status', `status must be one of ${STATUSES.join('|')}`);
      }
      updates.status = body.status;
    }
    if (body.answer !== undefined) updates.answer = body.answer;
    if (body.subject !== undefined) updates.subject = requireString(body, 'subject');
    if (body.question !== undefined) updates.question = body.question;
    if (body.pin !== undefined) {
      const pin = validatePin(body.pin);
      updates.pin_x = pin ? pin.x : null;
      updates.pin_y = pin ? pin.y : null;
    }
    if (Object.keys(updates).length === 0) {
      throw new ApiError(422, 'no_updates', 'No updatable fields provided');
    }
    updates.updated_at = new Date().toISOString();
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    await db.prepare(`UPDATE rfis SET ${sets} WHERE id = ?`).run(...Object.values(updates), row.id);
    return rfiJson(db, await db.prepare('SELECT * FROM rfis WHERE id = ?').get(row.id));
  });
}

module.exports = { register };
