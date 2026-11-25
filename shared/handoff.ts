import { z } from "zod";

/** One fallback target, written as `provider` or `provider/model`. */
export type FallbackTarget = { provider: string; model: string | null };

/**
 * Parses the comma-separated chain from settings. Each entry is `provider` or
 * `provider/model`; blank entries are dropped. Order is priority.
 */
export function parseChain(value: string): FallbackTarget[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const slash = part.indexOf("/");
      if (slash === -1) return { provider: part, model: null };
      return { provider: part.slice(0, slash).trim(), model: part.slice(slash + 1).trim() || null };
    })
    .filter((target) => target.provider.length > 0);
}

/**
 * The next target after the provider that just ran out, following the chain's order. When the
 * current provider is not in the chain, the chain's first entry applies. Accounts that are
 * cooling down are skipped: handing a task to an account that is still out of quota only burns
 * a turn.
 */
export function nextTarget(
  chain: FallbackTarget[],
  currentProvider: string,
  options: { cooling?: (provider: string) => boolean } = {},
): FallbackTarget | null {
  return candidateTargets(chain, currentProvider, options)[0] ?? null;
}

/** Every eligible target after the current provider, in chain order. */
export function candidateTargets(
  chain: FallbackTarget[],
  currentProvider: string,
  options: { cooling?: (provider: string) => boolean } = {},
): FallbackTarget[] {
  const index = chain.findIndex((target) => target.provider === currentProvider);
  const rest = index >= 0 ? chain.slice(index + 1) : chain;
  const cooling = options.cooling ?? (() => false);
  return rest.filter((target) => target.provider !== currentProvider && !cooling(target.provider));
}

/** Provider ids in the chain, in order, without duplicates. */
export function chainProviders(chain: FallbackTarget[]): string[] {
  return [...new Set(chain.map((target) => target.provider))];
}

/**
 * Sorts chain entries by what the daemon reports: providers it does not have, and providers it
 * has but cannot use right now. A typo would otherwise only surface when a handoff fails.
 */
export function checkChain(
  chain: FallbackTarget[],
  providers: Array<{ provider: string; available: boolean }>,
): { unknown: string[]; unavailable: string[] } {
  const known = new Map(providers.map((entry) => [entry.provider, entry.available]));
  const unknown: string[] = [];
  const unavailable: string[] = [];
  for (const provider of chainProviders(chain)) {
    const available = known.get(provider);
    if (available === undefined) unknown.push(provider);
    else if (!available) unavailable.push(provider);
  }
  return { unknown, unavailable };
}

/** `provider/model` for the Paseo agent config. */
export function targetSelector(target: FallbackTarget): string {
  return target.model ? `${target.provider}/${target.model}` : target.provider;
}

const MAX_REQUEST_CHARS = 700;
const MAX_REQUESTS = 3;
const MAX_TOTAL_REQUEST_CHARS = 2_000;
const MAX_ASSISTANT_CHARS = 1_200;
const MAX_NOTE_CHARS = 2_000;

/**
 * Credential shapes that can appear in a conversation are replaced before any excerpt leaves
 * the agent's own provider. Best effort, not a guarantee.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{8,}/g, "<redacted-key>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-key>"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <redacted-token>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted-token>"],
];

export function redact(text: string): string {
  return REDACTIONS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

const clip = (text: string, limit: number): string => {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
};

/** A title is user- or model-written text and is quoted, never trusted: one line, bounded. */
const inline = (text: string, limit: number): string => clip(text.replace(/\s+/g, " "), limit);

export interface HandoffInput {
  sourceTitle: string | null;
  sourceProvider: string;
  /** The stopped agent's working directory; the replacement starts at the workspace root. */
  sourceCwd?: string | null;
  note: string | null;
  /** The user's recent instructions, oldest first. */
  requests: string[];
  /** Where the source agent stopped, only when the user opted in. */
  lastAssistant: string | null;
  /** Files the stopped agent edited, so the replacement looks there first. */
  files?: string[];
}

/** A path under `cwd` is shown relative to it: shorter, and it names no home directory. */
function relativeTo(path: string, cwd: string | null | undefined): string {
  if (!cwd) return path;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/**
 * The first message of the replacement agent. It carries the request and, on request, the
 * stopping point — never the source conversation — and tells the model to check the working
 * tree before acting: the new agent cannot see what the old one did.
 */
/** Every handoff brief starts with this, so a later hop can tell a brief from a user request. */
export const HANDOFF_LEAD = "You are continuing work started by another agent";

/** The newest few requests, redacted and bounded in both length and count, oldest first. */
export function briefRequests(requests: string[]): string[] {
  let budget = MAX_TOTAL_REQUEST_CHARS;
  const kept: string[] = [];
  for (const text of requests.slice(-MAX_REQUESTS).reverse()) {
    const cleaned = redact(clip(text, MAX_REQUEST_CHARS));
    if (!cleaned || cleaned.length > budget) continue;
    budget -= cleaned.length;
    kept.unshift(cleaned);
  }
  return kept;
}

export function handoffPrompt(input: HandoffInput): string {
  const lines: string[] = [];
  lines.push(
    `${HANDOFF_LEAD} (${inline(input.sourceTitle ?? "untitled", 120)}) on ${input.sourceProvider}, ` +
      "which stopped because that account hit its usage limit.",
  );
  lines.push(
    "The same working directory already contains its edits and uncommitted changes. " +
      "Read the current state first (git status, git diff, and the files it touched) before continuing, " +
      "and do not redo work that is already done.",
  );
  if (input.sourceCwd) lines.push(`It was working in ${inline(input.sourceCwd, 300)}; continue from that directory.`);

  const files = (input.files ?? []).map((path) => inline(relativeTo(path, input.sourceCwd), 200)).filter(Boolean);
  if (files.length > 0) lines.push(`Files it edited:\n${files.map((path) => `- ${path}`).join("\n")}`);

  const requests = briefRequests(input.requests);

  if (requests.length === 1) {
    lines.push(`The user's request, quoted verbatim:\n${requests[0]}`);
  } else if (requests.length > 1) {
    lines.push(
      `The user's recent requests, oldest first, quoted verbatim:\n${requests
        .map((text, index) => `${index + 1}. ${text}`)
        .join("\n")}`,
    );
  }

  if (input.lastAssistant) {
    const last = redact(clip(input.lastAssistant, MAX_ASSISTANT_CHARS));
    if (last) lines.push(`Where it stopped, its last message was:\n${last}`);
  }

  if (input.note?.trim()) {
    lines.push(`Additional instructions from the user for this continuation:\n${clip(input.note.trim(), MAX_NOTE_CHARS)}`);
  }

  lines.push("Continue that task from its current state. Ask if the request is ambiguous.");
  return lines.join("\n\n");
}

export const chainSchema = z.string().max(400).default("");
