import { z } from "zod";

export const HistoryOutcomeSchema = z.enum(["resumed", "handed-off", "gave-up", "cancelled"]);

export const HistoryEntrySchema = z.object({
  at: z.string(),
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  outcome: HistoryOutcomeSchema,
  /** The provider a handoff went to, or why the plugin stopped. */
  detail: z.string().nullable().default(null),
});

export type HistoryEntry = z.output<typeof HistoryEntrySchema>;

/** Entries older than this are dropped on every read and write. */
export const HISTORY_WINDOW_MS = 24 * 3_600_000;
export const HISTORY_MAX_ENTRIES = 50;
