import assert from "node:assert/strict";
import { test } from "node:test";
import { coolingUntil, earliestReset, isCooling, pruneAccounts, recordAccount, type Accounts } from "../shared/accounts";

const now = new Date("2026-11-25T02:00:00.000Z");
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

test("recording a reset makes the account cooling until then", () => {
  const accounts = recordAccount({}, "claude-work", later(60), "session", now);
  assert.equal(isCooling(accounts, "claude-work", now), true);
  assert.equal(coolingUntil(accounts, "claude-work", now)?.toISOString(), later(60).toISOString());
  assert.equal(isCooling(accounts, "claude-personal", now), false);
});

test("a notice without a reset does not cool the account", () => {
  assert.deepEqual(recordAccount({}, "claude", null, "unknown", now), {});
});

test("elapsed cooldowns are pruned", () => {
  const accounts: Accounts = {
    old: { resetAt: new Date(now.getTime() - 60_000).toISOString(), updatedAt: now.toISOString() },
    active: { resetAt: later(30).toISOString(), updatedAt: now.toISOString() },
  };
  assert.deepEqual(Object.keys(pruneAccounts(accounts, now)), ["active"]);
});

test("the earliest reset across accounts is reported", () => {
  const accounts: Accounts = {
    a: { resetAt: later(90).toISOString(), updatedAt: now.toISOString() },
    b: { resetAt: later(20).toISOString(), updatedAt: now.toISOString() },
    c: { resetAt: new Date(now.getTime() - 1).toISOString(), updatedAt: now.toISOString() },
  };
  assert.equal(earliestReset(accounts, now)?.toISOString(), later(20).toISOString());
  assert.equal(earliestReset({}, now), null);
});
