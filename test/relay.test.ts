import assert from "node:assert/strict";
import { cancelRpc, checkChainRpc, listRpc, resumeNowRpc } from "../shared/rpc";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createEngine, REQUESTS_KEY, type EngineApi, type Settings, type TurnEvent } from "../server/engine";
import { readJobs } from "../server/jobs";
import { checkChain, parseChain } from "../shared/handoff";
import { isSubscriptionLimit } from "../shared/limit";
import { DEFAULT_PROMPT } from "../shared/settings";

const dir = mkdtempSync(join(tmpdir(), "quota-relay-relay-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const settings: Settings = {
  enabled: true,
  autoSwitch: true,
  fallbackChain: "claude, codex",
  rebalance: false,
  maxHops: 2,
  handoffNote: null,
  handoffIncludeLastMessage: false,
};

/** A timeline entry exactly as Paseo sends it. */
const entry = (item: Record<string, unknown>, turnId = "turn-1") => ({ provider: "claude", turnId, item, timestamp: "", seqStart: 0, seqEnd: 0 });

const LIMIT = { kind: "failed", error: { message: "You've hit your usage limit. Try again in 3 hours." } } as const;

let counter = 0;
async function run(entries: unknown[], outcome: TurnEvent["outcome"], agent: Partial<TurnEvent["agent"]> = {}) {
  const path = join(dir, `job-${counter++}.json`);
  const created: Array<{ prompt: string; metadata?: Record<string, unknown>; idempotencyKey?: string }> = [];
  const api: EngineApi = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "idle", lastUserMessageAt: null } }),
        send: async () => {},
        timeline: { refetch: async () => ({ entries }) },
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
  const engine = createEngine(async () => settings, { jobs: path, accounts: `${path}.a`, history: `${path}.h` });
  await engine.onTurnAfter(api, {
    agent: { id: "agent-1", provider: "claude", title: "Task", workspaceId: "wks", cwd: "/repo/packages/api", metadata: {}, ...agent },
    turnId: "turn-1",
    outcome,
  });
  return { created, jobs: await readJobs(path) };
}

test("the brief carries the user's request from Paseo's real timeline shape", async () => {
  const { created } = await run([entry({ type: "user_message", text: "Refactor the auth module." })], LIMIT);
  assert.equal(created.length, 1);
  assert.match(created[0].prompt, /Refactor the auth module\./);
});

test("a limit reported only as an error item in the turn is detected", async () => {
  const { created } = await run([entry({ type: "error", message: "You've hit your usage limit. Try again in 3 hours." })], { kind: "completed" });
  assert.equal(created.length, 1);
});

test("a transient 429 waits briefly on the same agent instead of switching", async () => {
  const before = Date.now();
  const { created, jobs } = await run([], { kind: "failed", error: { message: "429 Too Many Requests", code: "rate_limit_error" } });
  assert.equal(created.length, 0, "no new agent for a rate-limit blip");
  assert.equal(jobs[0]?.kind, "resume");
  const wait = Date.parse(jobs[0].dueAt) - before;
  assert.ok(wait < 4 * 60_000, `waited ${wait}ms`);
});

test("the plugin's own continue prompt is never quoted as the user's request", async () => {
  const { created } = await run(
    [
      entry({ type: "user_message", text: "Refactor the auth module." }, "turn-0"),
      entry({ type: "user_message", text: DEFAULT_PROMPT }),
    ],
    LIMIT,
  );
  assert.match(created[0].prompt, /Refactor the auth module\./);
  assert.doesNotMatch(created[0].prompt, /Continue the unfinished work/);
});

test("a second hop passes on the requests the first brief carried", async () => {
  const brief = "You are continuing work started by another agent (Task) on claude, which stopped...";
  const { created } = await run([entry({ type: "user_message", text: brief })], LIMIT, {
    provider: "codex",
    metadata: { "quota-relay.hop": 1, [REQUESTS_KEY]: ["Refactor the auth module."] },
  });
  assert.equal(created.length, 0, "codex is last in the chain");
  const second = await run([entry({ type: "user_message", text: brief })], LIMIT, {
    metadata: { "quota-relay.hop": 1, [REQUESTS_KEY]: ["Refactor the auth module."] },
  });
  assert.match(second.created[0].prompt, /Refactor the auth module\./);
  assert.doesNotMatch(second.created[0].prompt, /You are continuing work started by another agent \(Task\) on claude, which stopped\.\.\./);
});

test("the brief names the working directory and the files edited, relative to it", async () => {
  const { created } = await run(
    [
      entry({ type: "user_message", text: "Fix the parser." }),
      entry({ type: "tool_call", detail: { type: "edit", filePath: "/repo/packages/api/src/parser.ts" } }),
      entry({ type: "tool_call", detail: { type: "read", filePath: "/repo/packages/api/README.md" } }),
    ],
    LIMIT,
  );
  assert.match(created[0].prompt, /working in \/repo\/packages\/api/);
  assert.match(created[0].prompt, /- src\/parser\.ts/);
  assert.doesNotMatch(created[0].prompt, /README/, "files only read are not listed");
});

