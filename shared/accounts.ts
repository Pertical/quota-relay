import type { LimitScope } from "./limit";

/**
 * One account is one Paseo provider id: `claude`, `claude-work`, `codex`, `deepseek-harness-native`.
 * A subscription's window is shared by every agent on that provider, so the cooldown belongs to
 * the account rather than to any single agent.
 */
export interface AccountState {
  /** When the account is expected to have quota again. */
  resetAt: string;
  scope?: LimitScope;
  updatedAt: string;
}

export type Accounts = Record<string, AccountState>;

/** Drops cooldowns that have already elapsed. */
export function pruneAccounts(accounts: Accounts, now: Date): Accounts {
  const next: Accounts = {};
  for (const [provider, state] of Object.entries(accounts)) {
    const at = Date.parse(state.resetAt);
    if (Number.isFinite(at) && at > now.getTime()) next[provider] = state;
  }
  return next;
}

export function recordAccount(
  accounts: Accounts,
  provider: string,
  resetAt: Date | null,
  scope: LimitScope,
  now: Date,
): Accounts {
  if (!resetAt) return accounts;
  return {
    ...accounts,
    [provider]: { resetAt: resetAt.toISOString(), scope, updatedAt: now.toISOString() },
  };
}

export function coolingUntil(accounts: Accounts, provider: string, now: Date): Date | null {
  const state = accounts[provider];
  if (!state) return null;
  const at = Date.parse(state.resetAt);
  return Number.isFinite(at) && at > now.getTime() ? new Date(at) : null;
}

export function isCooling(accounts: Accounts, provider: string, now: Date): boolean {
  return coolingUntil(accounts, provider, now) !== null;
}

/** The earliest instant any recorded account frees up, for scheduling when every account is cooling. */
export function earliestReset(accounts: Accounts, now: Date): Date | null {
  let earliest: number | null = null;
  for (const state of Object.values(accounts)) {
    const at = Date.parse(state.resetAt);
    if (Number.isFinite(at) && at > now.getTime() && (earliest === null || at < earliest)) earliest = at;
  }
  return earliest === null ? null : new Date(earliest);
}
