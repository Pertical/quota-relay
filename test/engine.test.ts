import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createEngine, type EngineApi, type Settings } from "../server/engine";
import { readJobs, writeJobs, type Job } from "../server/jobs";

/** A timeline entry in the shape Paseo sends: the item nested under `item`, the turn beside it. */
const entry = (item: Record<string, unknown>, turnId?: string) => ({ provider: "claude", turnId, item, timestamp: "", seqStart: 0, seqEnd: 0 });

const dir = mkdtempSync(join(tmpdir(), "quota-relay-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const settings = (over: Partial<Settings> = {}): Settings => ({
  enabled: true,
  autoSwitch: false,
  fallbackChain: "",
  handoffNote: null,
  maxHops: 1,
  handoffIncludeLastMessage: false,
  rebalance: false,
  ...over,
});

const job = (over: Partial<Job> = {}): Job => ({
  agentId: "agent-1",
  provider: "claude",
  title: "Fix the tests",
  kind: "resume",
  handoffAgentId: null,
  dueAt: new Date(Date.now() - 60_000).toISOString(),
  baseline: "2026-11-25T01:00:00.000Z",
  attempts: 0,
  status: "pending",
  sentAt: null,
  ...over,
});

function api(snapshot: Record<string, unknown>, sent: string[]): EngineApi {
  return {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: snapshot }),
        send: async (text: string) => {
          sent.push(text);
        },
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
  };
}

async function engineAt(path: string, value: Settings, snapshot: Record<string, unknown>, sent: string[]) {
  const engine = createEngine(async () => value, { jobs: path, accounts: `${path}.accounts`, history: `${path}.history` });
  return { engine, target: api(snapshot, sent) };
}

test("a due resume is sent once to an idle agent", async () => {
  const path = join(dir, "due.json");
  await writeJobs([job()], path);
  const sent: string[] = [];
  const { engine, target } = await engineAt(path, settings(), { status: "idle", lastUserMessageAt: "2026-11-25T01:00:00.000Z" }, sent);

  await engine.tick(target);

  assert.equal(sent.length, 1);
  const [stored] = await readJobs(path);
  assert.equal(stored.status, "sent");
  assert.equal(stored.attempts, 1);
});

test("a running agent is left alone", async () => {
  const path = join(dir, "running.json");
  await writeJobs([job()], path);
  const sent: string[] = [];
  const { engine, target } = await engineAt(path, settings(), { status: "running", lastUserMessageAt: null }, sent);

  await engine.tick(target);

  assert.equal(sent.length, 0);
  assert.equal((await readJobs(path))[0].status, "pending");
});

test("a message from the user cancels the resume", async () => {
  const path = join(dir, "user.json");
  await writeJobs([job()], path);
  const sent: string[] = [];
  const { engine, target } = await engineAt(path, settings(), { status: "idle", lastUserMessageAt: "2026-11-25T02:00:00.000Z" }, sent);

  await engine.tick(target);

  assert.equal(sent.length, 0);
  assert.equal((await readJobs(path)).length, 0);
});

test("the attempt cap stops a limit that keeps reopening", async () => {
  const path = join(dir, "cap.json");
  await writeJobs([job({ attempts: 3 })], path);
  const sent: string[] = [];
  const { engine, target } = await engineAt(path, settings(), { status: "idle", lastUserMessageAt: null }, sent);

  await engine.tick(target);

  assert.equal(sent.length, 0);
  assert.equal((await readJobs(path)).length, 0);
});

test("a disabled plugin sends nothing", async () => {
  const path = join(dir, "off.json");
  await writeJobs([job()], path);
  const sent: string[] = [];
  const { engine, target } = await engineAt(path, settings({ enabled: false }), { status: "idle", lastUserMessageAt: null }, sent);

  await engine.tick(target);

  assert.equal(sent.length, 0);
});

