/**
 * Persist the mutable pagination dataset under data/items.json.
 * Server-only — do not import from client components.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDataset, sortByRank, type Row } from "./pagination";

export type ItemsFile = {
  items: Row[];
  /** Original ids before mid-walk inserts (for skip detection). */
  baselineIds: string[];
  pageSize: number;
  offset: number;
  cursor: string | null;
  insertCount: number;
};

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "items.json");

export function defaultItemsFile(
  size = 12,
  pageSize = 3,
  seed = 3
): ItemsFile {
  const items = createDataset(size, seed);
  return {
    items,
    baselineIds: items.map((r) => r.id),
    pageSize,
    offset: 0,
    cursor: null,
    insertCount: 0,
  };
}

export async function readItems(): Promise<ItemsFile> {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as ItemsFile;
    if (!Array.isArray(parsed.items)) throw new Error("bad shape");
    return {
      ...defaultItemsFile(),
      ...parsed,
      items: sortByRank(parsed.items),
    };
  } catch {
    const fresh = defaultItemsFile();
    await writeItems(fresh);
    return fresh;
  }
}

export async function writeItems(data: ItemsFile): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const payload: ItemsFile = {
    ...data,
    items: sortByRank(data.items),
  };
  await writeFile(DATA_FILE, JSON.stringify(payload, null, 2), "utf8");
}
