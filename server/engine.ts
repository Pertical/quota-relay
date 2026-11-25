import { coolingUntil, isCooling, pruneAccounts, recordAccount, type Accounts } from "../shared/accounts";
import { briefRequests, candidateTargets, HANDOFF_LEAD, handoffPrompt, parseChain, targetSelector, type FallbackTarget } from "../shared/handoff";
import { appendHistory, readHistory } from "./history";
import type { HistoryEntry } from "../shared/history";
import { isLimitNotice, isStructuredLimit, isSubscriptionLimit, limitScope, parseResetAt } from "../shared/limit";
import { parseUsage, rankByHeadroom, type UsageInfo } from "../shared/usage";
import { DEFAULT_PROMPT, type Settings } from "../shared/settings";
import { pruneJobs, readJobs, writeJobs, type Job } from "./jobs";
import { readAccounts, writeAccounts } from "./accounts-store";

/** Only the parts of the SDK this plugin uses. */
export interface EngineApi {
  agents: {
    ref(agentId: string): {
      refresh(): Promise<{ agent: AgentSnapshot } | null>;
      send(text: string): Promise<void>;
      timeline: {
        refetch(options: { direction: "tail"; limit: number; wholeTurns?: boolean }): Promise<{ entries?: unknown[] } | null>;
      };
    };
  };
  providers?: {
    listUsage(options?: { requestId?: string }): Promise<unknown>;
  };
  workspaces?: {
    ref(workspaceId: string): {
      agents: {
        create(options: {
          idempotencyKey?: string;
          config: { provider: string };
          prompt: string;
          title?: string;
          metadata?: Record<string, unknown>;
        }): Promise<{ id?: unknown } | null>;
      };
    };
  };
}

export interface AgentSnapshot {
  status?: string | null;
  archivedAt?: string | null;
  lastUserMessageAt?: string | null;
  title?: string | null;
  provider?: string | null;
}

export type { Settings };

/** Continues sent for one stop before the plugin gives up. */
export const MAX_ATTEMPTS = 3;
/** Where to wait when a subscription limit states no reset instant. */
const FALLBACK_DELAY_MS = 15 * 60_000;
/** Resumes one account may send per tick, so agents sharing one reset do not wake together. */
const PER_ACCOUNT_PER_TICK = 2;
/** Edited files listed in a handoff brief, so the replacement knows where to look first. */
const MAX_BRIEF_FILES = 20;

/** Lineage keys stored on the agents a handoff creates. */
export const ORIGIN_KEY = "quota-relay.origin";
export const HOP_KEY = "quota-relay.hop";
/** The redacted requests a brief carried, so a further hop can pass them on. Stored by Paseo locally. */
export const REQUESTS_KEY = "quota-relay.requests";

/** Timeline entries scanned for the user's recent requests when a handoff is written. */
const REQUEST_SCAN_ENTRIES = 200;

export interface TurnEvent {
  agent: {
    id: string;
    provider: string;
    title: string | null;
    workspaceId?: string | null;
    cwd?: string;
    metadata?: Record<string, unknown> | null;
    /** A hidden helper agent. Nobody watches it, so the plugin leaves it alone. */
    background?: boolean;
    /** Set on a sub-agent. Its parent owns the task, so it is never replaced by a handoff. */
    parentAgentId?: string | null;
  };
  turnId: string | null;
  outcome:
    | { kind: "completed" }
    | { kind: "failed"; error: { message: string; code?: string } }
    | { kind: "canceled"; reason: string };
}

/** After a send, a further limit this soon counts as the same stop and consumes an attempt. */
const SAME_STOP_MS = 30 * 60_000;
/** Waiting after a failed send, by attempt number. */
const SEND_BACKOFF_MS = [5, 15, 45].map((minutes) => minutes * 60_000);
/** How long a transient rate limit (a bare 429 with no reset) waits before the same agent continues. */
const TRANSIENT_WAIT_MS = 2 * 60_000;
/** Agents on one account due at the same reset are spread out by up to this much. */
const MAX_JITTER_MS = 60_000;

const jitter = (): number => Math.floor(Math.random() * MAX_JITTER_MS);

