'use strict';

const { ApiError, created } = require('../web');
const {
  today, requireIsoDate, shiftDays, requireString, toBool, biddingOpen, parseMoneyField,
} = require('../util');

// Project lifecycle phases (the pipeline taxonomy). The legacy `status`
// column is kept in sync via PHASE_TO_STATUS for backward compatibility.
const PHASE_LABELS = {
  initiation: 'Initiation',
  bidding: 'Bidding',
  submitted_pending: 'Submitted / Pending',
  awarded_mobilizing: 'Awarded - Mobilizing',
  awarded_in_progress: 'Awarded - In Progress',
  awarded_closed: 'Awarded - Closed',
  no_bid: 'No Bid',
  lost: 'Lost',
  client_withdraw: 'Withdraw by Client',
};
const PHASE_TO_STATUS = {
  initiation: 'planning',
  bidding: 'bidding',
  submitted_pending: 'bidding',
  awarded_mobilizing: 'awarded',
  awarded_in_progress: 'active',
  awarded_closed: 'closed',
  no_bid: 'closed',
  lost: 'closed',
  client_withdraw: 'closed',
};
const STATUS_TO_PHASE = {
  planning: 'initiation',
  bidding: 'bidding',
  awarded: 'awarded_mobilizing',
  active: 'awarded_in_progress',
  closed: 'awarded_closed',
};

function effectivePhase(row) {
  return row.phase || STATUS_TO_PHASE[row.status] || 'bidding';
}

// Optional project detail fields: JSON name → column. Text fields take any
// string (empty clears); date fields must be YYYY-MM-DD when set.
const TEXT_FIELDS = {
  notes: 'notes',
  priority: 'priority',
  account: 'account',
  ownerName: 'owner_name',
  ownerEmail: 'owner_email',
  ownerPhone: 'owner_phone',
  address: 'address',
  proposalNotes: 'proposal_notes',
};
const DATE_FIELDS = {
  initialContactDate: 'initial_contact_date',
  siteVisitDate: 'site_visit_date',
  rfiDate: 'rfi_date',
  proposalSubmittedDate: 'proposal_submitted_date',
};

function collectDetailFields(body) {
  const updates = {};
  for (const [key, col] of Object.entries(TEXT_FIELDS)) {
    if (body[key] !== undefined) updates[col] = body[key] || null;
  }
  for (const [key, col] of Object.entries(DATE_FIELDS)) {
    if (body[key] !== undefined) {
      updates[col] = body[key] ? requireIsoDate(body[key], key) : null;
    }
  }
  return updates;
}

function requirePhase(value) {
  if (!PHASE_LABELS[value]) {
    throw new ApiError(422, 'invalid_phase', `phase must be one of ${Object.keys(PHASE_LABELS).join('|')}`);
  }
  return value;
}

const REMINDER_OFFSETS = { one_week: -7, final: -3 };
const REMINDER_LABELS = {
  one_week: '1-week reminder — 7 days before go-hard date',
  final: 'Final reminder — 3 days before go-hard date',
};

async function getProjectOr404(db, id) {
  const row = await db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
  if (!row) throw new ApiError(404, 'project_not_found', `No project with id ${id}`);
  return row;
}

function projectJson(row) {
  const phase = effectivePhase(row);
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    status: row.status,
    phase,
    phaseLabel: PHASE_LABELS[phase],
    category: row.category,
    proposalAmountCents: row.proposal_amount_cents,
    finalContractAmountCents: row.final_contract_amount_cents,
    notes: row.notes,
    priority: row.priority,
    account: row.account,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    ownerPhone: row.owner_phone,
    address: row.address,
    initialContactDate: row.initial_contact_date,
    siteVisitDate: row.site_visit_date,
    rfiDate: row.rfi_date,
    proposalSubmittedDate: row.proposal_submitted_date,
    proposalNotes: row.proposal_notes,
    goHardDate: row.go_hard_date,
    remindersAutomated: Boolean(row.reminders_automated),
    biddingOpen: biddingOpen(row),
    createdAt: row.created_at,
  };
}

