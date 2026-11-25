import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * One scheduled continuation. Nothing about the agent's environment, its credentials or its
 * conversation is stored: only what the screen shows and what the scheduler needs.
 */
export const JobSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  title: z.string().nullable(),
  /**
   * `resume` waits and sends; `handoff` already created a replacement; `confirm` is a limit
   * that was only inferred from assistant prose and waits for the user to accept it.
   */
  kind: z.enum(["resume", "handoff", "confirm"]).default("resume"),
  /** The replacement agent, for a handoff. */
  handoffAgentId: z.string().nullable().default(null),
  /** When to send the continue, or when the handoff happened. */
  dueAt: z.string(),
  /** The agent's `lastUserMessageAt` when scheduled; a later user message cancels it. */
  baseline: z.string().nullable(),
  /** Continues already sent for this stop, so a limit that has not lifted cannot loop forever. */
  attempts: z.number().int().nonnegative().default(0),
  status: z.enum(["pending", "sent"]).default("pending"),
  sentAt: z.string().nullable().default(null),
});

export type Job = z.output<typeof JobSchema>;

const FileSchema = z.object({ version: z.literal(1), jobs: z.array(z.unknown()) });

/** A state file larger than this is not ours; refuse it instead of parsing memory away. */
export const MAX_STATE_BYTES = 1_000_000;
/** Sent rows are history; keep a day of them, and never let the file grow without bound. */
export const SENT_RETENTION_MS = 24 * 3_600_000;
export const MAX_SENT_JOBS = 100;

export function storePath(): string {
  const home = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(home, "plugin-data", "quota-relay", "jobs.json");
}

/** A corrupt file is set aside, never overwritten in place: the rows in it may still matter. */
export async function quarantine(path: string, reason: unknown): Promise<void> {
  const target = `${path}.corrupt-${Date.now()}`;
  try {
    await rename(path, target);
    console.error(`[quota-relay] ${path} was unreadable (${String(reason).slice(0, 120)}); moved to ${target}`);
  } catch {
    console.error(`[quota-relay] ${path} was unreadable and could not be moved aside`);
  }
}

/** Reads the jobs that still validate; one damaged row does not hide the rest. */
export async function readJobs(path = storePath()): Promise<Job[]> {
  let raw: string;
  try {
    if ((await stat(path)).size > MAX_STATE_BYTES) {
      console.error("[quota-relay] jobs file is implausibly large; starting empty");
      return [];
    }
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[quota-relay] could not read jobs", (error as { code?: string }).code ?? "error");
    }
    return [];
  }
  try {
    const file = FileSchema.parse(JSON.parse(raw));
    return file.jobs.flatMap((entry) => {
      const parsed = JobSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  } catch (error) {
    await quarantine(path, error);
    return [];
  }
}

/** Sent rows expire; pending and confirm rows never do. */
export function pruneJobs(jobs: Job[], now: Date = new Date()): Job[] {
  const kept = jobs.filter((job) => {
    if (job.status !== "sent") return true;
    const at = Date.parse(job.sentAt ?? job.dueAt);
    return !Number.isFinite(at) || now.getTime() - at < SENT_RETENTION_MS;
  });
  const sent = kept
    .filter((job) => job.status === "sent")
    .sort((a, b) => Date.parse(b.dueAt) - Date.parse(a.dueAt))
    .slice(0, MAX_SENT_JOBS);
  const keepSent = new Set(sent.map((job) => `${job.agentId}:${job.dueAt}`));
  return kept.filter((job) => job.status !== "sent" || keepSent.has(`${job.agentId}:${job.dueAt}`));
}

/** Atomic write, owner-only: the file names your workspaces and agents. */
export async function writeJobs(jobs: Job[], path = storePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ version: 1, jobs: pruneJobs(jobs) }, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
