/**
 * Recognising a usage-limit stop, and reading the reset instant it states.
 *
 * Deliberately conservative: a false positive sends a prompt the user did not ask for, so a
 * notice must be short, must not be a billing or context stop, must not be quoted from a
 * document or a tool result, and must match a provider wording.
 */

/** Provider notices are short; longer text that merely mentions a limit is ordinary output. */
export const NOTICE_MAX_CHARS = 400;

const LIMIT_PATTERNS = [
  /(?:you(?:'|’)?ve|you have) (?:hit|reached) your [a-z0-9 -]{0,40}limit/i,
  /(?:usage|session|weekly|daily|5-hour|five-hour|rate) limit (?:has been )?(?:reached|exceeded|hit)/i,
  /usage_limit_(?:reached|exceeded)/i,
  /rate_limit_(?:exceeded|error)/i,
  /quota (?:has been )?(?:reached|exceeded|exhausted)/i,
  /too many requests/i,
];

/** Stops that never reopen on a clock. */
const NOT_A_LIMIT = [
  /context[ _-](?:length|window)/i,
  /(?:prompt|input) is too long/i,
  /maximum context/i,
  /too many (?:input )?tokens/i,
  /insufficient[_ ]quota|credit balance|billing|payment/i,
  /credit_balance_exhausted/i,
];

/**
 * A notice quoted from a document, a tool result or an inline code span is not this turn's
 * stop. Every fence style, blockquotes, indented code and backticks count as quoting.
 */
const QUOTED = /```|~~~|^\s*>|^\s{4,}\S|`/m;

/** A reset further out than this is not a real subscription window; it is a misparse. */
export const MAX_RESET_HORIZON_MS = 7 * 24 * 3_600_000;

/** Epoch values are only believed inside a plausible range (2024-01-01 .. 2032-01-01). */
const MIN_EPOCH_MS = Date.UTC(2024, 0, 1);
const MAX_EPOCH_MS = Date.UTC(2032, 0, 1);

const UNITS: Record<string, number> = {
  second: 1_000, seconds: 1_000, sec: 1_000, secs: 1_000, s: 1_000,
  minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000,
  hour: 3_600_000, hours: 3_600_000, hr: 3_600_000, hrs: 3_600_000, h: 3_600_000,
};

export function isLimitNotice(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > NOTICE_MAX_CHARS) return false;
  if (QUOTED.test(trimmed)) return false;
  if (NOT_A_LIMIT.some((pattern) => pattern.test(trimmed))) return false;
  return LIMIT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Provider error codes that mean a renewable usage limit, not a billing or context stop. */
export const LIMIT_CODES = new Set([
  "rate_limit",
  "rate_limit_exceeded",
  "rate_limit_error",
  "usage_limit_reached",
  "usage_limit_exceeded",
]);

/**
 * A stop the provider itself reported, as opposed to prose that merely mentions a limit.
 * Only this kind is trusted to schedule or hand off without asking.
 */
export function isStructuredLimit(message: string, code?: string): boolean {
  if (code && LIMIT_CODES.has(code.toLowerCase())) return !NOT_A_LIMIT.some((pattern) => pattern.test(message));
  return isLimitNotice(message);
}

/**
 * Wording that names a subscription window or quota, as opposed to a generic HTTP 429 such as
 * `Too many requests` or `rate_limit_error`, which usually clears in seconds.
 */
const SUBSCRIPTION_PATTERNS = [
  /(?:you(?:'|’)?ve|you have) (?:hit|reached) your [a-z0-9 -]{0,40}limit/i,
  /(?:usage|session|weekly|daily|5-hour|five-hour) limit/i,
  /usage_limit_/i,
  /quota (?:has been )?(?:reached|exceeded|exhausted)/i,
];

/**
 * A limit worth switching accounts for: the notice states a reset, or names a subscription
 * window. A bare rate limit is transient and only earns a short wait on the same agent.
 */
export function isSubscriptionLimit(message: string, code?: string, reset: Date | null = null): boolean {
  if (reset) return true;
  if (code && /^usage_limit_/i.test(code)) return true;
  return SUBSCRIPTION_PATTERNS.some((pattern) => pattern.test(message));
}

/** A limit notice also tells us what ran out: session window, weekly window, or one model. */
export type LimitScope = "session" | "weekly" | "daily" | "model" | "unknown";

export function limitScope(text: string): LimitScope {
  if (/5-hour|five-hour|session|rolling/i.test(text)) return "session";
  if (/weekly/i.test(text)) return "weekly";
  if (/daily/i.test(text)) return "daily";
  if (/opus|sonnet|haiku|model/i.test(text)) return "model";
  return "unknown";
}

function positive(date: Date | null, now: Date): Date | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  // A stated instant already in the past cannot be the reset this turn is waiting for.
  return date.getTime() > now.getTime() ? date : null;
}

/** `2 hours 10 minutes`, `90 minutes`, `45s`. */
function relative(text: string, now: Date): Date | null {
  const match = /(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|seconds?|secs?|s)\b[,\s]*)+)/i.exec(text);
  if (!match) return null;
  let ms = 0;
  for (const part of match[1].matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|seconds?|secs?|s)\b/gi)) {
    const unit = UNITS[part[2].toLowerCase()];
    if (unit) ms += Number(part[1]) * unit;
  }
  return ms > 0 ? new Date(now.getTime() + ms) : null;
}

