'use strict';

const { today, biddingOpen } = require('../util');

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
    projects.push({
      id: p.id,
      name: p.name,
      code: p.code,
      status: p.status,
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

  // Portfolio-wide compositions for the dashboard's part-to-whole charts.
  const breakdowns = {
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