test("a handoff carries an idempotency key for the stop", async () => {
  const { created } = await run([], LIMIT);
  assert.equal(created[0].idempotencyKey, "quota-relay:agent-1:turn-1");
});

test("a background helper is left alone", async () => {
  const { created, jobs } = await run([], LIMIT, { background: true });
  assert.equal(created.length, 0);
  assert.deepEqual(jobs, []);
});

test("a sub-agent is resumed in place, never replaced", async () => {
  const { created, jobs } = await run([], LIMIT, { parentAgentId: "agent-parent" });
  assert.equal(created.length, 0);
  assert.equal(jobs[0]?.kind, "resume");
});

test("subscription limits are told apart from rate-limit blips", () => {
  assert.equal(isSubscriptionLimit("429 Too Many Requests", "rate_limit_error"), false);
  assert.equal(isSubscriptionLimit("Rate limit reached for requests"), false);
  assert.equal(isSubscriptionLimit("You've hit your usage limit."), true);
  assert.equal(isSubscriptionLimit("5-hour limit reached"), true);
  assert.equal(isSubscriptionLimit("anything", "usage_limit_reached"), true);
  assert.equal(isSubscriptionLimit("Too many requests", undefined, new Date()), true, "a stated reset is a window");
});

test("chain entries are checked against the daemon's providers", () => {
  const result = checkChain(parseChain("claude, codx, codex/gpt, deepseek"), [
    { provider: "claude", available: true },
    { provider: "codex", available: true },
    { provider: "deepseek", available: false },
  ]);
  assert.deepEqual(result, { unknown: ["codx"], unavailable: ["deepseek"] });
});


test("every RPC name is valid for Paseo (lowercase, digits, dot, dash, underscore)", () => {
  // Paseo's SDK rejects a contract whose name contains an uppercase letter at load time, which
  // takes the whole plugin down. This is cheaper than discovering it from a failed load.
  for (const contract of [listRpc, cancelRpc, resumeNowRpc, checkChainRpc]) {
    assert.match(contract.name, /^[a-z][a-z0-9._-]*$/, contract.name);
  }
});

test("an agent that already handed off waits instead of starting a second replacement", async () => {
  const path = join(dir, "twice.json");
  const { writeJobs } = await import("../server/jobs");
  const now = new Date().toISOString();
  await writeJobs(
    [{ agentId: "agent-1", provider: "claude", title: "Task", kind: "handoff", handoffAgentId: "agent-new", dueAt: now, baseline: null, attempts: 1, status: "sent", sentAt: now }],
    path,
  );
  let created = 0;
  const api: EngineApi = {
    agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", lastUserMessageAt: null } }), send: async () => {}, timeline: { refetch: async () => ({ entries: [] }) } }) },
    workspaces: { ref: () => ({ agents: { create: async () => { created += 1; return { id: "agent-other" }; } } }) },
  };
  const engine = createEngine(async () => settings, { jobs: path, accounts: `${path}.a`, history: `${path}.h` });
  await engine.onTurnAfter(api, { agent: { id: "agent-1", provider: "claude", title: "Task", workspaceId: "wks", metadata: {} }, turnId: "turn-9", outcome: LIMIT });
  assert.equal(created, 0);
  assert.equal((await readJobs(path)).find((job) => job.agentId === "agent-1")?.kind, "resume");
});

test("without a stated reset, another account's cooldown does not time this resume", async () => {
  const path = join(dir, "other-reset.json");
  const { writeAccounts } = await import("../server/accounts-store");
  await writeAccounts({ codex: { resetAt: new Date(Date.now() + 4 * 3_600_000).toISOString(), updatedAt: new Date().toISOString() } }, `${path}.a`);
  const api: EngineApi = {
    agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", lastUserMessageAt: null } }), send: async () => {}, timeline: { refetch: async () => ({ entries: [] }) } }) },
  };
  const engine = createEngine(async () => ({ ...settings, autoSwitch: false }), { jobs: path, accounts: `${path}.a`, history: `${path}.h` });
  const before = Date.now();
  await engine.onTurnAfter(api, {
    agent: { id: "agent-1", provider: "claude", title: "Task", workspaceId: "wks", metadata: {} },
    turnId: "turn-1",
    outcome: { kind: "failed", error: { message: "You've hit your usage limit." } },
  });
  const wait = Date.parse((await readJobs(path))[0].dueAt) - before;
  assert.ok(wait < 20 * 60_000, `waited ${Math.round(wait / 60_000)} minutes, expected the 15-minute fallback`);
});
