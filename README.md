# Pagination Race

Interactive lab that races **offset** pagination against **cursor (keyset)** pagination on a mutating feed persisted in `data/items.json`.

## Why it exists

Offset `LIMIT/OFFSET` is simple, but inserts that land *before* the current window shift every subsequent page. You get:

- **Duplicates** — a row already shown slides into the next offset window
- **Skips** — a row never appears because it was pushed past the advancing offset

Cursor pagination encodes the last seen `(rank, id)` and requests rows *strictly after* that key. Early inserts do not re-surface already-seen ids.

## Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

```bash
npm test
npm run typecheck
```

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/page?mode=offset&page=0&limit=3` | Offset page from `data/items.json` |
| `GET` | `/api/page?mode=cursor&cursor=…&limit=3` | Cursor page (omit cursor for first page) |
| `POST` | `/api/page` `{ "action": "reset" }` | Reseed dataset |
| `POST` | `/api/page` `{ "action": "insert", "insertMode": "before-head" }` | Insert mid-walk |
| `POST` | `/api/page` `{ "action": "compare", … }` | Full offset vs cursor race with anomalies |

Example:

```bash
curl 'http://localhost:3000/api/page?mode=offset&page=0'
curl -X POST http://localhost:3000/api/page \
  -H 'Content-Type: application/json' \
  -d '{"action":"insert","insertMode":"before-head"}'
curl -X POST http://localhost:3000/api/page \
  -H 'Content-Type: application/json' \
  -d '{"action":"compare","size":12,"pageSize":3,"insertMode":"before-head"}'
```

## UI

1. **Reset dataset** — writes a fresh `data/items.json`
2. **Next offset / cursor page** — live `GET /api/page`
3. **Insert during walk** — mutates the persisted list between pages
4. **Compare race** — shows offset duplicates/skips vs stable cursor walk

## Library

Core logic in `lib/pagination.ts` (no `Buffer` / Node builtins — safe for client):

- `pageByOffset` / `pageByCursor`
- `walkOffsetWithInserts` / `walkCursorWithInserts`
- `detectAnomalies` / `summarizeAnomalies`

Persisted state helpers: `lib/items-store.ts` (server-only).

## Author

Saeed Rumaneh · MIT License · 2026

## Complete product flows

1. Click **Offset vs cursor (one-click)** — runs a full race with an insert between pages.
2. Read the explanation: offset **duplicates** (highlighted) and **skips** (listed); cursor stays stable.
3. Or manually **Next offset/cursor page** + **Insert during walk** against the live `data/items.json` dataset.