/** Logs never echo provider text: it can carry request, org or key context. */
const codeOf = (error: unknown): string => {
  const value = error as { code?: unknown; name?: unknown };
  if (typeof value?.code === "string") return value.code.slice(0, 60);
  if (typeof value?.name === "string") return value.name.slice(0, 60);
  return "error";
};

interface TurnContext {
  user: string[];
  assistant: string[];
  errors: string[];
}

interface TimelineItem {
  type?: unknown;
  text?: unknown;
  message?: unknown;
  turnId?: unknown;
}

/**
 * A timeline entry is `{ provider, turnId, item: { type, text | message } }`. The item's fields are
 * lifted next to the entry's `turnId`; a flat item is accepted too.
 */
export function timelineItem(entry: unknown): TimelineItem | null {
  if (!entry || typeof entry !== "object") return null;
  const outer = entry as { item?: unknown; turnId?: unknown };
  if (outer.item && typeof outer.item === "object") return { ...(outer.item as TimelineItem), turnId: outer.turnId };
  return outer as TimelineItem;
}

/** The file an edit or write tool call changed, from a timeline item. */
function editedPath(item: TimelineItem | null): string | null {
  if (item?.type !== "tool_call") return null;
  const detail = (item as { detail?: { type?: unknown; filePath?: unknown } }).detail;
  if (detail?.type !== "edit" && detail?.type !== "write") return null;
  return typeof detail.filePath === "string" && detail.filePath.length > 0 ? detail.filePath : null;
}

const backoff = (attempts: number): number => SEND_BACKOFF_MS[Math.min(Math.max(attempts, 1), SEND_BACKOFF_MS.length) - 1];

type HandoffResult =
  | { kind: "ok"; id: string; target: FallbackTarget }
  | { kind: "ambiguous"; target: FallbackTarget }
  | { kind: "failed" };

interface EngineState {
  jobs: Job[] | null;
  accounts: Accounts | null;
  history: HistoryEntry[] | null;
}