function reminderJson(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    label: REMINDER_LABELS[row.kind],
    scheduledFor: row.scheduled_for,
    sentAt: row.sent_at,
    sentVia: row.sent_via,
  };
}

// Create or reschedule the project's reminder pair from its go-hard date.
// Already-sent reminders are left untouched.
async function syncReminders(db, project) {
  if (!project.go_hard_date) {
    await db.prepare('DELETE FROM reminders WHERE project_id = ? AND sent_at IS NULL').run(project.id);
    return;
  }
  for (const [kind, offset] of Object.entries(REMINDER_OFFSETS)) {
    const scheduledFor = shiftDays(project.go_hard_date, offset);
    const existing = await db.prepare(
      'SELECT * FROM reminders WHERE project_id = ? AND kind = ?'
    ).get(project.id, kind);
    if (!existing) {
      await db.prepare(
        'INSERT INTO reminders (project_id, kind, scheduled_for) VALUES (?, ?, ?)'
      ).run(project.id, kind, scheduledFor);
    } else if (!existing.sent_at) {
      await db.prepare('UPDATE reminders SET scheduled_for = ? WHERE id = ?').run(scheduledFor, existing.id);
    }
  }
}

function register(app, db) {
  app.get('/api/projects', async () => {
    const rows = await db.prepare('SELECT * FROM projects ORDER BY id').all();
    return rows.map(projectJson);
  });

  app.post('/api/projects', async ({ body }) => {
    const name = requireString(body, 'name');
    const code = requireString(body, 'code');
    let phase = 'bidding';
    if (body.phase !== undefined) phase = requirePhase(body.phase);
    else if (body.status !== undefined) {
      if (!STATUS_TO_PHASE[body.status]) {
        throw new ApiError(422, 'invalid_status', `status must be one of ${Object.keys(STATUS_TO_PHASE).join('|')}`);
      }
      phase = STATUS_TO_PHASE[body.status];
    }
    const proposal = parseMoneyField(body, 'proposalAmount');
    const finalContract = parseMoneyField(body, 'finalContractAmount');
    const goHardDate = body.goHardDate ? requireIsoDate(body.goHardDate, 'goHardDate') : null;
    const dup = await db.prepare('SELECT id FROM projects WHERE code = ?').get(code);
    if (dup) throw new ApiError(409, 'duplicate_code', `Project code ${code} already exists`);
    const result = await db.prepare(`
      INSERT INTO projects (name, code, status, phase, category, proposal_amount_cents,
                            final_contract_amount_cents, go_hard_date, reminders_automated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, code, PHASE_TO_STATUS[phase], phase,
      body.category || null, proposal ?? null, finalContract ?? null,
      goHardDate, toBool(body.remindersAutomated, true) ? 1 : 0);
    const details = collectDetailFields(body);
    if (Object.keys(details).length) {
      const sets = Object.keys(details).map((k) => `${k} = ?`).join(', ');
      await db.prepare(`UPDATE projects SET ${sets} WHERE id = ?`)
        .run(...Object.values(details), result.lastInsertRowid);
    }
    const project = await getProjectOr404(db, result.lastInsertRowid);
    await syncReminders(db, project);
    return created(projectJson(project));
  });

  app.get('/api/projects/:id', async ({ params }) => {
    const project = await getProjectOr404(db, params.id);
    const reminders = (await db.prepare(
      'SELECT * FROM reminders WHERE project_id = ? ORDER BY scheduled_for'
    ).all(project.id)).map(reminderJson);
    const counts = {
      sheets: (await db.prepare('SELECT COUNT(*) c FROM sheets WHERE project_id = ?').get(project.id)).c,
      rfis: (await db.prepare('SELECT COUNT(*) c FROM rfis WHERE project_id = ?').get(project.id)).c,
      bids: (await db.prepare('SELECT COUNT(*) c FROM bids WHERE project_id = ?').get(project.id)).c,
    };
    return { ...projectJson(project), reminders, counts };
  });

  app.patch('/api/projects/:id', async ({ params, body }) => {
    const project = await getProjectOr404(db, params.id);
    const updates = {};
    if (body.name !== undefined) updates.name = requireString(body, 'name');
    if (body.phase !== undefined) {
      updates.phase = requirePhase(body.phase);
      updates.status = PHASE_TO_STATUS[body.phase];
    } else if (body.status !== undefined) {
      if (!STATUS_TO_PHASE[body.status]) {
        throw new ApiError(422, 'invalid_status', `status must be one of ${Object.keys(STATUS_TO_PHASE).join('|')}`);
      }
      updates.status = body.status;
      updates.phase = STATUS_TO_PHASE[body.status];
    }
    if (body.category !== undefined) updates.category = body.category || null;
    Object.assign(updates, collectDetailFields(body));
    const proposal = parseMoneyField(body, 'proposalAmount');
    if (proposal !== undefined) updates.proposal_amount_cents = proposal;
    const finalContract = parseMoneyField(body, 'finalContractAmount');
    if (finalContract !== undefined) updates.final_contract_amount_cents = finalContract;
    if (body.goHardDate !== undefined) {
      updates.go_hard_date = body.goHardDate === null
        ? null
        : requireIsoDate(body.goHardDate, 'goHardDate');
    }
    if (body.remindersAutomated !== undefined) {
      updates.reminders_automated = toBool(body.remindersAutomated) ? 1 : 0;
    }
    if (Object.keys(updates).length === 0) {
      throw new ApiError(422, 'no_updates', 'No updatable fields provided');
    }
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    await db.prepare(`UPDATE projects SET ${sets} WHERE id = ?`).run(...Object.values(updates), project.id);
    const fresh = await getProjectOr404(db, project.id);
    if ('go_hard_date' in updates) await syncReminders(db, fresh);
    return projectJson(fresh);
  });

  // Removes the project and everything under it (sheets, RFIs, bids,
  // reminders) via FK cascade. Companies are shared and stay.
  app.delete('/api/projects/:id', async ({ params }) => {
    const project = await getProjectOr404(db, params.id);
    await db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    return { deleted: true, id: project.id };
  });

  app.get('/api/projects/:id/reminders', async ({ params }) => {
    const project = await getProjectOr404(db, params.id);
    return (await db.prepare('SELECT * FROM reminders WHERE project_id = ? ORDER BY scheduled_for')
      .all(project.id)).map(reminderJson);
  });

  // Manual "Send Now" from the bid schedule card.
  app.post('/api/reminders/:id/send', async ({ params }) => {
    const row = await db.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(params.id));
    if (!row) throw new ApiError(404, 'reminder_not_found', `No reminder with id ${params.id}`);
    if (row.sent_at) throw new ApiError(409, 'already_sent', `Reminder already sent ${row.sent_at}`);
    await db.prepare("UPDATE reminders SET sent_at = ?, sent_via = 'manual' WHERE id = ?")
      .run(today(), row.id);
    return reminderJson(await db.prepare('SELECT * FROM reminders WHERE id = ?').get(row.id));
  });

  // Automation sweep — idempotent; a scheduler (cron) hits this daily. Sends every
  // unsent reminder that is due for a project with automation enabled.
  app.post('/api/reminders/run', async () => {
    const due = await db.prepare(`
      SELECT r.* FROM reminders r
      JOIN projects p ON p.id = r.project_id
      WHERE r.sent_at IS NULL AND p.reminders_automated = 1 AND r.scheduled_for <= ?
    `).all(today());
    const sent = [];
    for (const r of due) {
      await db.prepare("UPDATE reminders SET sent_at = ?, sent_via = 'auto' WHERE id = ?")
        .run(today(), r.id);
      sent.push(reminderJson(await db.prepare('SELECT * FROM reminders WHERE id = ?').get(r.id)));
    }
    return { sent };
  });
}

module.exports = {
  register, projectJson, reminderJson, syncReminders, getProjectOr404,
  PHASE_LABELS, effectivePhase,
};
