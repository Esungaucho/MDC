'use strict';

// Seeds the database with the Plan Room design's sample data plus two more
// projects so the pipeline dashboard has a real portfolio to roll up.
// Usage: npm run seed  (pass --force to wipe and reseed an existing database)

const { openStorage } = require('./db');
const { syncReminders } = require('./routes/projects');

async function seed(db, { force = false } = {}) {
  const existing = (await db.prepare('SELECT COUNT(*) c FROM projects').get()).c;
  if (existing > 0) {
    if (!force) {
      return { seeded: false, reason: 'Database already has projects. Re-run with --force to wipe and reseed.' };
    }
    for (const table of ['reminders', 'bids', 'rfis', 'sheet_revisions', 'sheets', 'companies', 'projects']) {
      await db.prepare(`DELETE FROM ${table}`).run();
    }
  }

  const insertCompany = db.prepare(`
    INSERT INTO companies (name, trade, contact_name, email, phone, in_directory, w9_received, coi_received)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const companies = {};
  for (const [name, trade, contact, email, phone] of [
    ['Alvarez Steel', 'Steel', 'J. Alvarez', 'j.alvarez@alvarezsteel.com', '(555) 555-0134'],
    ['Apex Mechanical', 'Mechanical', 'T. Nguyen', 't.nguyen@apexmech.com', '(555) 555-0177'],
    ['Glassline Inc', 'Glazing', 'R. Cole', 'r.cole@glassline.com', '(555) 555-0142'],
    ['Coastal Electric', 'Electrical', 'M. Ibarra', 'm.ibarra@coastalelectric.com', '(555) 555-0190'],
    ['Summit Concrete', 'Concrete', 'D. Okafor', 'd.okafor@summitconcrete.com', '(555) 555-0163'],
  ]) {
    companies[name] = (await insertCompany.run(name, trade, contact, email, phone, 1, 1, 1)).lastInsertRowid;
  }
  // New vendor that bid without being in the directory yet (docs received with bid).
  companies['Northgate Roofing'] = (await insertCompany.run(
    'Northgate Roofing', 'Roofing', 'S. Patel', 's.patel@northgateroofing.com', '(555) 555-0128', 0, 1, 1
  )).lastInsertRowid;

  const insertProject = db.prepare(`
    INSERT INTO projects (name, code, status, phase, category, proposal_amount_cents,
                          final_contract_amount_cents, go_hard_date, reminders_automated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertSheet = db.prepare(
    'INSERT INTO sheets (project_id, sheet_number, title, discipline, superseded) VALUES (?, ?, ?, ?, ?)');
  const insertRev = db.prepare(
    'INSERT INTO sheet_revisions (sheet_id, rev, is_current, issued_date) VALUES (?, ?, ?, ?)');
  const insertRfi = db.prepare(`
    INSERT INTO rfis (project_id, rfi_number, subject, question, sheet_id, status, answer, submitted_by, pin_x, pin_y, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertBid = db.prepare(
    'INSERT INTO bids (project_id, company_id, trade, amount_cents, notes, status, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

  async function addSheets(projectId, sheets) {
    const ids = {};
    for (const s of sheets) {
      const sheetId = (await insertSheet.run(projectId, s.number, s.title, s.discipline, s.superseded ? 1 : 0)).lastInsertRowid;
      ids[s.number] = sheetId;
      const revs = s.revs || [{ rev: 1, issued: s.issued || '2026-05-01' }];
      for (let i = 0; i < revs.length; i++) {
        await insertRev.run(sheetId, revs[i].rev, i === revs.length - 1 ? 1 : 0, revs[i].issued);
      }
    }
    return ids;
  }

  // --- Project 1: Meridian Office Tower (the design's project) ---
  const meridian = (await insertProject.run('Meridian Office Tower', 'MOT-2026', 'bidding',
    'bidding', 'Commercial New', 70_000_000, null, '2026-08-17', 1)).lastInsertRowid;
  const motSheets = await addSheets(meridian, [
    { number: 'A-101', title: 'Level 1 Floor Plan', discipline: 'Architectural',
      revs: [{ rev: 1, issued: '2026-03-02' }, { rev: 2, issued: '2026-05-11' }, { rev: 3, issued: '2026-07-08' }] },
    { number: 'A-102', title: 'Level 2 Floor Plan', discipline: 'Architectural',
      revs: [{ rev: 1, issued: '2026-03-02' }, { rev: 2, issued: '2026-06-19' }] },
    { number: 'A-201', title: 'Building Elevations', discipline: 'Architectural', issued: '2026-03-02' },
    { number: 'A-501', title: 'Wall Sections', discipline: 'Architectural', superseded: true, issued: '2026-03-02' },
    { number: 'S-101', title: 'Foundation Plan', discipline: 'Structural',
      revs: [{ rev: 1, issued: '2026-03-02' }, { rev: 2, issued: '2026-05-28' }] },
    { number: 'S-201', title: 'Framing Plan - Level 2', discipline: 'Structural', issued: '2026-03-02' },
    { number: 'M-101', title: 'Mechanical Plan - Level 1', discipline: 'MEP', issued: '2026-03-02' },
    { number: 'E-101', title: 'Electrical Plan - Level 1', discipline: 'MEP', issued: '2026-03-02' },
    { number: 'P-101', title: 'Plumbing Plan - Level 1', discipline: 'MEP', issued: '2026-03-02' },
    { number: 'C-101', title: 'Site Plan', discipline: 'Civil',
      revs: [{ rev: 1, issued: '2026-03-02' }, { rev: 2, issued: '2026-04-15' }] },
    { number: 'C-201', title: 'Grading & Drainage', discipline: 'Civil', issued: '2026-03-02' },
  ]);

  await insertRfi.run(meridian, 12, 'Confirm curtain wall anchor spacing',
    'Anchor spacing on elevation grid B differs between the elevation and the curtain wall shop standard.',
    motSheets['A-201'], 'closed', 'Use 24" o.c. per revised detail 5/A-201.',
    'R. Cole — Glassline Inc', null, null, '2026-07-02T14:10:00Z', '2026-07-09T16:00:00Z');
  await insertRfi.run(meridian, 13, 'Conflict between duct routing and structural beam',
    'Main supply duct at gridline 4 clashes with the W24 beam bottom flange.',
    motSheets['M-101'], 'answered', 'Drop duct 8" and route under beam; coordinate with sprinkler main.',
    'T. Nguyen — Apex Mechanical', null, null, '2026-07-10T09:30:00Z', '2026-07-15T11:20:00Z');
  await insertRfi.run(meridian, 14, 'Clarify beam depth at gridline C-4',
    'Framing plan shows W18 but the schedule lists W21 at C-4. Which governs?',
    motSheets['S-201'], 'open', null,
    'J. Alvarez — Alvarez Steel', 62, 38, '2026-07-14T15:45:00Z', '2026-07-14T15:45:00Z');

  await insertBid.run(meridian, companies['Alvarez Steel'], 'Steel', 124_000_000, null, 'submitted', '2026-07-12T17:05:00Z');

  // --- Project 2: Harborview Medical Pavilion (bidding, further out) ---
  const harborview = (await insertProject.run('Harborview Medical Pavilion', 'HMP-2026', 'bidding',
    'submitted_pending', 'Commercial Upfit', 46_056_000, null, '2026-09-04', 1)).lastInsertRowid;
  const hmpSheets = await addSheets(harborview, [
    { number: 'A-100', title: 'Overall Floor Plan', discipline: 'Architectural', issued: '2026-06-01' },
    { number: 'A-300', title: 'Reflected Ceiling Plans', discipline: 'Architectural', issued: '2026-06-01' },
    { number: 'S-100', title: 'Foundation & Slab Plan', discipline: 'Structural', issued: '2026-06-01' },
    { number: 'M-100', title: 'HVAC Plan', discipline: 'MEP', issued: '2026-06-01' },
    { number: 'E-100', title: 'Power & Lighting Plan', discipline: 'MEP', issued: '2026-06-01' },
  ]);
  await insertRfi.run(harborview, 1, 'Slab depression extents at imaging suite',
    'Confirm depressed slab limits for the MRI room shielding assembly.',
    hmpSheets['S-100'], 'open', null, 'D. Okafor — Summit Concrete', 41, 57,
    '2026-07-16T10:00:00Z', '2026-07-16T10:00:00Z');
  await insertBid.run(harborview, companies['Summit Concrete'], 'Concrete', 298_500_000, 'Excludes site retaining walls.', 'submitted', '2026-07-15T19:40:00Z');
  await insertBid.run(harborview, companies['Coastal Electric'], 'Electrical', 162_000_000, null, 'submitted', '2026-07-17T15:12:00Z');
  await insertBid.run(harborview, companies['Northgate Roofing'], 'Roofing', 48_750_000, 'TPO alternate included.', 'submitted', '2026-07-18T13:25:00Z');

  // --- Project 3: Elm Street Parking Structure (bidding closed, award made) ---
  const elm = (await insertProject.run('Elm Street Parking Structure', 'ESP-2026', 'awarded',
    'awarded_closed', 'Development / Site Work', 45_000_000, 44_972_437, '2026-06-12', 0)).lastInsertRowid;
  await addSheets(elm, [
    { number: 'A-110', title: 'Plaza Level Plan', discipline: 'Architectural', issued: '2026-04-06' },
    { number: 'S-110', title: 'Precast Framing Plan', discipline: 'Structural',
      revs: [{ rev: 1, issued: '2026-04-06' }, { rev: 2, issued: '2026-05-20' }] },
    { number: 'C-110', title: 'Site & Utility Plan', discipline: 'Civil', issued: '2026-04-06' },
  ]);
  await insertBid.run(elm, companies['Summit Concrete'], 'Concrete', 411_000_000, null, 'awarded', '2026-06-05T16:30:00Z');
  await insertBid.run(elm, companies['Alvarez Steel'], 'Steel', 87_200_000, null, 'final_list', '2026-06-08T14:00:00Z');
  await insertBid.run(elm, companies['Coastal Electric'], 'Electrical', 54_900_000, null, 'declined', '2026-06-09T11:45:00Z');

  // Reminder rows for every project (already-due ones stay unsent until the
  // automation sweep — POST /api/reminders/run — picks them up).
  for (const id of [meridian, harborview, elm]) {
    await syncReminders(db, await db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
  }

  return {
    seeded: true,
    projects: (await db.prepare('SELECT COUNT(*) c FROM projects').get()).c,
    sheets: (await db.prepare('SELECT COUNT(*) c FROM sheets').get()).c,
    rfis: (await db.prepare('SELECT COUNT(*) c FROM rfis').get()).c,
    bids: (await db.prepare('SELECT COUNT(*) c FROM bids').get()).c,
    companies: (await db.prepare('SELECT COUNT(*) c FROM companies').get()).c,
  };
}

if (require.main === module) {
  (async () => {
    const db = await openStorage();
    const result = await seed(db, { force: process.argv.includes('--force') || process.env.MDC_SEED_FORCE === '1' });
    console.log(result.seeded ? `Seeded (${db.dialect}): ${JSON.stringify(result)}` : result.reason);
    process.exitCode = result.seeded ? 0 : 1;
  })().catch((err) => { console.error(err); process.exitCode = 1; });
}

module.exports = { seed };
