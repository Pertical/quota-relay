import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { chainSchema } from "./handoff";

const schema = z.object({
  /** Turn automatic scheduling and sending on or off without uninstalling. */
  enabled: z.boolean().default(true),
  /**
   * When the running account runs out, continue the task on the next account in the chain
   * instead of waiting. Off by default: a handoff starts a new agent and spends its tokens.
   */
  autoSwitch: z.boolean().default(false),
  /** Ordered `provider` or `provider/model` entries, comma separated. */
  fallbackChain: chainSchema,
  /**
   * Choose the eligible account with the most quota left instead of the next in chain order.
   * Uses Paseo's usage sources; accounts with unknown usage keep chain order.
   */
  rebalance: z.boolean().default(false),
  /** How many accounts one task may visit. 1 means a single handoff. */
  maxHops: z.number().int().min(0).max(5).default(1),
  /** Extra instructions added to the handoff brief. */
  handoffNote: z.string().trim().max(2000).nullable().default(null),
  /**
   * Include the stopped agent's last message in the handoff brief. Off by default: the
   * replacement may run on another vendor, and that text can contain anything the agent saw.
   */
  handoffIncludeLastMessage: z.boolean().default(false),
});

export type Settings = z.output<typeof schema>;

export const relaySettings = defineSettings({
  id: "quota-relay",
  scope: "host",
  version: 1,
  schema,
});

export const MAX_HOPS_LIMIT = 5;

export const DEFAULT_PROMPT =
  "Continue the unfinished work from where it stopped. " +
  "Don't redo finished work, interrupt anything still running, or restart what the user canceled.";
