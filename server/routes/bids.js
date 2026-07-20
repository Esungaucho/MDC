'use strict';

const { ApiError, created } = require('../web');
const {
  requireString, parseAmountCents, toBool, getProjectOr404, biddingOpen,
} = require('../util');

const BID_STATUSES = ['submitted', 'final_list', 'awarded', 'declined'];

function companyJson(row) {
  return {
    id: row.id,
    name: row.name,
    trade: row.trade,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    inDirectory: Boolean(row.in_directory),
    w9Received: Boolean(row.w9_received),
    coiReceived: Boolean(row.coi_received),
  };
}

function bidJson(db, row) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(row.company_id);
  return {
    id: row.id,
    projectId: row.project_id,
    company: companyJson(company),
    trade: row.trade,
    amountCents: row.amount_cents,
    notes: row.notes,
    status: row.status,
    submittedAt: row.submitted_at,
  };
}

function findCompanyByName(db, name) {
  return db.prepare('SELECT * FROM companies WHERE name = ? COLLATE NOCASE').get(name.trim());
}

function register(app, db) {
  // --- Subcontractor directory ---

  app.get('/api/companies', ({ query }) => {
    const q = query.get('query');
    let rows = db.prepare('SELECT * FROM companies ORDER BY name').all();
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q.toLowerCase()));
    if (query.get('inDirectory') === 'true') rows = rows.filter((r) => r.in_directory);
    return rows.map(companyJson);
  });

  // Directory status check used by the bid form as the company name is typed.
  app.get('/api/companies/check', ({ query }) => {
    const name = query.get('name');
    if (!name || !name.trim()) throw new ApiError(422, 'missing_field', 'name query param is required');
    const row = findCompanyByName(db, name);
    return {
      name: name.trim(),
      known: Boolean(row),
      inDirectory: Boolean(row && row.in_directory),
      requiredDocs: row && row.in_directory ? [] : [
        ...(row && row.w9_received ? [] : ['w9']),
        ...(row && row.coi_received ? [] : ['coi']),
      ],
    };
  });

  app.post('/api/companies', ({ body }) => {
    const name = requireString(body, 'name');
    if (findCompanyByName(db, name)) {
      throw new ApiError(409, 'duplicate_company', `Company ${name} already exists`);
    }
    const result = db.prepare(`
      INSERT INTO companies (name, trade, contact_name, email, phone, in_directory, w9_received, coi_received)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, body.trade || null, body.contactName || null, body.email || null,
      body.phone || null, toBool(body.inDirectory) ? 1 : 0,
      toBool(body.w9Received) ? 1 : 0, toBool(body.coiReceived) ? 1 : 0);
    return created(companyJson(db.prepare('SELECT * FROM companies WHERE id = ?').get(result.lastInsertRowid)));
  });

  app.patch('/api/companies/:id', ({ params, body }) => {
    const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(Number(params.id));
    if (!row) throw new ApiError(404, 'company_not_found', `No company with id ${params.id}`);
    const map = {
      trade: 'trade', contactName: 'contact_name', email: 'email', phone: 'phone',
    };
    const updates = {};
    for (const [key, col] of Object.entries(map)) {
      if (body[key] !== undefined) updates[col] = body[key];
    }
    const boolMap = { inDirectory: 'in_directory', w9Received: 'w9_received', coiReceived: 'coi_received' };
    for (const [key, col] of Object.entries(boolMap)) {
      if (body[key] !== undefined) updates[col] = toBool(body[key]) ? 1 : 0;
    }
    if (Object.keys(updates).length === 0) {
      throw new ApiError(422, 'no_updates', 'No updatable fields provided');
    }
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE companies SET ${sets} WHERE id = ?`).run(...Object.values(updates), row.id);
    return companyJson(db.prepare('SELECT * FROM companies WHERE id = ?').get(row.id));
  });

  // --- Bids ---

  app.get('/api/projects/:id/bids', ({ params, query }) => {
    const project = getProjectOr404(db, params.id);
    let rows = db.prepare('SELECT * FROM bids WHERE project_id = ? ORDER BY submitted_at DESC, id DESC')
      .all(project.id);
    const status = query.get('status');
    if (status) rows = rows.filter((r) => r.status === status);
    return rows.map((r) => bidJson(db, r));
  });

  // Bid submittal — enforces the go-hard date and the new-vendor W-9/COI rule.
  app.post('/api/projects/:id/bids', ({ params, body }) => {
    const project = getProjectOr404(db, params.id);
    if (!biddingOpen(project)) {
      throw new ApiError(409, 'bidding_closed',
        `Bidding closed on the go-hard date (${project.go_hard_date ?? 'not set'}). New bid submittals can no longer be entered.`);
    }
    const companyName = requireString(body, 'company');
    const trade = requireString(body, 'trade');
    const amountCents = parseAmountCents(body);

    let company = findCompanyByName(db, companyName);
    const w9 = toBool(body.w9Uploaded, Boolean(company && company.w9_received));
    const coi = toBool(body.coiUploaded, Boolean(company && company.coi_received));
    const inDirectory = Boolean(company && company.in_directory);
    if (!inDirectory && (!w9 || !coi)) {
      throw new ApiError(422, 'vendor_docs_required',
        `${companyName} isn't in the subcontractor directory yet — a W-9 and Certificate of Insurance are required before the bid is finalized.`,
        { missing: [...(w9 ? [] : ['w9']), ...(coi ? [] : ['coi'])] });
    }

    if (!company) {
      const result = db.prepare(`
        INSERT INTO companies (name, trade, contact_name, email, phone, in_directory, w9_received, coi_received)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `).run(companyName, trade, body.contactName || null, body.email || null,
        body.phone || null, w9 ? 1 : 0, coi ? 1 : 0);
      company = db.prepare('SELECT * FROM companies WHERE id = ?').get(result.lastInsertRowid);
    } else {
      db.prepare('UPDATE companies SET w9_received = ?, coi_received = ? WHERE id = ?')
        .run(w9 ? 1 : 0, coi ? 1 : 0, company.id);
    }

    const dup = db.prepare(
      'SELECT id FROM bids WHERE project_id = ? AND company_id = ? AND trade = ?'
    ).get(project.id, company.id, trade);
    if (dup) {
      throw new ApiError(409, 'duplicate_bid',
        `${companyName} already has a ${trade} bid on this project`);
    }

    const result = db.prepare(`
      INSERT INTO bids (project_id, company_id, trade, amount_cents, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(project.id, company.id, trade, amountCents, body.notes || null);
    return created(bidJson(db, db.prepare('SELECT * FROM bids WHERE id = ?').get(result.lastInsertRowid)));
  });

  // Status moves: submitted ↔ final_list (the "Final Bid List"), awarded, declined.
  app.patch('/api/bids/:id', ({ params, body }) => {
    const row = db.prepare('SELECT * FROM bids WHERE id = ?').get(Number(params.id));
    if (!row) throw new ApiError(404, 'bid_not_found', `No bid with id ${params.id}`);
    const updates = {};
    if (body.status !== undefined) {
      if (!BID_STATUSES.includes(body.status)) {
        throw new ApiError(422, 'invalid_status', `status must be one of ${BID_STATUSES.join('|')}`);
      }
      updates.status = body.status;
    }
    if (body.amountCents !== undefined || body.amount !== undefined) {
      updates.amount_cents = parseAmountCents(body);
    }
    if (body.notes !== undefined) updates.notes = body.notes;
    if (Object.keys(updates).length === 0) {
      throw new ApiError(422, 'no_updates', 'No updatable fields provided');
    }
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE bids SET ${sets} WHERE id = ?`).run(...Object.values(updates), row.id);
    return bidJson(db, db.prepare('SELECT * FROM bids WHERE id = ?').get(row.id));
  });
}

module.exports = { register };
