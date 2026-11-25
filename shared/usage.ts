import type { FallbackTarget } from "./handoff";

/** What one account's usage sources say about the headroom it has left. */
export interface UsageInfo {
  /** 0..100 when the provider reports a percentage, otherwise null. */
  remainingPct: number | null;
  /** When the current window resets, when reported. */
  resetsAt: string | null;
}

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Reads `providers.listUsage()` into one entry per provider. Paseo's usage sources fill these
 * windows; this plugin never contacts a provider itself.
 */
export function parseUsage(payload: unknown): Map<string, UsageInfo> {
  const usage = new Map<string, UsageInfo>();
  const providers = record(payload)?.providers;
  if (!Array.isArray(providers)) return usage;

  for (const entry of providers) {
    const provider = record(entry);
    const id = typeof provider?.providerId === "string" ? provider.providerId : null;
    if (!id) continue;

    const windows = Array.isArray(provider?.windows) ? provider.windows.map(record).filter((w): w is Json => w !== null) : [];
    // The summary window is the one the usage panel pins; otherwise take the healthiest window.
    const summary = windows.find((window) => window.summary === true) ?? null;
    const withPct = windows.filter((window) => num(window.remainingPct) !== null || num(window.usedPct) !== null);
    const best = summary ?? withPct.sort((a, b) => remainingOf(b) - remainingOf(a))[0] ?? null;

    const remaining = best ? remainingOf(best) : null;
    const resetsAt = typeof best?.resetsAt === "string" ? best.resetsAt : null;
    usage.set(id, { remainingPct: remaining, resetsAt });
  }
  return usage;
}

function remainingOf(window: Json): number {
  const remaining = num(window.remainingPct);
  if (remaining !== null) return Math.min(100, Math.max(0, remaining));
  const used = num(window.usedPct);
  return used === null ? -1 : Math.min(100, Math.max(0, 100 - used));
}

/**
 * Orders eligible accounts by headroom, healthiest first. Accounts whose usage is unknown keep
 * their chain order and sit after the known ones: a guess is worse than a stated number.
 */
export function rankByHeadroom(candidates: FallbackTarget[], usage: Map<string, UsageInfo>): FallbackTarget[] {
  return candidates
    .map((target, index) => ({ target, index, headroom: usage.get(target.provider)?.remainingPct ?? null }))
    .sort((a, b) => {
      if (a.headroom === null && b.headroom === null) return a.index - b.index;
      if (a.headroom === null) return 1;
      if (b.headroom === null) return -1;
      return b.headroom - a.headroom || a.index - b.index;
    })
    .map((entry) => entry.target);
}

/** A provider whose reported window still has meaningful room. */
export function hasHeadroom(usage: Map<string, UsageInfo>, provider: string, minimumPct = 1): boolean {
  const info = usage.get(provider);
  if (!info || info.remainingPct === null) return true;
  return info.remainingPct >= minimumPct;
}
