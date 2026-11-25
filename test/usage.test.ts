import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUsage, rankByHeadroom } from "../shared/usage";

const payload = {
  fetchedAt: "2026-11-25T03:00:00.000Z",
  providers: [
    { providerId: "claude", status: "available", windows: [{ id: "5h", label: "5-hour", summary: true, remainingPct: 20, resetsAt: "2026-11-25T05:00:00.000Z" }] },
    { providerId: "codex", status: "available", windows: [{ id: "5h", label: "5-hour", remainingPct: 80 }] },
    { providerId: "deepseek", status: "available", windows: [{ id: "w", label: "weekly", usedPct: 40 }] },
    { providerId: "broken", status: "error", windows: [] },
  ],
};

test("usage is read per provider from Paseo's usage sources", () => {
  const usage = parseUsage(payload);
  assert.equal(usage.get("claude")?.remainingPct, 20);
  assert.equal(usage.get("codex")?.remainingPct, 80);
  assert.equal(usage.get("deepseek")?.remainingPct, 60, "usedPct is inverted");
  assert.equal(usage.get("broken")?.remainingPct, null);
});

test("the healthiest eligible account wins, unknown usage keeps chain order", () => {
  const usage = parseUsage(payload);
  const ranked = rankByHeadroom(
    [
      { provider: "claude", model: null },
      { provider: "codex", model: null },
      { provider: "unknown", model: null },
    ],
    usage,
  );
  assert.deepEqual(ranked.map((target) => target.provider), ["codex", "claude", "unknown"]);
});

test("with no usage data the chain order is preserved", () => {
  const chain = [
    { provider: "claude-work", model: null },
    { provider: "claude-personal", model: null },
  ];
  assert.deepEqual(rankByHeadroom(chain, new Map()), chain);
});

test("a malformed payload is ignored rather than trusted", () => {
  assert.equal(parseUsage(null).size, 0);
  assert.equal(parseUsage({ providers: "nope" }).size, 0);
});
