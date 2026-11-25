import assert from "node:assert/strict";
import { test } from "node:test";
import { isLimitNotice, limitScope, parseResetAt } from "../shared/limit";

const now = new Date("2026-11-25T02:00:00.000Z");

test("a provider usage-limit notice is recognised with its relative reset", () => {
  const text = "You've hit your usage limit. Upgrade to Pro or try again in 2 hours 10 minutes.";
  assert.equal(isLimitNotice(text), true);
  assert.equal(parseResetAt(text, now)?.toISOString(), "2026-11-25T04:10:00.000Z");
});

test("a quoted notice is not this turn's stop", () => {
  for (const text of [
    "> You've hit your usage limit. Try again in 2 hours.",
    "The message reads:\n```\nYou've hit your usage limit. Try again in 2 hours.\n```",
  ]) {
    assert.equal(isLimitNotice(text), false, text);
  }
});

test("billing, credit and context stops never renew on a clock", () => {
  for (const text of [
    "You've hit your usage limit. Check your billing settings.",
    "insufficient_quota: credit balance is too low",
    "Your prompt is too long for the context window",
  ]) {
    assert.equal(isLimitNotice(text), false, text);
  }
});

test("absolute resets parse, past ones do not", () => {
  assert.equal(
    parseResetAt("rate limit exceeded, retry after 2026-11-25T03:00:00Z", now)?.toISOString(),
    "2026-11-25T03:00:00.000Z",
  );
  assert.equal(parseResetAt("rate limit exceeded since 2026-11-24T03:00:00Z", now), null);
});

test("a clock reset is the next such local time", () => {
  const reset = parseResetAt("You've reached your session limit · resets 3pm", now);
  assert.ok(reset);
  assert.ok(reset.getTime() > now.getTime());
  assert.equal(reset.getHours(), 15);
});

test("a limit without a reset still counts, with no instant", () => {
  assert.equal(isLimitNotice("Too many requests."), true);
  assert.equal(parseResetAt("Too many requests.", now), null);
});

test("ordinary long output that mentions a limit is not a notice", () => {
  assert.equal(isLimitNotice(`Teammates often ask what a usage limit is. ${"Context. ".repeat(60)}`), false);
});

test("a named zone in the notice is honoured, not the daemon's local time", () => {
  // 02:00Z is 11:00 in Tokyo. 3pm Tokyo is 06:00Z, not 3pm in the daemon's zone.
  assert.equal(
    parseResetAt("You've hit your limit · resets 3pm (Asia/Tokyo)", now)?.toISOString(),
    "2026-11-25T06:00:00.000Z",
  );
});

test("a zone that crosses DST uses the offset in effect at the reset", () => {
  // 2026-03-08 is the US spring-forward day: 3pm New York is 19:00Z (EDT), not 20:00Z (EST).
  const beforeDst = new Date("2026-03-08T12:00:00.000Z");
  assert.equal(
    parseResetAt("You've hit your limit · resets 3pm (America/New_York)", beforeDst)?.toISOString(),
    "2026-03-08T19:00:00.000Z",
  );
});

test("an unusable zone falls back to local time", () => {
  const reset = parseResetAt("rate limit · resets 3pm (Nowhere/Land)", now);
  assert.ok(reset);
  assert.equal(reset.getHours(), 15);
});

test("the limit scope is read from the notice", () => {
  assert.equal(limitScope("You've hit your 5-hour limit"), "session");
  assert.equal(limitScope("Your weekly limit has been reached"), "weekly");
  assert.equal(limitScope("You've hit your Opus limit"), "model");
  assert.equal(limitScope("Too many requests"), "unknown");
});

test("a reset beyond the horizon is not believed", () => {
  assert.equal(parseResetAt("resets at 2099-01-01T00:00:00Z", now), null);
});

test("a long number that is not an epoch is not a date", () => {
  assert.equal(parseResetAt("request 123456789012 failed", now), null);
});

test("inline code and tilde fences are treated as quoting", () => {
  assert.equal(isLimitNotice("The docs say `You've hit your usage limit. Try again in 2 hours.`"), false);
  assert.equal(isLimitNotice("~~~\nYou've hit your usage limit. Try again in 2 hours.\n~~~"), false);
});