test("auto-switch hands the task to the next provider instead of waiting", async () => {
  const path = join(dir, "handoff.json");
  const created: Array<{ config: { provider: string }; prompt: string; title?: string; metadata?: Record<string, unknown> }> = [];
  const sent: string[] = [];
  const api: EngineApi = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "error", lastUserMessageAt: null } }),
        send: async (text: string) => {
          sent.push(text);
        },
        timeline: {
          refetch: async () => ({
            entries: [
              entry({ type: "user_message", text: "Fix the failing tests in packages/api" }),
              entry({ type: "assistant_message", text: "I updated the parser; next I will run the suite." }),
            ],
          }),
        },
      }),
    },
    workspaces: {
      ref: () => ({
        agents: {
          create: async (options) => {
            created.push(options);
            return { id: "agent-new" };
          },
        },
      }),
    },
  };
  const engine = createEngine(
    async () => settings({
      autoSwitch: true,
      fallbackChain: "codex/gpt-6-astra, deepseek-harness-native",
      handoffIncludeLastMessage: true,
    }),
    { jobs: path, accounts: `${path}.accounts`, history: `${path}.history` },
  );

  await engine.onTurnAfter(api, {
    agent: { id: "agent-1", provider: "claude", title: "Fix the tests", workspaceId: "wks-1", metadata: {} },
    turnId: "turn-1",
    outcome: { kind: "failed", error: { message: "You've hit your usage limit. Try again in 3 hours." } },
  });

  assert.equal(sent.length, 0);
  assert.equal(created.length, 1);
  assert.equal(created[0].config.provider, "codex/gpt-6-astra");
  assert.match(created[0].prompt, /Fix the failing tests in packages\/api/);
  assert.match(created[0].prompt, /run the suite/);
  assert.equal(created[0].metadata?.["quota-relay.origin"], "agent-1");
  assert.equal(created[0].metadata?.["quota-relay.hop"], 1);

  const [stored] = await readJobs(path);
  assert.equal(stored.kind, "handoff");
  assert.equal(stored.handoffAgentId, "agent-new");
});

test("an agent at the hop limit is not handed off again", async () => {
  const path = join(dir, "handoff-once.json");
  const created: string[] = [];
  const api: EngineApi = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "error", lastUserMessageAt: null } }),
        send: async () => {},
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
    workspaces: {
      ref: () => ({
        agents: {
          create: async (options) => {
            created.push(options.config.provider);
            return { id: "agent-newer" };
          },
        },
      }),
    },
  };
  const engine = createEngine(
    async () => settings({ autoSwitch: true, fallbackChain: "codex/gpt-6-astra" }),
    { jobs: path, accounts: `${path}.accounts`, history: `${path}.history` },
  );

  await engine.onTurnAfter(api, {
    agent: {
      id: "agent-2",
      provider: "claude",
      title: "already handed off",
      workspaceId: "wks-1",
      metadata: { "quota-relay.origin": "agent-1", "quota-relay.hop": 1 },
    },
    turnId: "turn-2",
    outcome: { kind: "failed", error: { message: "You've hit your usage limit. Try again in 3 hours." } },
  });

  assert.equal(created.length, 0);
  const [stored] = await readJobs(path);
  assert.equal(stored.kind, "resume");
  assert.equal(stored.status, "pending");
});

test("with maxHops 2 a second account can take over from the first fallback", async () => {
  const path = join(dir, "hop2.json");
  const created: string[] = [];
  const api: EngineApi = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "error", lastUserMessageAt: null } }),
        send: async () => {},
        timeline: { refetch: async () => ({ entries: [entry({ type: "user_message", text: "Keep going" })] }) },
      }),
    },
    workspaces: {
      ref: () => ({
        agents: {
          create: async (options) => {
            created.push(options.config.provider);
            return { id: "agent-hop2" };
          },
        },
      }),
    },
  };
  const engine = createEngine(
    async () => settings({ autoSwitch: true, maxHops: 2, fallbackChain: "claude, codex/gpt-6-astra, deepseek-harness-native" }),
    { jobs: path, accounts: `${path}.accounts`, history: `${path}.history` },
  );

  await engine.onTurnAfter(api, {
    agent: {
      id: "agent-work",
      provider: "claude-work",
      title: "Task",
      workspaceId: "wks-1",
      metadata: { "quota-relay.origin": "agent-root", "quota-relay.hop": 1 },
    },
    turnId: "turn-3",
    outcome: { kind: "failed", error: { message: "You've hit your usage limit. Try again in 3 hours." } },
  });

  // claude is first in the chain, so the first free entry after claude-work is claude itself.
  assert.deepEqual(created, ["claude"]);
});

test("a cooling account is skipped by the chain", async () => {
  const path = join(dir, "cooling.json");
  const created: string[] = [];
  const api: EngineApi = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "error", lastUserMessageAt: null } }),
        send: async () => {},
        timeline: { refetch: async () => ({ entries: [entry({ type: "user_message", text: "Keep going" })] }) },
      }),
    },
    workspaces: {
      ref: () => ({
        agents: {
          create: async (options) => {
            created.push(options.config.provider);
            return { id: "agent-next" };
          },
        },
      }),
    },
  };
  const engine = createEngine(
    async () => settings({ autoSwitch: true, fallbackChain: "claude-work, claude-personal, codex" }),
    { jobs: path, accounts: `${path}.accounts`, history: `${path}.history` },
  );

  for (const provider of ["claude-work", "claude-personal"]) {
    await engine.onTurnAfter(api, {
      agent: { id: `agent-${provider}`, provider, title: provider, workspaceId: "wks-1", metadata: {} },
      turnId: `turn-${provider}`,
      outcome: { kind: "failed", error: { message: "You've hit your usage limit. Try again in 3 hours." } },
    });
  }

  // claude-work and claude-personal are both recorded as cooling, so codex takes the second task.
  assert.ok(created.includes("codex"), `created: ${created.join(", ")}`);
});

