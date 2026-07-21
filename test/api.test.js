'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createServer } = require('../server/app');
const { seed } = require('../server/seed');

// Freeze "today" to the design's reference date so seeded go-hard dates and
// reminder schedules are deterministic.
process.env.MDC_TODAY = '2026-07-20';

async function boot() {
  const { server, db } = await createServer({ dbPath: ':memory:' });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const base = `http://localhost:${server.address().port}`;
      const request = async (method, path, body) => {
        const res = await fetch(base + path, {
          method,
          headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
      };
      resolve({ server, db, request });
    });
  });
}

let seeded; // server seeded with the demo portfolio
let fresh;  // empty server for CRUD tests

before(async () => {
  seeded = await boot();
  await seed(seeded.db);
  fresh = await boot();
});

after(() => {
  seeded.server.close();
  fresh.server.close();
});

test('health check responds', async () => {
  const { status, body } = await fresh.request('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

// --- Pipeline rollup over seeded data ---

test('pipeline rolls up all projects', async () => {
  const { status, body } = await seeded.request('GET', '/api/pipeline');
  assert.equal(status, 200);
  assert.equal(body.asOf, '2026-07-20');
  assert.equal(body.totals.projects, 3);
  assert.equal(body.totals.biddingOpen, 2);
  assert.equal(body.totals.sheets, 19);
  assert.equal(body.totals.openRfis, 2);
  assert.equal(body.totals.bidsReceived, 7);

  const mot = body.projects.find((p) => p.code === 'MOT-2026');
  assert.equal(mot.biddingStatus, 'open');
  assert.equal(mot.daysToGoHard, 28);
  assert.equal(mot.sheets.total, 11);
  assert.equal(mot.sheets.byDiscipline.Architectural, 4);
  assert.equal(mot.sheets.superseded, 1);
  assert.deepEqual(
    { open: mot.rfis.open, answered: mot.rfis.answered, closed: mot.rfis.closed },
    { open: 1, answered: 1, closed: 1 });
  assert.equal(mot.rfis.pinned, 1);
  assert.equal(mot.bids.count, 1);
  assert.equal(mot.bids.lowCents, 124_000_000);
  assert.deepEqual(mot.bids.tradesCovered, ['Steel']);

  const esp = body.projects.find((p) => p.code === 'ESP-2026');
  assert.equal(esp.biddingStatus, 'closed');
  assert.equal(esp.bids.awarded, 1);
  assert.equal(esp.bids.awardedCents, 411_000_000);

  const hmp = body.projects.find((p) => p.code === 'HMP-2026');
  assert.equal(hmp.bids.newVendorBids, 1); // Northgate Roofing

  // Portfolio-wide breakdowns for the composition charts.
  assert.deepEqual(body.breakdowns.bidValueByTrade[0],
    { trade: 'Concrete', count: 2, totalCents: 709_500_000 });
  assert.equal(body.breakdowns.bidValueByTrade.length, 4);
  assert.deepEqual(body.breakdowns.sheetsByDiscipline[0], { discipline: 'Architectural', count: 7 });
  assert.deepEqual(body.breakdowns.rfisByStatus, { open: 2, answered: 1, closed: 1 });
});

test('phase and category rollups', async () => {
  const { body } = await seeded.request('GET', '/api/pipeline');
  const b = body.breakdowns;

  const byPhase = Object.fromEntries(b.projectsByPhase.map((r) => [r.phase, r]));
  assert.equal(byPhase.bidding.count, 1);
  assert.equal(byPhase.submitted_pending.count, 1);
  assert.equal(byPhase.awarded_closed.count, 1);
  assert.equal(byPhase.bidding.pct, 33.3);

  const potential = Object.fromEntries(b.pipelinePotential.rows.map((r) => [r.phase, r.proposalCents]));
  assert.equal(potential.bidding, 70_000_000);
  assert.equal(potential.submitted_pending, 46_056_000);
  assert.equal(b.pipelinePotential.totalCents, 116_056_000);

  // Awarded-closed uses the final contract amount; 100% of decided value.
  const closed = b.winLoss.rows.find((r) => r.phase === 'awarded_closed');
  assert.equal(closed.valueCents, 44_972_437);
  assert.equal(closed.pct, 100);

  const activeCats = Object.fromEntries(b.projectsByCategory.active.map((r) => [r.category, r]));
  assert.equal(activeCats['Commercial New'].proposalCents, 70_000_000);
  assert.equal(activeCats['Commercial Upfit'].proposalCents, 46_056_000);
  assert.deepEqual(b.projectsByCategory.postAward.phases, ['awarded_closed']);
  assert.equal(b.projectsByCategory.postAward.rows[0].byPhase.awarded_closed, 44_972_437);

  // Full spreadsheet detail fields round-trip. Owner contact and address are
  // proprietary and intentionally not stored — sending them is a no-op.
  const detailed = (await fresh.request('POST', '/api/projects', {
    name: 'Detail Test', code: 'DT-1', phase: 'initiation',
    category: 'Residential Renovation', priority: 'High', account: 'Acme Holdings',
    ownerName: 'J. Smith', ownerEmail: 'j@acme.com', ownerPhone: '(555) 555-0101',
    address: '12 Main St', notes: 'Referred by architect',
    initialContactDate: '2026-06-01', siteVisitDate: '2026-06-10',
    rfiDate: '2026-06-20', proposalSubmittedDate: '2026-07-01',
    proposalAmount: '$462,000.00', proposalNotes: 'Includes alternates',
  })).body;
  assert.equal(detailed.account, 'Acme Holdings');
  assert.equal(detailed.ownerEmail, undefined);
  assert.equal(detailed.ownerName, undefined);
  assert.equal(detailed.address, undefined);
  assert.equal(detailed.siteVisitDate, '2026-06-10');
  assert.equal(detailed.proposalAmountCents, 46_200_000);
  const fetched = (await fresh.request('GET', `/api/projects/${detailed.id}`)).body;
  assert.equal(fetched.proposalNotes, 'Includes alternates');
  const patched = (await fresh.request('PATCH', `/api/projects/${detailed.id}`, {
    priority: 'Low', rfiDate: null,
  })).body;
  assert.equal(patched.priority, 'Low');
  assert.equal(patched.rfiDate, null);

  // Phase moves via PATCH update both phase and legacy status.
  const proj = (await fresh.request('POST', '/api/projects', {
    name: 'Phase Test', code: 'PH-1', phase: 'submitted_pending',
    category: 'Residential New', proposalAmount: '$514,935.00',
  })).body;
  assert.equal(proj.phaseLabel, 'Submitted / Pending');
  assert.equal(proj.proposalAmountCents, 51_493_500);
  const moved = (await fresh.request('PATCH', `/api/projects/${proj.id}`, {
    phase: 'lost',
  })).body;
  assert.equal(moved.phase, 'lost');
  assert.equal(moved.status, 'closed');
});

test('seed refuses to run twice without force', async () => {
  const result = await seed(seeded.db);
  assert.equal(result.seeded, false);
});

// --- Projects & reminders ---

test('project create schedules reminders from go-hard date', async () => {
  const { status, body } = await fresh.request('POST', '/api/projects', {
    name: 'Test Tower', code: 'TT-1', goHardDate: '2026-08-17',
  });
  assert.equal(status, 201);
  assert.equal(body.biddingOpen, true);

  const rem = (await fresh.request('GET', `/api/projects/${body.id}/reminders`)).body;
  assert.deepEqual(rem.map((r) => [r.kind, r.scheduledFor]).sort(),
    [['final', '2026-08-14'], ['one_week', '2026-08-10']]);

  // Moving the go-hard date reschedules unsent reminders.
  await fresh.request('PATCH', `/api/projects/${body.id}`, { goHardDate: '2026-09-01' });
  const rem2 = (await fresh.request('GET', `/api/projects/${body.id}/reminders`)).body;
  assert.deepEqual(rem2.map((r) => r.scheduledFor).sort(), ['2026-08-25', '2026-08-29']);
});

test('project delete cascades', async () => {
  const proj = (await fresh.request('POST', '/api/projects', {
    name: 'Doomed', code: 'DEL-1', goHardDate: '2026-12-01',
  })).body;
  await fresh.request('POST', `/api/projects/${proj.id}/sheets`, {
    sheetNumber: 'X-1', title: 'Sheet', discipline: 'Architectural',
  });
  const del = await fresh.request('DELETE', `/api/projects/${proj.id}`);
  assert.equal(del.status, 200);
  assert.equal((await fresh.request('GET', `/api/projects/${proj.id}`)).status, 404);
});

test('duplicate project code is rejected', async () => {
  await fresh.request('POST', '/api/projects', { name: 'A', code: 'DUP-1' });
  const { status, body } = await fresh.request('POST', '/api/projects', { name: 'B', code: 'DUP-1' });
  assert.equal(status, 409);
  assert.equal(body.error, 'duplicate_code');
});

test('reminder automation sweep sends only due reminders', async () => {
  // go-hard in 4 days: one_week reminder (T-7) is past due, final (T-3) is not.
  const proj = (await fresh.request('POST', '/api/projects', {
    name: 'Sweep', code: 'SW-1', goHardDate: '2026-07-24',
  })).body;
  const { body } = await fresh.request('POST', '/api/reminders/run');
  const sentHere = body.sent.filter((r) => r.projectId === proj.id);
  assert.deepEqual(sentHere.map((r) => [r.kind, r.sentVia]), [['one_week', 'auto']]);

  // Second sweep is a no-op for this project.
  const again = await fresh.request('POST', '/api/reminders/run');
  assert.equal(again.body.sent.filter((r) => r.projectId === proj.id).length, 0);

  // Manual send of the final reminder; re-sending conflicts.
  const rem = (await fresh.request('GET', `/api/projects/${proj.id}/reminders`)).body;
  const final = rem.find((r) => r.kind === 'final');
  const sent = await fresh.request('POST', `/api/reminders/${final.id}/send`);
  assert.equal(sent.body.sentVia, 'manual');
  assert.equal((await fresh.request('POST', `/api/reminders/${final.id}/send`)).status, 409);
});

test('automation-off projects are skipped by the sweep', async () => {
  const proj = (await fresh.request('POST', '/api/projects', {
    name: 'NoAuto', code: 'NA-1', goHardDate: '2026-07-21', remindersAutomated: false,
  })).body;
  const { body } = await fresh.request('POST', '/api/reminders/run');
  assert.equal(body.sent.filter((r) => r.projectId === proj.id).length, 0);
});

// --- Sheets & revisions ---

test('sheet lifecycle: create, revise, supersede', async () => {
  const proj = (await fresh.request('POST', '/api/projects', {
    name: 'Sheets', code: 'SH-1', goHardDate: '2026-12-01',
  })).body;

  const sheet = (await fresh.request('POST', `/api/projects/${proj.id}/sheets`, {
    sheetNumber: 'A-101', title: 'Level 1 Floor Plan', discipline: 'Architectural',
  })).body;
  assert.equal(sheet.currentRev, 1);

  const dup = await fresh.request('POST', `/api/projects/${proj.id}/sheets`, {
    sheetNumber: 'A-101', title: 'Again', discipline: 'Architectural',
  });
  assert.equal(dup.status, 409);

  const revved = await fresh.request('POST', `/api/sheets/${sheet.id}/revisions`, { issuedDate: '2026-07-19' });
  assert.equal(revved.status, 201);
  assert.equal(revved.body.currentRev, 2);
  assert.equal(revved.body.revisionCount, 2);

  const detail = (await fresh.request('GET', `/api/sheets/${sheet.id}`)).body;
  assert.deepEqual(detail.revisions.map((r) => [r.rev, r.isCurrent]), [[2, true], [1, false]]);

  const superseded = await fresh.request('PATCH', `/api/sheets/${sheet.id}`, { superseded: true });
  assert.equal(superseded.body.superseded, true);
});

// --- RFIs ---

test('RFI numbering, pins, and status flow', async () => {
  const proj = (await fresh.request('POST', '/api/projects', {
    name: 'RFIs', code: 'RF-1', goHardDate: '2026-12-01',
  })).body;
  await fresh.request('POST', `/api/projects/${proj.id}/sheets`, {
    sheetNumber: 'S-201', title: 'Framing Plan', discipline: 'Structural',
  });

  const rfi1 = (await fresh.request('POST', `/api/projects/${proj.id}/rfis`, {
    subject: 'Clarify beam depth at gridline C-4',
    sheetNumber: 'S-201',
    submittedBy: 'J. Alvarez — Alvarez Steel',
    pin: { x: 62, y: 38 },
  })).body;
  assert.equal(rfi1.displayId, 'RFI-001');
  assert.equal(rfi1.discipline, 'Structural');
  assert.deepEqual(rfi1.pin, { x: 62, y: 38 });

  const rfi2 = (await fresh.request('POST', `/api/projects/${proj.id}/rfis`, { subject: 'Second question' })).body;
  assert.equal(rfi2.rfiNumber, 2);

  // A pin with no sheet is rejected.
  const noSheet = await fresh.request('POST', `/api/projects/${proj.id}/rfis`, {
    subject: 'Pinned nowhere', pin: { x: 10, y: 10 },
  });
  assert.equal(noSheet.status, 422);

  const answered = await fresh.request('PATCH', `/api/rfis/${rfi1.id}`, {
    status: 'answered', answer: 'Use W21 per schedule.',
  });
  assert.equal(answered.body.status, 'answered');

  const open = (await fresh.request('GET', `/api/projects/${proj.id}/rfis?status=open`)).body;
  assert.deepEqual(open.map((r) => r.rfiNumber), [2]);

  // The sheet index flags the sheet's open-RFI count.
  const sheets = (await fresh.request('GET', `/api/projects/${proj.id}/sheets`)).body;
  assert.equal(sheets[0].openRfiCount, 0); // rfi1 was answered; rfi2 has no sheet
});

// --- Bids ---

test('bid rules: go-hard date, directory, vendor docs', async () => {
  const proj = (await fresh.request('POST', '/api/projects', {
    name: 'Bids', code: 'BD-1', goHardDate: '2026-08-17',
  })).body;
  await fresh.request('POST', '/api/companies', {
    name: 'Alvarez Steel', trade: 'Steel', inDirectory: true, w9Received: true, coiReceived: true,
  });

  // Directory company bids without re-submitting docs; amount string is parsed.
  const dirBid = await fresh.request('POST', `/api/projects/${proj.id}/bids`, {
    company: 'alvarez steel', trade: 'Steel', amount: '$1,240,000',
  });
  assert.equal(dirBid.status, 201);
  assert.equal(dirBid.body.amountCents, 124_000_000);
  assert.equal(dirBid.body.company.inDirectory, true);

  // New vendor without docs is rejected with the missing list.
  const noDocs = await fresh.request('POST', `/api/projects/${proj.id}/bids`, {
    company: 'Ridgeline Drywall', trade: 'Drywall', amount: '410000',
  });
  assert.equal(noDocs.status, 422);
  assert.deepEqual(noDocs.body.details.missing, ['w9', 'coi']);

  // Same vendor with W-9 + COI goes through and lands in companies (not directory).
  const withDocs = await fresh.request('POST', `/api/projects/${proj.id}/bids`, {
    company: 'Ridgeline Drywall', trade: 'Drywall', amount: '410000',
    contactName: 'P. Reyes', email: 'p.reyes@ridgeline.com',
    w9Uploaded: true, coiUploaded: true,
  });
  assert.equal(withDocs.status, 201);
  assert.equal(withDocs.body.company.inDirectory, false);
  assert.equal(withDocs.body.company.w9Received, true);

  // Duplicate bid for the same company + trade conflicts.
  const dup = await fresh.request('POST', `/api/projects/${proj.id}/bids`, {
    company: 'Alvarez Steel', trade: 'Steel', amount: '999',
  });
  assert.equal(dup.status, 409);

  // Final-list toggle (the PM's "Add to Final" action).
  const finaled = await fresh.request('PATCH', `/api/bids/${dirBid.body.id}`, { status: 'final_list' });
  assert.equal(finaled.body.status, 'final_list');

  // Bidding closed: past go-hard date blocks submittals.
  const closedProj = (await fresh.request('POST', '/api/projects', {
    name: 'Closed', code: 'CL-1', goHardDate: '2026-06-12',
  })).body;
  const late = await fresh.request('POST', `/api/projects/${closedProj.id}/bids`, {
    company: 'Alvarez Steel', trade: 'Steel', amount: '100',
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'bidding_closed');
});

test('directory check endpoint mirrors the bid form banner', async () => {
  const known = (await fresh.request('GET', '/api/companies/check?name=Alvarez%20Steel')).body;
  assert.deepEqual(known, { name: 'Alvarez Steel', known: true, inDirectory: true, requiredDocs: [] });

  const unknown = (await fresh.request('GET', '/api/companies/check?name=Brand%20New%20Co')).body;
  assert.equal(unknown.known, false);
  assert.deepEqual(unknown.requiredDocs, ['w9', 'coi']);
});
