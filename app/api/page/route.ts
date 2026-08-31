import { NextRequest, NextResponse } from "next/server";
import {
  defaultItemsFile,
  readItems,
  writeItems,
} from "@/lib/items-store";
import {
  detectAnomalies,
  insertRow,
  pageByCursor,
  pageByOffset,
  summarizeAnomalies,
  walkCursorWithInserts,
  walkOffsetWithInserts,
  type MutationEvent,
  type Row,
} from "@/lib/pagination";

export const runtime = "nodejs";

function parseIntParam(
  value: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * GET /api/page?mode=offset|cursor&page=
 * Reads the persisted dataset and returns one page.
 * `page` is 0-based for offset mode; for cursor mode use `cursor=` (or omit for first page).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const mode = searchParams.get("mode") === "cursor" ? "cursor" : "offset";
  const data = await readItems();
  const limit = parseIntParam(
    searchParams.get("limit"),
    data.pageSize,
    1,
    20
  );

  if (mode === "offset") {
    const page = parseIntParam(searchParams.get("page"), 0, 0, 10_000);
    const offset = page * limit;
    const result = pageByOffset(data.items, offset, limit);
    return NextResponse.json({
      mode,
      page,
      offset,
      limit,
      itemCount: data.items.length,
      insertCount: data.insertCount,
      ...result,
    });
  }

  const cursorParam = searchParams.get("cursor");
  const cursor =
    cursorParam && cursorParam.length > 0
      ? cursorParam
      : searchParams.get("page") === "0" || !searchParams.get("page")
        ? null
        : data.cursor;
  const result = pageByCursor(data.items, cursor, limit);
  return NextResponse.json({
    mode,
    cursor,
    limit,
    itemCount: data.items.length,
    insertCount: data.insertCount,
    ...result,
  });
}

type PostBody = {
  action?: "reset" | "insert" | "advance" | "compare";
  size?: number;
  pageSize?: number;
  seed?: number;
  insertMode?: "before-head" | "mid-page";
  mode?: "offset" | "cursor";
};

/**
 * POST /api/page — mutate dataset or run a race compare.
 * actions: reset | insert | advance | compare
 */
export async function POST(request: NextRequest) {
  let body: PostBody = {};
  try {
    body = (await request.json()) as PostBody;
  } catch {
    body = {};
  }

  const action = body.action ?? "reset";

  if (action === "reset") {
    const fresh = defaultItemsFile(
      body.size ?? 12,
      body.pageSize ?? 3,
      body.seed ?? 3
    );
    await writeItems(fresh);
    return NextResponse.json({ ok: true, dataset: fresh });
  }

  if (action === "insert") {
    const data = await readItems();
    const mode = body.insertMode ?? "before-head";
    const inserted = buildInsert(data.items, data.insertCount, mode);
    data.items = insertRow(data.items, inserted);
    data.insertCount += 1;
    await writeItems(data);
    return NextResponse.json({
      ok: true,
      inserted,
      itemCount: data.items.length,
      insertCount: data.insertCount,
    });
  }

  if (action === "advance") {
    const data = await readItems();
    const mode = body.mode === "cursor" ? "cursor" : "offset";
    const limit = data.pageSize;

    if (mode === "offset") {
      const result = pageByOffset(data.items, data.offset, limit);
      const nextOffset = result.nextOffset ?? data.offset + result.items.length;
      data.offset = result.hasMore ? nextOffset : data.offset;
      await writeItems(data);
      return NextResponse.json({
        mode,
        offset: data.offset - (result.hasMore ? limit : 0),
        ...result,
        itemCount: data.items.length,
      });
    }

    const result = pageByCursor(data.items, data.cursor, limit);
    data.cursor = result.nextCursor ?? data.cursor;
    await writeItems(data);
    return NextResponse.json({
      mode,
      cursor: data.cursor,
      ...result,
      itemCount: data.items.length,
    });
  }

  if (action === "compare") {
    const size = body.size ?? 12;
    const pageSize = body.pageSize ?? 3;
    const seed = body.seed ?? 3;
    const insertMode = body.insertMode ?? "before-head";
    const initial = defaultItemsFile(size, pageSize, seed).items;
    const mutations: MutationEvent[] = [
      buildMutationEvent(initial, insertMode),
    ];

    const offset = walkOffsetWithInserts({
      initial,
      pageSize,
      maxPages: 6,
      mutations,
    });
    const cursor = walkCursorWithInserts({
      initial,
      pageSize,
      maxPages: 6,
      mutations,
    });

    // Persist the final offset-walk dataset so GET /api/page reflects the race.
    await writeItems({
      items: offset.finalRows,
      baselineIds: initial.map((r) => r.id),
      pageSize,
      offset: 0,
      cursor: null,
      insertCount: 1,
    });

    return NextResponse.json({
      ok: true,
      mutations,
      offset: {
        pages: offset.pages,
        datasetSnapshots: offset.datasetSnapshots,
        anomalies: offset.anomalies,
        summary: summarizeAnomalies(offset.anomalies),
      },
      cursor: {
        pages: cursor.pages,
        datasetSnapshots: cursor.datasetSnapshots,
        anomalies: cursor.anomalies,
        summary: summarizeAnomalies(cursor.anomalies),
      },
      liveAnomalies: detectAnomalies(
        offset.pages,
        initial.map((r) => r.id)
      ),
    });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}

function buildInsert(
  items: Row[],
  insertCount: number,
  mode: "before-head" | "mid-page"
): Row {
  if (mode === "before-head" || items.length === 0) {
    const headRank = items[0]?.rank ?? 10;
    return {
      id: `item-inject-${insertCount + 1}`,
      rank: headRank - 8,
      label: `INJECT @ head #${insertCount + 1}`,
      createdAt: Date.now(),
    };
  }
  const mid = items[Math.floor(items.length / 3)]!;
  return {
    id: `item-inject-${insertCount + 1}`,
    rank: mid.rank - 1,
    label: `INJECT @ mid #${insertCount + 1}`,
    createdAt: Date.now(),
  };
}

function buildMutationEvent(
  initial: Row[],
  mode: "before-head" | "mid-page"
): MutationEvent {
  if (mode === "before-head") {
    return {
      atStep: 1,
      insertIndex: 0,
      inserted: {
        id: "item-inject",
        rank: initial[0]!.rank - 8,
        label: "INJECT @ head",
        createdAt: Date.now(),
      },
    };
  }
  const mid = initial[Math.floor(initial.length / 3)]!;
  return {
    atStep: 1,
    insertIndex: Math.floor(initial.length / 3),
    inserted: {
      id: "item-inject",
      rank: mid.rank - 1,
      label: "INJECT @ mid",
      createdAt: Date.now(),
    },
  };
}