test("a failed send counts as an attempt and backs off instead of retrying every tick", async () => {
  const path = join(dir, "backoff.json");
  await writeJobs([job()], path);
  let attempts = 0;
  const api: EngineApi = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "idle", lastUserMessageAt: null } }),
        send: async () => {
          attempts += 1;
          throw new Error("provider unavailable");
        },
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
  };
  const engine = createEngine(async () => settings(), {
    jobs: path,
    accounts: `${path}.accounts`,
    history: `${path}.history`,
  });

  await engine.tick(api);
  const [afterFirst] = await readJobs(path);
  assert.equal(attempts, 1);
  assert.equal(afterFirst.attempts, 1);
  const wait = Date.parse(afterFirst.dueAt) - Date.now();
  assert.ok(wait > 4 * 60_000 && wait < 6 * 60_000, `waited ${wait}ms`);

  // The job is no longer due, so the next tick does not send again.
  await engine.tick(api);
  assert.equal(attempts, 1);
});

test("one account sends at most two resumes per tick", async () => {
  const path = join(dir, "cap.json");
  const sent: string[] = [];
  const jobs = [1, 2, 3].map((n) => job({ agentId: `agent-${n}` }));
  await writeJobs(jobs, path);
  const api: EngineApi = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: { status: "idle", lastUserMessageAt: null } }),
        send: async () => {
          sent.push(id);
        },
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
  };
  const engine = createEngine(async () => settings(), {
    jobs: path,
    accounts: `${path}.accounts`,
    history: `${path}.history`,
  });

  await engine.tick(api);
  assert.equal(sent.length, 2);
  const stored = await readJobs(path);
  assert.equal(stored.filter((entry) => entry.status === "pending").length, 1);
});

test("a reset is scheduled at the stated time plus jitter, and records the account", async () => {
  const path = join(dir, "jitter.json");
  const resetIso = new Date(Date.now() + 90 * 60_000).toISOString();
  const api: EngineApi = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "error", lastUserMessageAt: null } }),
        send: async () => {},
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
  };
  const engine = createEngine(async () => settings(), {
    jobs: path,
    accounts: `${path}.accounts`,
    history: `${path}.history`,
  });

  await engine.onTurnAfter(api, {
    agent: { id: "agent-jitter", provider: "claude-work", title: "Task", workspaceId: "wks-1", metadata: {} },
    turnId: "turn-jitter",
    outcome: { kind: "failed", error: { message: `rate limit exceeded. Resets at ${resetIso}` } },
  });

  const [stored] = await readJobs(path);
  const due = Date.parse(stored.dueAt) - Date.parse(resetIso);
  assert.ok(due >= 0 && due <= 60_000, `jitter ${due}ms`);
  assert.equal(stored.status, "pending");

  const accounts = JSON.parse(await (await import("node:fs/promises")).readFile(`${path}.accounts`, "utf8"));
  assert.equal(accounts.accounts["claude-work"].resetAt, resetIso);
});

test("by default the brief carries the user's request but not the agent's output", async () => {
  const path = join(dir, "private.json");
  const created: Array<{ prompt: string }> = [];
  const api: EngineApi = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "error", lastUserMessageAt: null } }),
        send: async () => {},
        timeline: {
          refetch: async () => ({
            entries: [
              entry({ type: "user_message", text: "Rotate the deploy key in infra/keys" }),
              entry({ type: "assistant_message", text: "The old key is sk-live-abc123; I will rotate it next." }),
            ],
          }),
        },
      }),
    },
    workspaces: {
      ref: () => ({
        agents: {
          create: async (options) => {
            created.push(options);
            return { id: "agent-private" };
          },
        },
      }),
    },
  };
  const engine = createEngine(
    async () => settings({ autoSwitch: true, fallbackChain: "codex/gpt-6-astra" }),
    { jobs: path, accounts: `${path}.accounts`, history: `${path}.history` },
  );

  await engine.onTurnAfter(api, {
    agent: { id: "agent-p", provider: "claude", title: "Rotate keys", workspaceId: "wks-1", metadata: {} },
    turnId: "turn-p",
    outcome: { kind: "failed", error: { message: "You've hit your usage limit. Try again in 3 hours." } },
  });

  assert.equal(created.length, 1);
  assert.match(created[0].prompt, /Rotate the deploy key/);
  assert.doesNotMatch(created[0].prompt, /sk-live-abc123/, "agent output must not be copied to the new provider");
});

