"use client";

import { useCallback, useEffect, useState } from "react";
import type { PageAnomaly, Row } from "@/lib/pagination";

type InsertMode = "before-head" | "mid-page";

type ComparePayload = {
  mutations: { atStep: number; inserted: Row }[];
  offset: {
    pages: Row[][];
    datasetSnapshots: number[];
    anomalies: PageAnomaly[];
    summary: { duplicates: number; skips: number };
  };
  cursor: {
    pages: Row[][];
    datasetSnapshots: number[];
    anomalies: PageAnomaly[];
    summary: { duplicates: number; skips: number };
  };
};

type LivePage = {
  mode: string;
  items: Row[];
  hasMore: boolean;
  nextOffset?: number;
  nextCursor?: string;
  itemCount: number;
  page?: number;
  offset?: number;
  cursor?: string | null;
};

export default function HomePage() {
  const [size, setSize] = useState(12);
  const [pageSize, setPageSize] = useState(3);
  const [insertMode, setInsertMode] = useState<InsertMode>("before-head");
  const [seed, setSeed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState<ComparePayload | null>(null);
  const [offsetLive, setOffsetLive] = useState<LivePage | null>(null);
  const [cursorLive, setCursorLive] = useState<LivePage | null>(null);
  const [offsetHistory, setOffsetHistory] = useState<Row[][]>([]);
  const [cursorHistory, setCursorHistory] = useState<Row[][]>([]);
  const [offsetPage, setOffsetPage] = useState(0);
  const [cursorUsed, setCursorUsed] = useState<string | null>(null);
  const [cursorNext, setCursorNext] = useState<string | null>(null);

  const api = useCallback(async (init?: RequestInit) => {
    const res = await fetch("/api/page", init);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Request failed");
    return json;
  }, []);

  const resetDataset = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reset",
          size,
          pageSize,
          seed: 3 + seed,
        }),
      });
      setOffsetHistory([]);
      setCursorHistory([]);
      setOffsetPage(0);
      setCursorUsed(null);
      setCursorNext(null);
      setCompare(null);

      const [o, c] = await Promise.all([
        fetch(`/api/page?mode=offset&page=0&limit=${pageSize}`).then((r) =>
          r.json()
        ),
        fetch(`/api/page?mode=cursor&page=0&limit=${pageSize}`).then((r) =>
          r.json()
        ),
      ]);
      setOffsetLive(o);
      setCursorLive(c);
      setCursorNext(c.nextCursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setBusy(false);
      setLoading(false);
    }
  }, [api, pageSize, seed, size]);

  useEffect(() => {
    void resetDataset();
    // Initial seed only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchOffsetPage = async (page: number) => {
    setBusy(true);
    setError(null);
    try {
      const o = await fetch(
        `/api/page?mode=offset&page=${page}&limit=${pageSize}`
      ).then((r) => r.json());
      setOffsetLive(o);
      setOffsetPage(page);
      setOffsetHistory((prev) => {
        const next = prev.slice(0, page);
        next[page] = o.items;
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Offset page failed");
    } finally {
      setBusy(false);
    }
  };

  const fetchCursorPage = async (cursor: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const q = cursor
        ? `/api/page?mode=cursor&cursor=${encodeURIComponent(cursor)}&limit=${pageSize}`
        : `/api/page?mode=cursor&page=0&limit=${pageSize}`;
      const c = await fetch(q).then((r) => r.json());
      setCursorLive(c);
      setCursorUsed(cursor);
      setCursorNext(c.nextCursor ?? null);
      setCursorHistory((prev) => [...prev, c.items]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cursor page failed");
    } finally {
      setBusy(false);
    }
  };

  const insertDuringWalk = async () => {
    setBusy(true);
    setError(null);
    try {
      await api({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "insert", insertMode }),
      });
      const [o, c] = await Promise.all([
        fetch(
          `/api/page?mode=offset&page=${offsetPage}&limit=${pageSize}`
        ).then((r) => r.json()),
        cursorUsed
          ? fetch(
              `/api/page?mode=cursor&cursor=${encodeURIComponent(cursorUsed)}&limit=${pageSize}`
            ).then((r) => r.json())
          : fetch(`/api/page?mode=cursor&page=0&limit=${pageSize}`).then((r) =>
              r.json()
            ),
      ]);
      setOffsetLive(o);
      setCursorLive(c);
      setCursorNext(c.nextCursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Insert failed");
    } finally {
      setBusy(false);
    }
  };

  /** One-click: walk with insert, show offset vs cursor anomalies. */
  const runCompare = async () => {
    setBusy(true);
    setError(null);
    try {
      const json = await api({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "compare",
          size,
          pageSize,
          seed: 3 + seed,
          insertMode,
        }),
      });
      setCompare(json as ComparePayload);
      const [o, c] = await Promise.all([
        fetch(`/api/page?mode=offset&page=0&limit=${pageSize}`).then((r) =>
          r.json()
        ),
        fetch(`/api/page?mode=cursor&page=0&limit=${pageSize}`).then((r) =>
          r.json()
        ),
      ]);
      setOffsetLive(o);
      setCursorLive(c);
      setCursorNext(c.nextCursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Compare failed");
    } finally {
      setBusy(false);
    }
  };

  const offsetDupIds = new Set(
    (compare?.offset.anomalies ?? [])
      .filter((a) => a.kind === "duplicate")
      .map((a) => a.id)
  );
  const offsetSkipIds = new Set(
    (compare?.offset.anomalies ?? [])
      .filter((a) => a.kind === "skip")
      .map((a) => a.id)
  );

  if (loading) {
    return (
      <main>
        <p className="tag">Loading pagination dataset…</p>
      </main>
    );
  }

  return (
    <main>
      <span className="brand">Saeed Rumaneh · Pagination Race</span>
      <h1>Offset vs cursor under live inserts</h1>
      <p className="lede">
        Dataset persists in <code>data/items.json</code>. Page via{" "}
        <code>GET /api/page?mode=offset|cursor&amp;page=</code>, insert mid-walk,
        then compare. Offset re-reads a sliding window and can skip or duplicate
        rows; cursor anchors on last (rank, id).
      </p>

      <div className="controls">
        <label>
          Dataset size
          <input
            type="number"
            min={6}
            max={40}
            value={size}
            onChange={(e) => setSize(Number(e.target.value) || 12)}
          />
        </label>
        <label>
          Page size
          <input
            type="number"
            min={2}
            max={8}
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value) || 3)}
          />
        </label>
        <label>
          Insert timing
          <select
            value={insertMode}
            onChange={(e) => setInsertMode(e.target.value as InsertMode)}
          >
            <option value="before-head">Before first page (shift left)</option>
            <option value="mid-page">Into the middle of the list</option>
          </select>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setSeed((s) => s + 1);
            void (async () => {
              setBusy(true);
              try {
                await api({
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    action: "reset",
                    size,
                    pageSize,
                    seed: 3 + seed + 1,
                  }),
                });
                setOffsetHistory([]);
                setCursorHistory([]);
                setOffsetPage(0);
                setCursorUsed(null);
                setCursorNext(null);
                setCompare(null);
                const [o, c] = await Promise.all([
                  fetch(`/api/page?mode=offset&page=0&limit=${pageSize}`).then(
                    (r) => r.json()
                  ),
                  fetch(`/api/page?mode=cursor&page=0&limit=${pageSize}`).then(
                    (r) => r.json()
                  ),
                ]);
                setOffsetLive(o);
                setCursorLive(c);
                setCursorNext(c.nextCursor ?? null);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Reshuffle failed");
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          Reshuffle ranks
        </button>
        <button type="button" disabled={busy} onClick={() => void resetDataset()}>
          Reset dataset
        </button>
        <button type="button" disabled={busy} onClick={() => void insertDuringWalk()}>
          Insert during walk
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void runCompare()}
          style={{ fontWeight: 700 }}
        >
          Offset vs cursor (one-click)
        </button>
      </div>

      {error ? (
        <p className="mutation-log" style={{ color: "var(--coral)" }} role="alert">
          {error}
        </p>
      ) : null}

      <div className="controls" style={{ marginTop: "0.75rem" }}>
        <button
          type="button"
          disabled={busy || !offsetLive?.hasMore}
          onClick={() => void fetchOffsetPage(offsetPage + 1)}
        >
          Next offset page ({offsetPage})
        </button>
        <button
          type="button"
          disabled={busy || !cursorLive?.hasMore}
          onClick={() => void fetchCursorPage(cursorNext)}
        >
          Next cursor page
        </button>
        <span className="tag">
          Live items: {offsetLive?.itemCount ?? "—"} · inserts reflected in{" "}
          <code>data/items.json</code>
        </span>
      </div>

      {!offsetLive?.items?.length && !cursorLive?.items?.length ? (
        <p className="tag" style={{ marginTop: "1rem" }}>
          Dataset is empty — click Reset dataset to seed rows.
        </p>
      ) : null}

      <div className="grid" style={{ marginTop: "1.25rem" }}>
        <section className="lane">
          <h2>Live offset page</h2>
          <p className="tag">
            page={offsetPage} · GET /api/page?mode=offset&amp;page=
          </p>
          {offsetLive?.items.map((row) => (
            <div className="row" key={`lo-${row.id}`}>
              <span>
                {row.id} · {row.label}
              </span>
              <span>rank {row.rank}</span>
            </div>
          ))}
          {offsetHistory.length > 0 && (
            <p className="tag" style={{ marginTop: "0.75rem" }}>
              Walked {offsetHistory.length} offset page(s) this session
            </p>
          )}
        </section>
        <section className="lane">
          <h2>Live cursor page</h2>
          <p className="tag">GET /api/page?mode=cursor</p>
          {cursorLive?.items.map((row) => (
            <div className="row" key={`lc-${row.id}`}>
              <span>
                {row.id} · {row.label}
              </span>
              <span>rank {row.rank}</span>
            </div>
          ))}
          {cursorHistory.length > 0 && (
            <p className="tag" style={{ marginTop: "0.75rem" }}>
              Walked {cursorHistory.length} cursor page(s) this session
            </p>
          )}
        </section>
      </div>

      {compare && (
        <>
          <div className="mutation-log" style={{ marginTop: "1.5rem" }}>
            Mutation at page step <code>{compare.mutations[0]?.atStep}</code>:
            insert <code>{compare.mutations[0]?.inserted.id}</code> with rank{" "}
            <code>{compare.mutations[0]?.inserted.rank}</code>
          </div>

          <div className="mutation-log">
            <strong>Why offset hurts:</strong> an insert before the window shifts
            every later page. Rows already shown can reappear (
            <em>duplicates</em>, highlighted), and rows that should have been next
            never appear (<em>skips</em>, listed below). Cursor keeps the last
            seen (rank, id) so early inserts do not resurface seen ids.
          </div>

          <div className="stats">
            <div
              className={`stat ${compare.offset.summary.duplicates ? "bad" : ""}`}
            >
              <strong>{compare.offset.summary.duplicates}</strong>
              <span>Offset duplicates</span>
            </div>
            <div className={`stat ${compare.offset.summary.skips ? "bad" : ""}`}>
              <strong>{compare.offset.summary.skips}</strong>
              <span>Offset skips</span>
            </div>
            <div className="stat">
              <strong>{compare.cursor.summary.duplicates}</strong>
              <span>Cursor duplicates</span>
            </div>
            <div className="stat">
              <strong>{compare.offset.datasetSnapshots.join(" → ")}</strong>
              <span>Dataset size per step</span>
            </div>
          </div>

          <div className="grid" style={{ marginTop: "1.5rem" }}>
            <section className="lane">
              <h2>Offset race</h2>
              <p className="tag">next page = previous offset + pageSize</p>
              {compare.offset.pages.map((page, i) => (
                <div className="page-block" key={`o-${i}`}>
                  <strong>Page {i + 1}</strong>
                  {page.map((row) => (
                    <div
                      className={`row ${offsetDupIds.has(row.id) ? "dup" : ""}`}
                      key={`${i}-${row.id}`}
                    >
                      <span>
                        {row.id} · {row.label}
                        {offsetDupIds.has(row.id) ? " · DUP" : ""}
                      </span>
                      <span>rank {row.rank}</span>
                    </div>
                  ))}
                </div>
              ))}
              {[...offsetSkipIds].length === 0 ? (
                <p className="tag">No skipped rows in this walk.</p>
              ) : (
                [...offsetSkipIds].map((id) => (
                  <div className="row skip-marker" key={`skip-${id}`}>
                    skipped in walk: {id} — pushed past the advancing offset
                  </div>
                ))
              )}
            </section>

            <section className="lane">
              <h2>Cursor race</h2>
              <p className="tag">next page = rows after last (rank, id)</p>
              {compare.cursor.pages.map((page, i) => (
                <div className="page-block" key={`c-${i}`}>
                  <strong>Page {i + 1}</strong>
                  {page.map((row) => (
                    <div className="row" key={`${i}-${row.id}`}>
                      <span>
                        {row.id} · {row.label}
                      </span>
                      <span>rank {row.rank}</span>
                    </div>
                  ))}
                </div>
              ))}
              <p className="tag">
                Cursor skips: {compare.cursor.summary.skips} · duplicates:{" "}
                {compare.cursor.summary.duplicates}
              </p>
            </section>
          </div>
        </>
      )}

      {!compare ? (
        <p className="tag" style={{ marginTop: "1.5rem" }}>
          No race result yet — click <strong>Offset vs cursor (one-click)</strong>{" "}
          to insert mid-walk and explain skipped/duplicate rows.
        </p>
      ) : null}
    </main>
  );
}
