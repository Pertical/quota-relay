# Changelog

## 0.1.0

First public release.

- Resumes an agent that stopped at a provider usage limit, at the reset time the provider stated
  (time zones honoured, up to a minute of jitter). A bare rate-limit blip waits two minutes on the
  same agent instead.
- Optionally hands the task to the next account in a configured chain, skipping accounts that are
  still out of quota. The new agent gets a redacted brief: your own requests, the folder the
  stopped agent worked in, and the files it edited (paths only).
- Optionally prefers the account with the most quota left, using Paseo's usage sources.
- Tracks which accounts are cooling and when they reset, and keeps 24 hours of outcomes, shown in
  the plugin screen.
- Leaves background helper agents alone, and resumes sub-agents without replacing them.
- Hands a stopped agent's task off at most once; a later limit on that agent waits instead.
- Hourglass plugin icon.

## Before the first public release

Development history. These iterations were numbered 0.1.0 to 0.6.1 privately; the public
version numbering restarts at 0.1.0 above.

### Icon and merge (privately numbered 0.6.1)

- Plugin icon: a 512x512 hourglass in `assets/icon.png`, set in the manifest; `assets/` ships with
  the package. The 1024px source and the alternative concepts stay in the repository only.
- Repository metadata points at `github.com/Pertical/quota-relay`.
- Merged the icon branch into the 0.6.0 line. No behaviour change.

### Pre-release audit

Fixes from a pre-release audit (privately numbered 0.6.0).

- **Timeline reads work.** Entries are read in Paseo's real `{ item, turnId }` shape. Before
  this, handoff briefs carried no request, limits reported as error items were missed, and
  confirm rows never appeared. Tests now use the real shape.
- **Rate-limit blips never switch accounts.** A bare 429 with no reset waits two minutes on the
  same agent. Only a stated reset or subscription wording ("usage limit", "5-hour limit") can
  start a handoff.
- **Briefs quote your real requests.** The plugin's own continue prompt and earlier briefs are
  skipped, and requests are carried from hop to hop in agent metadata.
- **Briefs name the working folder and the files edited** (paths only), so the new agent
  explores less.
- **Hidden helpers are left alone; sub-agents are resumed but never replaced.**
- Handoffs carry an idempotency key, so a retried hook cannot start two agents.
- One name everywhere: **Quota Relay**. Settings moved to the `quota-relay` id (version 1), so
  earlier settings reset to their defaults. Rarely used knobs (custom prompt, attempts, fallback
  delay, per-tick cap) became fixed defaults.
- Settings: switching options appear only when switching is on, hops is a picker, and the chain
  is checked against the providers on this host.
- The schedule idles cheaply: an empty schedule skips the settings read, and the sidebar polls
  every minute unless something is waiting. The sidebar and screen share one query.
- **Resume now** shows why it was refused. History says "Continue sent" instead of "resumed".

### Renamed to Quota Relay

- Renamed to **Quota Relay** (`quota-relay`). The plugin now does three things — resume, switch
  accounts, spread by headroom — so the old "resume-on-limit" name undersold it.
- State moved to `plugin-data/quota-relay/`. Renaming the plugin id is a breaking change for
  existing installs: remove and reinstall, and copy the three JSON files across if you want the
  old schedules.

### Usage-aware handoff targets

- **Usage-aware target selection.** A new *Prefer the account with the most quota left* setting
  ranks eligible handoff targets by the remaining percentage Paseo's usage sources report,
  instead of chain order. Accounts with unknown usage keep chain order and rank after known ones.
  The chain still decides who is eligible; this only reorders them. Reads are cached for a minute
  and time out after five seconds, so a slow usage source cannot hold up a handoff.
- Documented why one conversation cannot be split across two providers: an agent is bound to one
  provider, so balancing applies to which account the *next* task or handoff uses.

### Hardening after security review

Hardening pass after an independent security review.

- Only a limit the **provider reported** (failed turn with a limit error or code, or an error
  item in the turn) may schedule or hand off. A limit-looking sentence in assistant prose now
  queues a **confirmation** row instead of sending; quoted text cannot act.
- Timeline reads are scoped to one turn and filtered by `turnId`, so a stale notice cannot
  re-arm a resume.
- Ticks are single-flight; post-send updates match the exact row (`agentId + dueAt + pending`),
  so a re-planned row is never marked sent for a send that did not happen.
- A failed send backs off (already) and no longer loses history: history is loaded before append,
  and a failed jobs write is retried rather than silently diverging from memory.
- Corrupt state files are set aside as `*.corrupt-<ts>` instead of being overwritten.
- Reset instants beyond seven days, and implausible epoch numbers, are rejected.
- The handoff brief now redacts key/token shapes, caps the number and total size of excerpts,
  and never substitutes the provider notice for the user's request.
- `resume.now` re-checks enabled/archived/running/user-reply before sending, and errors are
  returned and logged as codes, never raw provider text.
- Logs contain ids and providers only. Tests moved out of the shipped directories.

### Account-aware scheduling and multi-hop handoff

**Correctness**

- A named time zone in a notice (`resets 3pm (Asia/Tokyo)`) is honoured, including the offset in
  effect at the reset across a DST boundary. Previously the zone was parsed and discarded, which
  could wake an agent an hour early or late.
- Handoff bookkeeping is serialised with the job store, so a concurrent tick or cancel can no
  longer drop the row while the replacement agent exists.
- A failed send now counts as an attempt and backs off (5, 15, 45 minutes). Before, a broken
  provider was retried every 30 seconds and never counted against the cap.
- Scheduled resumes are jittered by up to a minute, and one account may send at most
  `maxConcurrentPerAccount` continues per tick, so agents sharing a reset do not wake together.

**Accounts**

- New account cooldown registry: a limit with a known reset marks that provider as cooling until
  then, persisted across restarts.
- The fallback chain skips cooling accounts instead of handing a task to an account that is still
  out of quota.
- The hop guard is a counter in agent metadata, bounded by `maxHops`, instead of a one-hop flag.
  Multi-account ladders such as `claude-work → claude-personal → codex` now work.
- When every account is cooling, the next resume waits for the account's own reset rather than
  retrying on a fixed delay.

**Privacy**

- A handoff brief no longer copies the stopped agent's last message by default. Only your own
  requests travel to the replacement account; the model is told to inspect the working tree
  instead. An opt-in setting restores the previous behaviour.
- Provider errors are clipped before they reach the daemon log.

**Housekeeping**

- The last 24 hours of outcomes are recorded and shown in the screen.
- Sent jobs are pruned after 24 hours, and the store is capped at 100 rows.
- The screen lists cooling accounts, scheduled resumes, handoffs, and recent activity.
- Settings gained **Maximum hops** and **Resumes per account per tick**.

### Account switching

- Auto-switch: on a limit, start a replacement agent in the same workspace on the next account in
  the chain, with a brief built from the user's recent requests and the stopping point.
- Settings screen, chain configuration, extra instructions.

### First working version

- Detect usage limits, read the reset instant, resume the same agent once, with attempts capped.