/** `2026-11-25T02:32:00Z`, `1776902400` (seconds or milliseconds). */
function absolute(text: string, now: Date): Date | null {
  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})\b/i.exec(text);
  if (iso) return new Date(iso[0]);
  const epoch = /\b(\d{10,13})\b/.exec(text);
  if (epoch) {
    const value = Number(epoch[1]);
    // A trace id or request id that happens to be 10-13 digits is not a date.
    const ms = value > 1e12 ? value : value * 1_000;
    if (ms >= MIN_EPOCH_MS && ms <= MAX_EPOCH_MS) return new Date(ms);
  }
  return null;
}

/** The IANA zone a notice names, as in `resets 3pm (Asia/Tokyo)`. */
export function statedZone(text: string): string | null {
  const match = /\(([A-Za-z][A-Za-z_+-]*(?:\/[A-Za-z][A-Za-z_+-]*)*)\)/.exec(text);
  if (!match) return null;
  const zone = match[1];
  if (!/^[A-Za-z]/.test(zone)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

function offsetMs(zone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour") % 24, value("minute"), value("second"));
  return asUtc - instant.getTime();
}

/** The wall-clock `hour:minute` on the current day in `zone`, as an instant. */
function zonedInstant(zone: string, hour: number, minute: number, now: Date): Date {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now)
    .split("-")
    .map(Number);
  const build = (dayOffset: number): Date => {
    const guess = Date.UTC(today[0], today[1] - 1, today[2] + dayOffset, hour, minute);
    let candidate = new Date(guess - offsetMs(zone, new Date(guess)));
    // The offset at the candidate can differ across a DST boundary; one refinement is enough.
    candidate = new Date(guess - offsetMs(zone, candidate));
    return candidate;
  };
  const first = build(0);
  return first.getTime() > now.getTime() ? first : build(1);
}

/**
 * `resets at 15:30`, `resets 3pm`, `resets 3pm (Asia/Tokyo)`. A named zone is honoured; without
 * one the daemon's local time applies, as before.
 */
function clock(text: string, now: Date): Date | null {
  const match =
    /(?:resets?|renews?|available again|try again)(?:\s+(?:at|on|after))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text) ??
    /(?:resets?|renews?|available again|try again)(?:\s+(?:at|on|after))?\s+(\d{1,2}):(\d{2})\b/i.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  const zone = statedZone(text);
  if (zone) {
    try {
      return zonedInstant(zone, hour, minute, now);
    } catch {
      // An unusable zone falls back to local time below.
    }
  }
  const date = new Date(now);
  date.setHours(hour, minute, 0, 0);
  if (date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);
  return date;
}

/** The instant a notice states, or null when it states none this parser understands. */
export function parseResetAt(text: string, now: Date = new Date()): Date | null {
  const parsed = positive(absolute(text, now), now) ?? positive(relative(text, now), now) ?? positive(clock(text, now), now);
  if (!parsed) return null;
  // A reset months or years away would park the account forever; treat it as no reset.
  if (parsed.getTime() - now.getTime() > MAX_RESET_HORIZON_MS) return null;
  return parsed;
}