const fakeApi = (options: {
  snapshot?: Record<string, unknown>;
  entries?: unknown[];
  sent?: string[];
  created?: string[];
}): EngineApi => ({
  agents: {
    ref: () => ({
      refresh: async () => ({ agent: options.snapshot ?? { status: "idle", lastUserMessageAt: null } }),
      send: async (text: string) => {
        options.sent?.push(text);
      },
      timeline: { refetch: async () => ({ entries: options.entries ?? [] }) },
    }),
  },
  workspaces: {
    ref: () => ({
      agents: {
        create: async (opts) => {
          options.created?.push(opts.config.provider);
          return { id: "agent-created" };
        },
      },
    }),
  },
});

test("limit-like prose in an assistant message only queues a confirmation", async () => {
  const path = join(dir, "heuristic.json");
  const sent: string[] = [];
  const created: string[] = [];
  const api = fakeApi({
    entries: [entry({ type: "assistant_message", text: "I read the README, which said: You've hit your usage limit. Try again in 2 hours." })],
    sent,
    created,
  });
  const engine = createEngine(
    async () => settings({ autoSwitch: true, fallbackChain: "codex" }),
    { jobs: path, accounts: `${path}.accounts`, history: `${path}.history` },
  );

  await engine.onTurnAfter(api, {
    agent: { id: "agent-h", provider: "claude", title: "Read docs", workspaceId: "wks-1", metadata: {} },
    turnId: "turn-h",
    outcome: { kind: "completed" },
  });

  const [stored] = await readJobs(path);
  assert.equal(stored.kind, "confirm");
  assert.equal(stored.status, "pending");
  assert.equal(sent.length, 0, "prose must not send");
  assert.equal(created.length, 0, "prose must not create agents");
});

test("timeline entries from another turn are ignored", async () => {
  const path = join(dir, "stale.json");
  const api = fakeApi({
    entries: [entry({ type: "assistant_message", text: "You've hit your usage limit. Try again in 2 hours." }, "old-turn")],
  });
  const engine = createEngine(async () => settings(), {
    jobs: path,
    accounts: `${path}.accounts`,
    history: `${path}.history`,
  });

  await engine.onTurnAfter(api, {
    agent: { id: "agent-s", provider: "claude", title: "Stale", workspaceId: "wks-1", metadata: {} },
    turnId: "current-turn",
    outcome: { kind: "completed" },
  });

  assert.deepEqual(await readJobs(path), []);
});

test("two concurrent ticks send once", async () => {
  const path = join(dir, "single.json");
  await writeJobs([job()], path);
  const sent: string[] = [];
  const api = fakeApi({ sent });
  const engine = createEngine(async () => settings(), {
    jobs: path,
    accounts: `${path}.accounts`,
    history: `${path}.history`,
  });

  await Promise.all([engine.tick(api), engine.tick(api)]);
  assert.equal(sent.length, 1);
});

test("resume now refuses a running agent", async () => {
  const path = join(dir, "running-now.json");
  await writeJobs([job()], path);
  const sent: string[] = [];
  const api = fakeApi({ snapshot: { status: "running", lastUserMessageAt: null }, sent });
  const engine = createEngine(async () => settings(), {
    jobs: path,
    accounts: `${path}.accounts`,
    history: `${path}.history`,
  });

  const result = await engine.resumeNow(api, "agent-1");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /running/);
  assert.equal(sent.length, 0);
});

test("rebalance sends the task to the account with the most quota left", async () => {
  const path = join(dir, "rebalance.json");
  const created: string[] = [];
  const api: EngineApi = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "error", lastUserMessageAt: null } }),
        send: async () => {},
        timeline: { refetch: async () => ({ entries: [entry({ type: "user_message", text: "Keep going" })] }) },
      }),
    },
    providers: {
      listUsage: async () => ({
        providers: [
          { providerId: "claude-personal", status: "available", windows: [{ remainingPct: 35 }] },
          { providerId: "codex", status: "available", windows: [{ remainingPct: 90 }] },
        ],
      }),
    },
    workspaces: {
      ref: () => ({
        agents: {
          create: async (options) => {
            created.push(options.config.provider);
            return { id: "agent-balanced" };
          },
        },
      }),
    },
  };
  const engine = createEngine(
    async () => settings({ autoSwitch: true, rebalance: true, fallbackChain: "claude-work, claude-personal, codex" }),
    { jobs: path, accounts: `${path}.accounts`, history: `${path}.history` },
  );

  await engine.onTurnAfter(api, {
    agent: { id: "agent-r", provider: "claude-work", title: "Task", workspaceId: "wks-1", metadata: {} },
    turnId: "turn-r",
    outcome: { kind: "failed", error: { message: "You've hit your usage limit. Try again in 3 hours." } },
  });

  assert.deepEqual(created, ["codex"], "codex has the most headroom");
});
