# MDC Digital Plan Room — Backend

Backend API and pipeline dashboard for the MDC Digital Plan Room (designed in
[Claude Design → "Digital Plan Room Design"](https://claude.ai/design/p/e1a3177b-6505-40d2-9bae-2d469b43bef2)).
It stores the data behind every screen of the design — plan sheets and
revisions, RFIs with sheet pins, the subcontractor directory, bid submittals,
and bid-schedule reminders — and rolls everything up into a portfolio-level
pipeline dashboard.

Requires **Node ≥ 22.5**.

## Quick start (local)

```bash
npm run seed    # load the demo portfolio (3 projects; --force wipes and reseeds)
npm start       # API on http://localhost:4000 (override with PORT)
npm test        # run the API test suite
```

Open **http://localhost:4000/dashboard** for the pipeline dashboard and
**/bidding** for the bidding section.

## Storage

One async storage API (`server/db.js`), two backends:

- **Postgres (Neon)** — production. Selected automatically when `DATABASE_URL`
  is set (the Neon integration in Vercel's Storage tab sets it). Production
  never seeds demo data; the schema is created on first request.
- **SQLite (`node:sqlite`)** — local dev and tests, zero dependencies. The
  database lives at `data/planroom.db` (override with `MDC_DB`). The deployed
  no-database demo mode uses SQLite in `/tmp`, self-seeded on cold start.

## Data model

| Table | Purpose |
|---|---|
| `projects` | One row per pursuit — status, go-hard (bids-due) date, reminder automation flag |
| `sheets` / `sheet_revisions` | Plan sheets by discipline; every issued revision, one marked current |
| `rfis` | RFI log with per-project numbering, status (`open/answered/closed`), and optional sheet pin (`pin_x/pin_y` in % of sheet) |
| `companies` | Subcontractor directory + new vendors, with W-9 / COI receipt flags |
| `bids` | Bid submittals per project/company/trade; status `submitted → final_list → awarded/declined` |
| `reminders` | The two bid-schedule reminders (T-7 `one_week`, T-3 `final`) per project |

## API

All bodies are JSON. Errors return `{ error, message, details? }`.

### Projects & reminders
- `GET /api/projects` · `POST /api/projects` `{name, code, status?, goHardDate?, remindersAutomated?}`
- `GET /api/projects/:id` (includes reminders + counts) · `PATCH /api/projects/:id`
  — changing `goHardDate` reschedules unsent reminders
- `DELETE /api/projects/:id` — removes the project and its sheets, RFIs, bids,
  and reminders (companies are shared and stay)
- `GET /api/projects/:id/reminders`
- `POST /api/reminders/:id/send` — manual "Send Now" (409 if already sent)
- `POST /api/reminders/run` — idempotent automation sweep; point a daily cron
  here and due reminders for automation-enabled projects are marked sent

### Sheets & revisions
- `GET /api/projects/:id/sheets` (`?discipline=`, `?includeSuperseded=false`)
- `POST /api/projects/:id/sheets` `{sheetNumber, title, discipline, rev?, issuedDate?}`
- `GET /api/sheets/:id` — revision history + RFIs pinned to the sheet
- `POST /api/sheets/:id/revisions` — issue a new rev, supersedes the current one
- `PATCH /api/sheets/:id` `{title?, discipline?, superseded?}`

### RFIs
- `GET /api/projects/:id/rfis` (`?status=open|answered|closed`)
- `POST /api/projects/:id/rfis` `{subject, question?, sheetId?|sheetNumber?, submittedBy?, pin?: {x, y}}`
  — numbering is per project (`RFI-001`, `RFI-002`, …); a pin requires a sheet
- `GET /api/rfis/:id` · `PATCH /api/rfis/:id` `{status?, answer?, subject?, question?, pin?}`

### Directory & bids
- `GET /api/companies` (`?query=`, `?inDirectory=true`) · `POST /api/companies` · `PATCH /api/companies/:id`
- `GET /api/companies/check?name=X` — the bid form's directory banner:
  `{known, inDirectory, requiredDocs: ["w9","coi"]}`
- `GET /api/projects/:id/bids` · `PATCH /api/bids/:id` `{status?, amount?, notes?}`
- `POST /api/projects/:id/bids`
  `{company, trade, amount|amountCents, contactName?, email?, phone?, notes?, w9Uploaded?, coiUploaded?}`

Bid submittal enforces the design's rules:
1. **Go-hard date** — bidding closes on the go-hard date; late submittals get `409 bidding_closed`.
2. **New vendors** — a company not in the directory must include a W-9 and
   Certificate of Insurance, or the bid is rejected with `422 vendor_docs_required`
   and the missing-doc list. Accepted new vendors are added to `companies`
   (not yet directory-verified).
3. One bid per company + trade per project.

### Pipeline rollup
- `GET /api/pipeline` — every project's plan data rolled up:
  sheet counts by discipline (+ superseded and revision counts), RFI counts by
  status (+ pinned), bid stats (count, low/high/total, final-list, awarded value,
  new-vendor count, trades covered), reminder state, bidding status and days to
  go-hard — plus portfolio totals.
- `GET /dashboard` — the dashboard page rendering that payload.

## Notes

- `MDC_TODAY=YYYY-MM-DD` freezes "today" for deterministic demos/tests.
- Sheet PDFs and bid documents are placeholders in the design; the schema
  carries `file_name` on revisions so file storage can be attached later.
- No auth yet — the design's role switcher (PM / sub / architect / owner) is a
  frontend concern to wire to a real auth layer later.
