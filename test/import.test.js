'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { crc32 } = require('node:zlib');

const { createServer } = require('../server/app');

process.env.MDC_TODAY = '2026-07-20';

// --- Tiny .xlsx builder (stored ZIP entries, no compression) for fixtures ---

function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

const colLetter = (i) => {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
};

// rows: arrays of string | number | null. Strings go through sharedStrings,
// the way real Excel files are written.
function buildXlsx(rows) {
  const shared = [];
  const sharedIndex = new Map();
  const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rowXml = rows.map((row, r) => {
    const cells = row.map((v, c) => {
      if (v === null || v === undefined || v === '') return '';
      const ref = `${colLetter(c)}${r + 1}`;
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
      if (!sharedIndex.has(v)) { sharedIndex.set(v, shared.length); shared.push(v); }
      return `<c r="${ref}" t="s"><v>${sharedIndex.get(v)}</v></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
  const sst = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t>${escXml(s)}</t></si>`).join('')}</sst>`;
  const workbook = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Pipeline" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
  return buildZip([
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', rels],
    ['xl/sharedStrings.xml', sst],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}

const excelSerial = (y, m, d) => Date.UTC(y, m - 1, d) / 86_400_000 + 25_569;

// --- Server fixture ---

let srv;

before(async () => {
  const { server } = await createServer({ dbPath: ':memory:' });
  srv = await new Promise((resolve) => {
    server.listen(0, () => {
      const base = `http://localhost:${server.address().port}`;
      resolve({
        server,
        upload: async (buffer) => {
          const res = await fetch(`${base}/api/import/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buffer,
          });
          return { status: res.status, body: await res.json() };
        },
        get: async (path) => (await fetch(base + path)).json(),
      });
    });
  });
});

after(() => srv.server.close());

test('imports an Excel workbook, mapping columns by header and dropping owner data', async () => {
  const xlsx = buildXlsx([
    ['Project Name', 'Phase', 'Notes', 'Priority', 'Category', 'Account', 'Owner Name', 'Owner Email',
      'Owner Phone', 'Project Address', 'Initial Contact Date', 'Site Visit Date', 'RFI Date',
      'Bid Due Date', 'Proposal Submitted Date', 'Proposal Amount', 'Final Contract Amount',
      'Proposal/Contract Notes'],
    ['Harbor Point Clinic', 'Submitted / Pending', 'Fast-track', 'High', 'Commercial Upfit',
      'Coastal Health', 'P. Private', 'p@private.com', '(555) 555-0100', '9 Bay Rd',
      excelSerial(2026, 6, 1), null, null, excelSerial(2026, 8, 17), excelSerial(2026, 7, 1),
      460_560, null, 'Excludes FF&E'],
    ['Bad Phase Project', 'Not A Real Phase', null, null, 'Commercial New', null, null, null,
      null, null, null, null, null, null, null, 1000, null, null],
    ['Closed Job', 'Awarded - Closed', null, null, 'Residential Renovation', null, null, null,
      null, null, null, null, null, null, null, 12_000, 10_750, null],
  ]);

  const { status, body } = await srv.upload(xlsx);
  assert.equal(status, 200);
  assert.equal(body.created, 2);
  assert.equal(body.failed.length, 1);
  assert.match(body.failed[0].error, /Not A Real Phase/);

  const projects = await srv.get('/api/projects');
  const clinic = projects.find((p) => p.name === 'Harbor Point Clinic');
  assert.equal(clinic.phase, 'submitted_pending');
  assert.equal(clinic.category, 'Commercial Upfit');
  assert.equal(clinic.account, 'Coastal Health');
  assert.equal(clinic.priority, 'High');
  assert.equal(clinic.goHardDate, '2026-08-17');
  assert.equal(clinic.initialContactDate, '2026-06-01');
  assert.equal(clinic.proposalSubmittedDate, '2026-07-01');
  assert.equal(clinic.proposalAmountCents, 46_056_000);
  assert.equal(clinic.proposalNotes, 'Excludes FF&E');
  // Owner contact and address never land anywhere.
  assert.equal(clinic.ownerName, undefined);
  assert.equal(clinic.address, undefined);
  assert.ok(clinic.code);

  const closed = projects.find((p) => p.name === 'Closed Job');
  assert.equal(closed.phase, 'awarded_closed');
  assert.equal(closed.finalContractAmountCents, 1_075_000);

  // The imports feed the pipeline rollups.
  const pipeline = await srv.get('/api/pipeline');
  const closedRow = pipeline.breakdowns.winLoss.rows.find((r) => r.phase === 'awarded_closed');
  assert.equal(closedRow.valueCents, 1_075_000);
});

test('imports CSV text with headers in a different column order', async () => {
  const csv = [
    'Phase,Proposal Amount,Project Name,Category',
    'Bidding,"$700,000.00",Riverside Lofts,Commercial New',
    ',,,',
  ].join('\n');
  const { status, body } = await srv.upload(Buffer.from(csv));
  assert.equal(status, 200);
  assert.equal(body.created, 1);
  const projects = await srv.get('/api/projects');
  const lofts = projects.find((p) => p.name === 'Riverside Lofts');
  assert.equal(lofts.phase, 'bidding');
  assert.equal(lofts.proposalAmountCents, 70_000_000);
});

test('NA and placeholder cells import as empty values, not errors', async () => {
  const csv = [
    'Project Name,Phase,Category,Proposal Amount,Final Contract Amount,Bid Due Date,Site Visit Date,Notes',
    'Placeholder Job,Lost,Commercial New,"$54,375.00",NA,TBD,N/A,-',
  ].join('\n');
  const { status, body } = await srv.upload(Buffer.from(csv));
  assert.equal(status, 200);
  assert.equal(body.created, 1);
  assert.equal(body.failed.length, 0);

  const projects = await srv.get('/api/projects');
  const job = projects.find((p) => p.name === 'Placeholder Job');
  assert.equal(job.proposalAmountCents, 5_437_500);
  assert.equal(job.finalContractAmountCents, null);
  assert.equal(job.goHardDate, null);
  assert.equal(job.siteVisitDate, null);
  assert.equal(job.notes, null);

  // A lost project with an NA final contract still counts its proposal in
  // win-loss (matching the source spreadsheet's math).
  const pipeline = await srv.get('/api/pipeline');
  const lost = pipeline.breakdowns.winLoss.rows.find((r) => r.phase === 'lost');
  assert.equal(lost.valueCents, 5_437_500);

  // The same placeholders in an .xlsx workbook, plus an NA phase → Bidding.
  const xlsx = buildXlsx([
    ['Project Name', 'Phase', 'Proposal Amount', 'Bid Due Date'],
    ['Xlsx NA Job', 'NA', 'N/A', 'TBD'],
  ]);
  const second = await srv.upload(xlsx);
  assert.equal(second.body.created, 1);
  const naJob = (await srv.get('/api/projects')).find((p) => p.name === 'Xlsx NA Job');
  assert.equal(naJob.phase, 'bidding');
  assert.equal(naJob.proposalAmountCents, null);
});

test('rejects an empty upload', async () => {
  const { status } = await srv.upload(Buffer.alloc(0));
  assert.equal(status, 422);
});
