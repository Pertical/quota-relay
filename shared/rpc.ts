import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const JobViewSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  title: z.string().nullable(),
  kind: z.enum(["resume", "handoff", "confirm"]),
  handoffAgentId: z.string().nullable(),
  dueAt: z.string(),
  attempts: z.number().int().nonnegative(),
  status: z.enum(["pending", "sent"]),
});

export const AccountViewSchema = z.object({
  provider: z.string(),
  resetAt: z.string(),
  cooling: z.boolean(),
  scope: z.string().nullable(),
});

export const HistoryViewSchema = z.object({
  at: z.string(),
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  outcome: z.enum(["resumed", "handed-off", "gave-up", "cancelled"]),
  detail: z.string().nullable(),
});

export const listRpc = defineRpc({
  name: "relay.list",
  input: z.object({}),
  output: z.object({
    jobs: z.array(JobViewSchema),
    accounts: z.array(AccountViewSchema),
    history: z.array(HistoryViewSchema),
  }),
});

export const cancelRpc = defineRpc({
  name: "relay.cancel",
  input: z.object({ agentId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const resumeNowRpc = defineRpc({
  name: "relay.resume-now",
  input: z.object({ agentId: z.string() }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

/** Checks chain entries against the providers this daemon knows, before a handoff relies on them. */
export const checkChainRpc = defineRpc({
  name: "relay.check-chain",
  input: z.object({ chain: z.string().max(400) }),
  output: z.object({
    /** Entries naming a provider this daemon does not have. */
    unknown: z.array(z.string()),
    /** Entries naming a provider that exists but is not available right now. */
    unavailable: z.array(z.string()),
    /** False when the daemon could not list its providers; nothing was checked. */
    checked: z.boolean(),
  }),
});
