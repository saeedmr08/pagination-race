import { describe, expect, it } from "vitest";
import {
  createDataset,
  decodeCursor,
  detectAnomalies,
  encodeCursor,
  insertRow,
  pageByCursor,
  pageByOffset,
  summarizeAnomalies,
  walkCursorWithInserts,
  walkOffsetWithInserts,
  type Row,
} from "./pagination";

describe("createDataset / insertRow", () => {
  it("creates sorted rows by rank", () => {
    const rows = createDataset(5, 2);
    expect(rows).toHaveLength(5);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].rank).toBeGreaterThanOrEqual(rows[i - 1].rank);
    }
  });

  it("inserts and keeps sort order", () => {
    const base = createDataset(3);
    const extra: Row = {
      id: "item-new",
      rank: base[0].rank + 1,
      label: "Inserted",
      createdAt: Date.now(),
    };
    const next = insertRow(base, extra);
    expect(next).toHaveLength(4);
    expect(next.some((r) => r.id === "item-new")).toBe(true);
  });
});

describe("pageByOffset", () => {
  it("returns consecutive slices", () => {
    const rows = createDataset(10);
    const p0 = pageByOffset(rows, 0, 3);
    const p1 = pageByOffset(rows, 3, 3);
    expect(p0.items.map((r) => r.id)).toEqual([
      rows[0].id,
      rows[1].id,
      rows[2].id,
    ]);
    expect(p1.items.map((r) => r.id)).toEqual([
      rows[3].id,
      rows[4].id,
      rows[5].id,
    ]);
    expect(p0.hasMore).toBe(true);
    expect(p0.nextOffset).toBe(3);
  });
});

describe("cursor encode/decode", () => {
  it("round-trips rank and id", () => {
    const row = createDataset(1)[0];
    const cursor = encodeCursor(row);
    expect(decodeCursor(cursor)).toEqual({ rank: row.rank, id: row.id });
  });

  it("pages strictly after cursor", () => {
    const rows = createDataset(8);
    const first = pageByCursor(rows, null, 3);
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toBeTruthy();
    const second = pageByCursor(rows, first.nextCursor!, 3);
    const overlap = first.items.filter((a) =>
      second.items.some((b) => b.id === a.id)
    );
    expect(overlap).toHaveLength(0);
    expect(second.items[0].id).toBe(rows[3].id);
  });
});

describe("offset race under inserts", () => {
  it("duplicates or skips when a row is inserted before the next offset page", () => {
    const initial = createDataset(9);

    const result = walkOffsetWithInserts({
      initial,
      pageSize: 3,
      maxPages: 3,
      mutations: [
        {
          atStep: 1,
          inserted: {
            id: "item-inject",
            rank: initial[0].rank - 5,
            label: "Early insert",
            createdAt: Date.now(),
          },
          insertIndex: 0,
        },
      ],
    });

    const summary = summarizeAnomalies(result.anomalies);
    expect(summary.duplicates + summary.skips).toBeGreaterThan(0);
  });
});

describe("cursor race under inserts", () => {
  it("does not duplicate already-seen rows when inserts land earlier", () => {
    const initial = createDataset(9);
    const result = walkCursorWithInserts({
      initial,
      pageSize: 3,
      maxPages: 3,
      mutations: [
        {
          atStep: 1,
          inserted: {
            id: "item-inject",
            rank: initial[0].rank - 5,
            label: "Early insert",
            createdAt: Date.now(),
          },
          insertIndex: 0,
        },
      ],
    });

    const dups = result.anomalies.filter((a) => a.kind === "duplicate");
    expect(dups).toHaveLength(0);

    const flat = result.pages.flat().map((r) => r.id);
    expect(new Set(flat).size).toBe(flat.length);
  });
});

describe("detectAnomalies", () => {
  it("flags duplicates across pages", () => {
    const rows = createDataset(4);
    const anomalies = detectAnomalies(
      [[rows[0], rows[1]], [rows[1], rows[2]]],
      rows.map((r) => r.id)
    );
    expect(anomalies.some((a) => a.kind === "duplicate" && a.id === rows[1].id)).toBe(
      true
    );
  });
});
