'use strict';

// Minimal .xlsx reader — enough to pull the first worksheet out of a workbook
// as a 2D array of cell values (string | number | boolean | null). An .xlsx
// file is a ZIP of XML parts; node:zlib inflates the entries, and the sheet
// XML is simple enough to parse with regular expressions. No dependencies.

const zlib = require('node:zlib');

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

// Returns a Map of entry name → Buffer of the entry's contents.
function readZip(buffer) {
  // Find the End Of Central Directory record (scan back past any comment).
  let eocd = -1;
  const scanStart = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= scanStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP directory found)');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries = new Map();
  for (let n = 0; n < entryCount; n++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIG) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (buffer.readUInt32LE(localOffset) === LOCAL_SIG) {
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      entries.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function decodeXml(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Concatenates every <t> run inside a fragment (plain and rich-text strings).
function textRuns(fragment) {
  let out = '';
  for (const m of fragment.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) strings.push(textRuns(m[1]));
  return strings;
}

function columnIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Finds the path of the workbook's first worksheet, falling back to the
// lowest-numbered xl/worksheets/sheet*.xml when the workbook XML is odd.
function firstSheetPath(entries) {
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8');
  const rels = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (workbook && rels) {
    const sheet = workbook.match(/<sheet\s[^>]*r:id="([^"]+)"/);
    if (sheet) {
      const rel = rels.match(new RegExp(`<Relationship[^>]*Id="${sheet[1]}"[^>]*Target="([^"]+)"`))
        || rels.match(new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${sheet[1]}"`));
      if (rel) {
        const target = rel[1].replace(/^\//, '').replace(/^xl\//, '');
        const path = `xl/${target}`;
        if (entries.has(path)) return path;
      }
    }
  }
  const candidates = [...entries.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!candidates.length) throw new Error('No worksheet found in workbook');
  return candidates[0];
}

// Parses an .xlsx buffer into the first worksheet's rows: an array of arrays,
// dense from column A, with nulls for blank cells.
function readFirstSheet(buffer) {
  const entries = readZip(buffer);
  const shared = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));
  const sheetXml = entries.get(firstSheetPath(entries)).toString('utf8');

  const rows = [];
  for (const rowMatch of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2] || '';
      const ref = attrs.match(/r="([A-Z]+)\d+"/);
      const col = ref ? columnIndex(ref[1]) : cells.length;
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      const rawValue = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];

      let value = null;
      if (type === 's') value = shared[Number(rawValue)] ?? null;
      else if (type === 'inlineStr') value = textRuns(inner);
      else if (type === 'str') value = rawValue !== undefined ? decodeXml(rawValue) : null;
      else if (type === 'b') value = rawValue === '1';
      else if (rawValue !== undefined && rawValue !== '') value = Number(rawValue);
      cells[col] = value;
    }
    // Normalize sparse arrays: fill holes with null.
    rows.push(Array.from(cells, (v) => (v === undefined ? null : v)));
  }
  return rows;
}

// Excel stores dates as day counts from 1899-12-30; 25569 = 1970-01-01.
function excelSerialToIsoDate(serial) {
  return new Date(Math.round((serial - 25569) * 86_400_000)).toISOString().slice(0, 10);
}

module.exports = { readFirstSheet, excelSerialToIsoDate };
