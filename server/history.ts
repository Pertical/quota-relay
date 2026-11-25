import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { HISTORY_MAX_ENTRIES, HISTORY_WINDOW_MS, HistoryEntrySchema, type HistoryEntry } from "../shared/history";
import { quarantine, storePath } from "./jobs";

const FileSchema = z.object({ version: z.literal(1), entries: z.array(z.unknown()) });

export function historyPath(): string {
  return join(dirname(storePath()), "history.json");
}

export async function readHistory(path = historyPath()): Promise<HistoryEntry[]> {
  try {
    if ((await stat(path)).size > 1_000_000) return [];
    const file = FileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const now = Date.now();
    return file.entries.flatMap((entry) => {
      const parsed = HistoryEntrySchema.safeParse(entry);
      return parsed.success && now - Date.parse(parsed.data.at) < HISTORY_WINDOW_MS ? [parsed.data] : [];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") await quarantine(path, error);
    return [];
  }
}

export async function appendHistory(entries: HistoryEntry[], path = historyPath()): Promise<HistoryEntry[]> {
  const now = Date.now();
  const kept = entries
    .filter((entry) => now - Date.parse(entry.at) < HISTORY_WINDOW_MS)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, HISTORY_MAX_ENTRIES);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, entries: kept }, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  return kept;
}
