'use strict';

const { today, biddingOpen } = require('../util');
const { PHASE_LABELS, effectivePhase } = require('./projects');

// Phases counted as open pipeline vs. decided outcomes.
const PIPELINE_PHASES = ['initiation', 'bidding', 'submitted_pending'];
const OUTCOME_PHASES = ['awarded_mobilizing', 'awarded_in_progress', 'awarded_closed', 'no_bid', 'lost', 'client_withdraw'];

function daysBetween(fromIso, toIso) {
  return Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

// Rolls every project's plan, RFI, bid, and reminder data up into one payload.
async function buildPipeline(db) {
  const asOf = today();
  const projectRows = await db.prepare('SELECT * FROM projects ORDER BY id').all();
  const projects = [];
  for (const p of projectRows) {
    const sheetRows = await db.prepare(
      'SELECT discipline, superseded, COUNT(*) c FROM sheets WHERE project_id = ? GROUP BY discipline, superseded'
    ).all(p.id);
    const byDiscipline = {};
    let sheetTotal = 0;
    let supersededCount = 0;
    for (const row of sheetRows) {
      byDiscipline[row.discipline] = (byDiscipline[row.discipline] || 0) + row.c;
      sheetTotal += row.c;
      if (row.superseded) supersededCount += row.c;
    }
    const revisionCount = (await db.prepare(`
      SELECT COUNT(*) c FROM sheet_revisions sr JOIN sheets s ON s.id = sr.sheet_id
      WHERE s.project_id = ?
    `).get(p.id)).c;

    const rfiCounts = { open: 0, answered: 0, closed: 0, total: 0 };
    for (const row of await db.prepare(
      'SELECT status, COUNT(*) c FROM rfis WHERE project_id = ? GROUP BY status'
    ).all(p.id)) {
      rfiCounts[row.status] = row.c;
      rfiCounts.total += row.c;
    }
    const pinnedRfis = (await db.prepare(
      'SELECT COUNT(*) c FROM rfis WHERE project_id = ? AND pin_x IS NOT NULL'
    ).get(p.id)).c;

    const bidAgg = await db.prepare(`
      SELECT COUNT(*) AS count,
             MIN(amount_cents) AS low,
             MAX(amount_cents) AS high,
             SUM(amount_cents) AS total,
             SUM(CASE WHEN status IN ('final_list','awarded') THEN 1 ELSE 0 END) AS "finalList",
             SUM(CASE WHEN status = 'awarded' THEN 1 ELSE 0 END) AS awarded,
             SUM(CASE WHEN status = 'awarded' THEN amount_cents ELSE 0 END) AS "awardedCents"
      FROM bids WHERE project_id = ?
    `).get(p.id);
    const newVendorBids = (await db.prepare(`
      SELECT COUNT(*) c FROM bids b JOIN companies c2 ON c2.id = b.company_id
      WHERE b.project_id = ? AND c2.in_directory = 0
    `).get(p.id)).c;
    const trades = (await db.prepare(
      'SELECT DISTINCT trade FROM bids WHERE project_id = ? ORDER BY trade'
    ).all(p.id)).map((r) => r.trade);

    const reminders = (await db.prepare(
      'SELECT * FROM reminders WHERE project_id = ? ORDER BY scheduled_for'
    ).all(p.id)).map((r) => ({
      kind: r.kind,
      scheduledFor: r.scheduled_for,
      sentAt: r.sent_at,
      sentVia: r.sent_via,
    }));

    const open = biddingOpen(p, asOf);
    const phase = effectivePhase(p);
    projects.push({
      id: p.id,
      name: p.name,
      code: p.code,
      status: p.status,
      phase,
      phaseLabel: PHASE_LABELS[phase],
      category: p.category,
      proposalAmountCents: p.proposal_amount_cents,
      finalContractAmountCents: p.final_contract_amount_cents,
      goHardDate: p.go_hard_date,
      biddingStatus: p.go_hard_date ? (open ? 'open' : 'closed') : 'not_scheduled',
      daysToGoHard: p.go_hard_date ? daysBetween(asOf, p.go_hard_date) : null,
      remindersAutomated: Boolean(p.reminders_automated),
      sheets: {
        total: sheetTotal,
        superseded: supersededCount,
        revisions: revisionCount,
        byDiscipline,
      },
      rfis: { ...rfiCounts, pinned: pinnedRfis },
      bids: {
        count: bidAgg.count,
        lowCents: bidAgg.low,
        highCents: bidAgg.high,
        totalCents: bidAgg.total,
        finalList: bidAgg.finalList || 0,
        awarded: bidAgg.awarded || 0,
        awardedCents: bidAgg.awardedCents || 0,
        newVendorBids,
        tradesCovered: trades,
      },
      reminders,
    });
  }

  // --- Phase / category rollups (computed from the project rows) ---

  const projectsByPhase = Object.keys(PHASE_LABELS).map((phase) => {
    const count = projects.filter((p) => p.phase === phase).length;
    return {
      phase,
      label: PHASE_LABELS[phase],
      count,
      pct: projects.length ? +(count / projects.length * 100).toFixed(1) : 0,
    };
  });

  const pipelinePotential = PIPELINE_PHASES.map((phase) => ({
    phase,
    label: PHASE_LABELS[phase],
    proposalCents: projects.filter((p) => p.phase === phase)
      .reduce((n, p) => n + (p.proposalAmountCents || 0), 0),
  }));
  const pipelinePotentialTotal = pipelinePotential.reduce((n, r) => n + r.proposalCents, 0);

  // Win-loss value: the final contract when one exists, otherwise the
  // proposal that was decided on (lost / no-bid / withdrawn work has no
  // final contract but still represents decided value).
  const winLossRows = OUTCOME_PHASES.map((phase) => ({
    phase,
    label: PHASE_LABELS[phase],
    valueCents: projects.filter((p) => p.phase === phase)
      .reduce((n, p) => n + (p.finalContractAmountCents ?? p.proposalAmountCents ?? 0), 0),
  }));
  const winLossTotal = winLossRows.reduce((n, r) => n + r.valueCents, 0);
  const winLoss = winLossRows.map((r) => ({
    ...r,
    pct: winLossTotal ? +(r.valueCents / winLossTotal * 100).toFixed(2) : 0,
  }));

  function categoryTable(rows) {
    const byCat = new Map();
    for (const p of rows) {
      const cat = p.category || 'Uncategorized';
      if (!byCat.has(cat)) byCat.set(cat, { category: cat, proposalCents: 0, finalCents: 0 });
      const entry = byCat.get(cat);
      entry.proposalCents += p.proposalAmountCents || 0;
      entry.finalCents += p.finalContractAmountCents || 0;
    }
    return [...byCat.values()].sort((a, b) => a.category.localeCompare(b.category));
  }
  const activeRows = projects.filter((p) => PIPELINE_PHASES.includes(p.phase));
  const postAwardRows = projects.filter((p) => OUTCOME_PHASES.includes(p.phase));
  const postAwardByCat = new Map();
  for (const p of postAwardRows) {
    const cat = p.category || 'Uncategorized';
    if (!postAwardByCat.has(cat)) postAwardByCat.set(cat, { category: cat, byPhase: {}, totalCents: 0 });
    const entry = postAwardByCat.get(cat);
    const v = p.finalContractAmountCents || 0;
    entry.byPhase[p.phase] = (entry.byPhase[p.phase] || 0) + v;
    entry.totalCents += v;
  }
  const projectsByCategory = {
    active: categoryTable(activeRows),
    postAward: {
      phases: OUTCOME_PHASES.filter((ph) => postAwardRows.some((p) => p.phase === ph)),
      rows: [...postAwardByCat.values()].sort((a, b) => a.category.localeCompare(b.category)),
    },
  };

  // Portfolio-wide compositions for the dashboard's part-to-whole charts.
  const breakdowns = {
    projectsByPhase,
    pipelinePotential: { rows: pipelinePotential, totalCents: pipelinePotentialTotal },
    winLoss: { rows: winLoss, totalCents: winLossTotal },
    projectsByCategory,
    bidValueByTrade: (await db.prepare(`
      SELECT trade, COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS "totalCents"
      FROM bids GROUP BY trade ORDER BY "totalCents" DESC, trade
    `).all()).map((r) => ({ trade: r.trade, count: r.count, totalCents: r.totalCents })),
    sheetsByDiscipline: (await db.prepare(`
      SELECT discipline, COUNT(*) AS count FROM sheets GROUP BY discipline ORDER BY count DESC, discipline
    `).all()).map((r) => ({ discipline: r.discipline, count: r.count })),
    rfisByStatus: {
      open: projects.reduce((n, p) => n + p.rfis.open, 0),
      answered: projects.reduce((n, p) => n + p.rfis.answered, 0),
      closed: projects.reduce((n, p) => n + p.rfis.closed, 0),
    },
  };

  const totals = {
    projects: projects.length,
    biddingOpen: projects.filter((p) => p.biddingStatus === 'open').length,
    sheets: projects.reduce((n, p) => n + p.sheets.total, 0),
    openRfis: projects.reduce((n, p) => n + p.rfis.open, 0),
    totalRfis: projects.reduce((n, p) => n + p.rfis.total, 0),
    bidsReceived: projects.reduce((n, p) => n + p.bids.count, 0),
    bidValueCents: projects.reduce((n, p) => n + (p.bids.totalCents || 0), 0),
    awardedCents: projects.reduce((n, p) => n + p.bids.awardedCents, 0),
  };

  return { asOf, totals, breakdowns, projects };
}

function register(app, db) {
  app.get('/api/pipeline', () => buildPipeline(db));
}

module.exports = { register, buildPipeline };
