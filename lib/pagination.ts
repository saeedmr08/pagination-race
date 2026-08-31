/**
 * Offset vs cursor pagination against a mutating ordered list.
 * Designed to demonstrate skipped/duplicated rows under concurrent inserts.
 * Pure TS — no Buffer / node builtins (safe for client imports).
 */

import { decodeBase64Url, encodeBase64Url } from "./base64url";

export type Row = {
  id: string;
  rank: number;
  label: string;
  createdAt: number;
};

export type PageResult = {
  items: Row[];
  nextOffset?: number;
  nextCursor?: string;
  hasMore: boolean;
};

export type PageAnomaly =
  | { kind: "duplicate"; id: string; pages: number[] }
  | { kind: "skip"; id: string; expectedBetween: [string, string] };

export type MutationEvent = {
  atStep: number;
  inserted: Row;
  insertIndex: number;
};

export function createDataset(size: number, seed = 1): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < size; i++) {
    const rank = (i + 1) * 10 + ((seed * (i + 3)) % 7);
    rows.push({
      id: `item-${String(i + 1).padStart(3, "0")}`,
      rank,
      label: `Row ${i + 1}`,
      createdAt: 1_700_000_000_000 + i * 1000,
    });
  }
  return sortByRank(rows);
}

export function sortByRank(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.id.localeCompare(b.id);
  });
}

export function insertRow(rows: Row[], row: Row): Row[] {
  return sortByRank([...rows, row]);
}

export function pageByOffset(
  rows: Row[],
  offset: number,
  limit: number
): PageResult {
  const slice = rows.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  return {
    items: slice,
    nextOffset: nextOffset < rows.length ? nextOffset : undefined,
    hasMore: nextOffset < rows.length,
  };
}

/**
 * Cursor is opaque: base64url of "rank|id".
 * Page is rows strictly after the cursor key (rank, id).
 */
export function encodeCursor(row: Row): string {
  return encodeBase64Url(`${row.rank}|${row.id}`);
}

export function decodeCursor(cursor: string): { rank: number; id: string } {
  const raw = decodeBase64Url(cursor);
  const sep = raw.indexOf("|");
  if (sep < 0) throw new Error("invalid cursor");
  const rank = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(rank) || !id) throw new Error("invalid cursor");
  return { rank, id };
}

function afterCursor(row: Row, cursor: { rank: number; id: string }): boolean {
  if (row.rank > cursor.rank) return true;
  if (row.rank < cursor.rank) return false;
  return row.id > cursor.id;
}

export function pageByCursor(
  rows: Row[],
  cursor: string | null,
  limit: number
): PageResult {
  const start = cursor ? decodeCursor(cursor) : null;
  const filtered = start
    ? rows.filter((r) => afterCursor(r, start))
    : rows;
  const items = filtered.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: last && filtered.length > items.length ? encodeCursor(last) : undefined,
    hasMore: filtered.length > items.length,
  };
}

/**
 * Walk pages with a mutator that inserts between page fetches.
 * Returns collected ids per page and detected anomalies.
 */
export function walkOffsetWithInserts(options: {
  initial: Row[];
  pageSize: number;
  maxPages: number;
  mutations: MutationEvent[];
}): {
  pages: Row[][];
  datasetSnapshots: number[];
  anomalies: PageAnomaly[];
  finalRows: Row[];
} {
  let rows = sortByRank(options.initial);
  const pages: Row[][] = [];
  const datasetSnapshots: number[] = [];
  let offset = 0;

  for (let step = 0; step < options.maxPages; step++) {
    for (const m of options.mutations) {
      if (m.atStep === step) {
        rows = insertRow(rows, m.inserted);
      }
    }
    datasetSnapshots.push(rows.length);
    const page = pageByOffset(rows, offset, options.pageSize);
    pages.push(page.items);
    if (!page.hasMore || page.nextOffset === undefined) break;
    offset = page.nextOffset;
  }

  return {
    pages,
    datasetSnapshots,
    anomalies: detectAnomalies(pages, options.initial.map((r) => r.id)),
    finalRows: rows,
  };
}

export function walkCursorWithInserts(options: {
  initial: Row[];
  pageSize: number;
  maxPages: number;
  mutations: MutationEvent[];
}): {
  pages: Row[][];
  datasetSnapshots: number[];
  anomalies: PageAnomaly[];
  finalRows: Row[];
} {
  let rows = sortByRank(options.initial);
  const pages: Row[][] = [];
  const datasetSnapshots: number[] = [];
  let cursor: string | null = null;

  for (let step = 0; step < options.maxPages; step++) {
    for (const m of options.mutations) {
      if (m.atStep === step) {
        rows = insertRow(rows, m.inserted);
      }
    }
    datasetSnapshots.push(rows.length);
    const page = pageByCursor(rows, cursor, options.pageSize);
    pages.push(page.items);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return {
    pages,
    datasetSnapshots,
    anomalies: detectAnomalies(pages, options.initial.map((r) => r.id)),
    finalRows: rows,
  };
}

export function detectAnomalies(
  pages: Row[][],
  knownIds: string[]
): PageAnomaly[] {
  const anomalies: PageAnomaly[] = [];
  const seen = new Map<string, number[]>();

  pages.forEach((page, pageIndex) => {
    for (const row of page) {
      const list = seen.get(row.id) ?? [];
      list.push(pageIndex);
      seen.set(row.id, list);
    }
  });

  for (const [id, pageIndexes] of seen) {
    if (pageIndexes.length > 1) {
      anomalies.push({ kind: "duplicate", id, pages: pageIndexes });
    }
  }

  // Skips: known ids that never appeared but sit between first and last seen ranks
  // in the flat walk order of the original set.
  const visited = new Set(seen.keys());
  const flat = pages.flat().map((r) => r.id);
  if (flat.length >= 2) {
    const first = knownIds.indexOf(flat[0]);
    const last = knownIds.indexOf(flat[flat.length - 1]);
    if (first >= 0 && last > first) {
      for (let i = first; i <= last; i++) {
        const id = knownIds[i];
        if (!visited.has(id)) {
          anomalies.push({
            kind: "skip",
            id,
            expectedBetween: [knownIds[first], knownIds[last]],
          });
        }
      }
    }
  }

  return anomalies;
}

export function summarizeAnomalies(anomalies: PageAnomaly[]): {
  duplicates: number;
  skips: number;
} {
  return {
    duplicates: anomalies.filter((a) => a.kind === "duplicate").length,
    skips: anomalies.filter((a) => a.kind === "skip").length,
  };
}
