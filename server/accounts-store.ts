import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Accounts } from "../shared/accounts";
import { quarantine, storePath } from "./jobs";

const FileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(
    z.string(),
    z.object({ resetAt: z.string(), scope: z.string().optional(), updatedAt: z.string() }),
  ),
});

export function accountsPath(): string {
  return join(dirname(storePath()), "accounts.json");
}

/** Account cooldowns outlive a plugin restart: a 5-hour window is longer than a reload. */
export async function readAccounts(path = accountsPath()): Promise<Accounts> {
  try {
    if ((await stat(path)).size > 1_000_000) return {};
    return FileSchema.parse(JSON.parse(await readFile(path, "utf8"))).accounts as Accounts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") await quarantine(path, error);
    return {};
  }
}

export async function writeAccounts(accounts: Accounts, path = accountsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, accounts }, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}