export function createEngine(
  readSettings: () => Promise<Settings | null>,
  store?: { jobs?: string; accounts?: string; history?: string },
) {
  const state: EngineState = { jobs: null, accounts: null, history: null };
  let queue: Promise<unknown> = Promise.resolve();
  let ticking = false;
  let dirty = false;
  let usageCache: { at: number; usage: Map<string, UsageInfo> } | null = null;

  /** Usage sources are read through Paseo, cached briefly, and never allowed to block a handoff. */
  async function usageSnapshot(api: EngineApi): Promise<Map<string, UsageInfo> | null> {
    if (usageCache && Date.now() - usageCache.at < 60_000) return usageCache.usage;
    if (!api.providers) return null;
    try {
      const usage = await Promise.race([
        api.providers.listUsage({}).then(parseUsage),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      if (usage) usageCache = { at: Date.now(), usage };
      return usage;
    } catch (error) {
      console.error("[quota-relay] could not read usage; keeping chain order", codeOf(error));
      return null;
    }
  }

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const jobs = async (): Promise<Job[]> => (state.jobs ??= await readJobs(store?.jobs));
  const accounts = async (): Promise<Accounts> => (state.accounts ??= pruneAccounts(await readAccounts(store?.accounts), new Date()));
  const history = async (): Promise<HistoryEntry[]> => (state.history ??= await readHistory(store?.history));

  /** A failed write is retried, and never leaves memory claiming something the file lacks. */
  const saveJobs = async (): Promise<void> => {
    if (!state.jobs) return;
    // Expired sent rows leave memory too, not only the file.
    state.jobs = pruneJobs(state.jobs);
    try {
      await writeJobs(state.jobs, store?.jobs);
      dirty = false;
    } catch (error) {
      dirty = true;
      console.error("[quota-relay] could not save jobs", codeOf(error));
    }
  };

  const record = async (entry: HistoryEntry): Promise<void> => {
    try {
      const prior = await history();
      state.history = await appendHistory([entry, ...prior], store?.history);
    } catch (error) {
      console.error("[quota-relay] could not save history", codeOf(error));
    }
  };

  /** The turn's own items. Reads one whole turn and keeps it only when it is this turn. */
  async function readTurn(api: EngineApi, agentId: string, turnId: string | null): Promise<TurnContext> {
    const context: TurnContext = { user: [], assistant: [], errors: [] };
    if (!turnId) return context;
    try {
      const page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true });
      for (const entry of page?.entries ?? []) {
        const item = timelineItem(entry);
        if (!item) continue;
        // Older payloads omit turnId; a payload that names another turn is stale and skipped.
        if (typeof item.turnId === "string" && item.turnId !== turnId) continue;
        if (item.type === "assistant_message" && typeof item.text === "string") context.assistant.push(item.text);
        else if (item.type === "user_message" && typeof item.text === "string") context.user.push(item.text);
        else if (item.type === "error" && typeof item.message === "string") context.errors.push(item.message);
      }
    } catch (error) {
      console.error("[quota-relay] could not read the turn", codeOf(error));
    }
    return context;
  }

  /**
   * What the replacement needs to know, read once from the source agent's recent timeline.
   * Requests: what the user actually asked for, oldest first. The failed turn alone is not enough:
   * after a resume its message is the plugin's own continue prompt, and on a replacement it is a
   * brief, so requests a previous hop carried come first. Files: the paths the agent edited, so the
   * replacement looks there first instead of exploring. Paths only, never contents.
   */
  async function briefContext(api: EngineApi, event: TurnEvent, turn: TurnContext): Promise<{ requests: string[]; files: string[] }> {
    const isUser = (text: string) => text.trim() !== DEFAULT_PROMPT && !text.trimStart().startsWith(HANDOFF_LEAD);

    let own = turn.user;
    const files = new Set<string>();
    try {
      const page = await api.agents.ref(event.agent.id).timeline.refetch({ direction: "tail", limit: REQUEST_SCAN_ENTRIES });
      const scanned: string[] = [];
      for (const entry of page?.entries ?? []) {
        const item = timelineItem(entry);
        if (item?.type === "user_message" && typeof item.text === "string") scanned.push(item.text);
        const path = editedPath(item);
        if (path) files.add(path);
      }
      if (scanned.length > 0) own = scanned;
    } catch (error) {
      console.error("[quota-relay] could not read recent requests", codeOf(error));
    }

    const carried = event.agent.metadata?.[REQUESTS_KEY];
    const inherited = Array.isArray(carried) ? carried.filter((text): text is string => typeof text === "string") : [];
    return { requests: [...inherited, ...own.filter(isUser)], files: [...files].slice(-MAX_BRIEF_FILES) };
  }

  async function handoff(
    api: EngineApi,
    event: TurnEvent,
    settings: Settings,
    turn: TurnContext,
    hop: number,
  ): Promise<HandoffResult> {
    const chain = parseChain(settings.fallbackChain);
    const now = new Date();
    const free = await accounts();
    const candidates = candidateTargets(chain, event.agent.provider, {
      cooling: (provider) => isCooling(free, provider, now),
    });
    // Rebalancing only reorders the eligible accounts; the chain still decides who is eligible.
    const ranked = settings.rebalance
      ? rankByHeadroom(candidates, (await usageSnapshot(api)) ?? new Map())
      : candidates;
    const target = ranked[0] ?? null;
    const workspaceId = event.agent.workspaceId ?? null;
    if (!target || !api.workspaces || !workspaceId) return { kind: "failed" };

    const context = await briefContext(api, event, turn);
    const requests = briefRequests(context.requests);
    const prompt = handoffPrompt({
      sourceTitle: event.agent.title,
      sourceProvider: event.agent.provider,
      sourceCwd: event.agent.cwd ?? null,
      note: settings.handoffNote,
      requests,
      files: context.files,
      // Off by default: the replacement may be a different vendor, and assistant text can
      // contain anything the agent read. The brief tells it to inspect the working tree instead.
      lastAssistant: settings.handoffIncludeLastMessage ? turn.assistant.at(-1) ?? null : null,
    });

    let created: { id?: unknown } | null = null;
    try {
      created = await api.workspaces.ref(workspaceId).agents.create({
        // A retried hook for the same stop must not start a second replacement.
        idempotencyKey: `quota-relay:${event.agent.id}:${event.turnId ?? now.toISOString()}`,
        config: { provider: targetSelector(target) },
        prompt,
        title: `${event.agent.title ?? "Untitled"} → ${target.provider}`,
        metadata: {
          [ORIGIN_KEY]: event.agent.id,
          [HOP_KEY]: hop + 1,
          "quota-relay.from": event.agent.provider,
          // The replacement's own first message is the brief, so the next hop reads the requests here.
          [REQUESTS_KEY]: requests,
        },
      });
    } catch (error) {
      console.error(`[quota-relay] could not hand off to ${targetSelector(target)}`, codeOf(error));
      return { kind: "failed" };
    }

    const id = created && typeof created === "object" && typeof created.id === "string" ? created.id : null;
    if (!id) {
      // The agent may exist without an id we can record; scheduling a resume as well would put
      // two agents on one task, so stop here and let the user look.
      console.error(`[quota-relay] handoff to ${targetSelector(target)} returned no agent id`);
      return { kind: "ambiguous", target };
    }
    console.error(`[quota-relay] handed ${event.agent.id} off to ${targetSelector(target)} as ${id}`);
    return { kind: "ok", id, target };
  }

  /** When to continue: the stated reset, a short wait for a blip, the account's own cooldown, or a fixed delay. */
  async function dueWhen(provider: string, reset: Date | null, transient: boolean, now: Date): Promise<Date> {
    if (reset) return reset;
    if (transient) return new Date(now.getTime() + TRANSIENT_WAIT_MS);
    const free = await accounts();
    // Only this account's own reset counts; another account freeing up says nothing about this one.
    const own = coolingUntil(free, provider, now);
    if (own) return own;
    return new Date(now.getTime() + FALLBACK_DELAY_MS);
  }

  async function onTurnAfter(api: EngineApi, event: TurnEvent): Promise<void> {
    const settings = await readSettings();
    if (!settings?.enabled) return;
    if (event.outcome.kind === "canceled") return;
    if (event.agent.background) return;

    const turn = await readTurn(api, event.agent.id, event.turnId);
    const failed = event.outcome.kind === "failed" ? event.outcome.error : null;

    // Only a stop the provider itself reported may act unattended. Prose from the assistant is a
    // proposal, queued for the user instead: a repo file or a tool result the agent quoted must
    // not be able to send prompts or start agents on another vendor.
    const structured =
      (failed && isStructuredLimit(failed.message, failed.code) ? failed.message : null) ??
      turn.errors.find((text) => isLimitNotice(text)) ??
      null;
    const heuristic = structured ? null : turn.assistant.find((text) => isLimitNotice(text)) ?? null;
    const notice = structured ?? heuristic;
    if (!notice) return;

    const now = new Date();
    const reset = parseResetAt(notice, now);
    const provider = event.agent.provider;
    const hop = Number(event.agent.metadata?.[HOP_KEY] ?? 0);

    // A cooldown inferred from prose could park an account for hours; only a reported stop counts.
    if (structured) {
      await serialize(async () => {
        const current = await accounts();
        const next = recordAccount(current, provider, reset, limitScope(notice), now);
        if (next !== current) {
          state.accounts = next;
          await writeAccounts(next, store?.accounts).catch((error) =>
            console.error("[quota-relay] could not save accounts", codeOf(error)),
          );
        }
      });
    }

    if (!structured) {
      await serialize(async () => {
        const current = await jobs();
        state.jobs = [
          ...current.filter((entry) => entry.agentId !== event.agent.id),
          {
            agentId: event.agent.id,
            provider,
            title: event.agent.title,
            kind: "confirm",
            handoffAgentId: null,
            dueAt: now.toISOString(),
            baseline: null,
            attempts: 0,
            status: "pending",
            sentAt: null,
          },
        ];
        await saveJobs();
      });
      return;
    }

    // A bare 429 clears in minutes: moving the task to another vendor would cost far more than
    // waiting. A sub-agent belongs to its parent, so it is resumed in place, never replaced.
    const transient = !isSubscriptionLimit(notice, failed?.code, reset);
    // One stop, one replacement: if this agent already handed its task off, a later limit on it
    // (say, after the user wrote to it again) waits here rather than starting another agent.
    const movedBefore = (await jobs()).some((job) => job.agentId === event.agent.id && job.kind === "handoff");
    const canMove = settings.autoSwitch && !transient && !event.agent.parentAgentId && !movedBefore;

    if (canMove && Number.isFinite(hop) && hop < settings.maxHops) {
      const moved = await handoff(api, event, settings, turn, hop);
      if (moved.kind !== "failed") {
        await serialize(async () => {
          const current = await jobs();
          state.jobs = [
            ...current.filter((entry) => entry.agentId !== event.agent.id),
            {
              agentId: event.agent.id,
              provider,
              title: event.agent.title,
              kind: "handoff",
              handoffAgentId: moved.kind === "ok" ? moved.id : null,
              dueAt: now.toISOString(),
              baseline: null,
              attempts: 1,
              status: "sent",
              sentAt: now.toISOString(),
            },
          ];
          await saveJobs();
          await record({
            at: now.toISOString(),
            agentId: event.agent.id,
            title: event.agent.title,
            provider,
            outcome: "handed-off",
            detail: moved.kind === "ok" ? targetSelector(moved.target) : `${targetSelector(moved.target)} (no id)`,
          });
        });
        return;
      }
    }

    await serialize(async () => {
      const current = await jobs();
      const prior = current.find((job) => job.agentId === event.agent.id);
      const sameStop =
        prior?.status === "sent" && prior.sentAt !== null && now.getTime() - Date.parse(prior.sentAt) < SAME_STOP_MS;
      const attempts = sameStop ? prior.attempts : 0;
      if (attempts >= MAX_ATTEMPTS) {
        state.jobs = current.filter((job) => job.agentId !== event.agent.id);
        await saveJobs();
        console.error(`[quota-relay] giving up on ${event.agent.id}`);
        await record({
          at: now.toISOString(),
          agentId: event.agent.id,
          title: event.agent.title,
          provider,
          outcome: "gave-up",
          detail: `${attempts} automatic continues stopped again`,
        });
        return;
      }

      const base = await dueWhen(provider, reset, transient, now);
      const due = new Date(base.getTime() + jitter());
      const baseline = (await api.agents.ref(event.agent.id).refresh().catch(() => null))?.agent?.lastUserMessageAt ?? null;

      state.jobs = [
        ...current.filter((job) => job.agentId !== event.agent.id),
        {
          agentId: event.agent.id,
          provider,
          title: event.agent.title,
          kind: "resume",
          handoffAgentId: null,
          dueAt: due.toISOString(),
          baseline,
          attempts,
          status: "pending",
          sentAt: null,
        },
      ];
      await saveJobs();
    });
  }

  /** Sends every due resume whose agent is idle and has not heard from the user since. */
  async function tick(api: EngineApi): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      if (dirty) await saveJobs();
      // The common case is an empty schedule: answer it from memory, without a settings read.
      if (!(await jobs()).some((job) => job.kind === "resume" && job.status === "pending")) return;
      const settings = await readSettings();
      if (!settings?.enabled) return;
      const now = new Date();
      await serialize(async () => {
        state.accounts = pruneAccounts(await accounts(), now);
      });

      const current = await jobs();
      const perAccount = new Map<string, number>();

      for (const job of current.filter(
        (entry) => entry.kind === "resume" && entry.status === "pending" && Date.parse(entry.dueAt) <= now.getTime(),
      )) {
        if (job.attempts >= MAX_ATTEMPTS) {
          await cancel(job.agentId);
          continue;
        }
        // A shared reset must not turn into a burst: each account sends at most N per tick.
        if ((perAccount.get(job.provider) ?? 0) >= PER_ACCOUNT_PER_TICK) continue;

        let snapshot: AgentSnapshot | null = null;
        try {
          snapshot = (await api.agents.ref(job.agentId).refresh())?.agent ?? null;
        } catch (error) {
          console.error(`[quota-relay] could not refresh ${job.agentId}`, codeOf(error));
          continue;
        }
        if (!snapshot || snapshot.archivedAt) {
          await cancel(job.agentId);
          continue;
        }
        // Someone is already working in this agent; do not interrupt or queue behind it.
        if (snapshot.status === "running") continue;
        // The user wrote to the agent after this stop, so the stop is theirs to handle.
        if (job.baseline && snapshot.lastUserMessageAt && Date.parse(snapshot.lastUserMessageAt) > Date.parse(job.baseline)) {
          await cancel(job.agentId);
          continue;
        }

        // A cancel or re-plan may have landed while this loop awaited; never send for a stale row.
        const live = (await jobs()).find(
          (entry) => entry.agentId === job.agentId && entry.dueAt === job.dueAt && entry.status === "pending",
        );
        if (!live) continue;

        try {
          await api.agents.ref(job.agentId).send(DEFAULT_PROMPT);
        } catch (error) {
          // A failed send is an attempt too, with a longer wait each time; otherwise every tick
          // would retry a broken provider.
          await serialize(async () => {
            const list = await jobs();
            const target = list.find(
              (entry) => entry.agentId === job.agentId && entry.dueAt === job.dueAt && entry.status === "pending",
            );
            if (!target) return;
            target.attempts += 1;
            target.dueAt = new Date(Date.now() + backoff(target.attempts)).toISOString();
            await saveJobs();
          });
          console.error(`[quota-relay] could not continue ${job.agentId}`, codeOf(error));
          continue;
        }

        perAccount.set(job.provider, (perAccount.get(job.provider) ?? 0) + 1);
        await serialize(async () => {
          const list = await jobs();
          const target = list.find(
            (entry) => entry.agentId === job.agentId && entry.dueAt === job.dueAt && entry.status === "pending",
          );
          if (!target) return;
          target.status = "sent";
          target.sentAt = new Date().toISOString();
          target.attempts += 1;
          await saveJobs();
          await record({
            at: target.sentAt,
            agentId: job.agentId,
            title: job.title,
            provider: job.provider,
            outcome: "resumed",
            detail: null,
          });
        });
        console.error(`[quota-relay] continued ${job.agentId}`);
      }
    } finally {
      ticking = false;
    }
  }

  async function list(): Promise<{ jobs: Job[]; accounts: Accounts; history: HistoryEntry[] }> {
    return { jobs: await jobs(), accounts: await accounts(), history: await history() };
  }

  async function cancel(agentId: string): Promise<boolean> {
    return serialize(async () => {
      const current = await jobs();
      const next = current.filter((job) => job.agentId !== agentId);
      const changed = next.length !== current.length;
      state.jobs = next;
      if (changed) await saveJobs();
      return changed;
    });
  }

  /** Sends now for a scheduled or inferred stop, after re-checking every guard a tick uses. */
  async function resumeNow(api: EngineApi, agentId: string): Promise<{ ok: boolean; error: string | null }> {
    const settings = await readSettings();
    if (!settings?.enabled) return { ok: false, error: "Automatic resumes are off" };

    const job = (await jobs()).find((entry) => entry.agentId === agentId && entry.status === "pending");
    if (!job) return { ok: false, error: "Nothing is scheduled for this agent" };

    let snapshot: AgentSnapshot | null = null;
    try {
      snapshot = (await api.agents.ref(agentId).refresh())?.agent ?? null;
    } catch {
      return { ok: false, error: "Could not read the agent" };
    }
    if (!snapshot || snapshot.archivedAt) {
      await cancel(agentId);
      return { ok: false, error: "The agent is gone" };
    }
    if (snapshot.status === "running") return { ok: false, error: "The agent is running" };
    if (job.baseline && snapshot.lastUserMessageAt && Date.parse(snapshot.lastUserMessageAt) > Date.parse(job.baseline)) {
      await cancel(agentId);
      return { ok: false, error: "You replied to this agent since the stop" };
    }

    try {
      await api.agents.ref(agentId).send(DEFAULT_PROMPT);
    } catch (error) {
      return { ok: false, error: `Could not send (${codeOf(error)})` };
    }

    await serialize(async () => {
      const list = await jobs();
      const target = list.find((entry) => entry.agentId === agentId && entry.status === "pending");
      if (!target) return;
      target.status = "sent";
      target.sentAt = new Date().toISOString();
      target.attempts += 1;
      await saveJobs();
      await record({
        at: target.sentAt,
        agentId,
        title: target.title,
        provider: target.provider,
        outcome: "resumed",
        detail: "manual",
      });
    });
    return { ok: true, error: null };
  }

  return { onTurnAfter, tick, list, cancel, resumeNow };
}
