# Design: switching providers when a subscription runs out

## The problem

A Paseo agent is bound to one provider and one account. When that account hits its usage
limit, the work stops until the window resets. People who pay for more than one subscription
(Claude, ChatGPT/Codex, a DeepSeek account) then do by hand what a scheduler could do: notice
the stop, remember where they were, and restart the task on a provider that still has quota.

This plugin does that by hand, on the daemon side. It is a workaround for a missing Paseo
concept, and the second half of this document is the proposal for that concept.

## What the plugin does now

1. **Detect.** A turn that ends with a short, provider-worded usage-limit notice is recognised
   from the failed turn's error and the turn's own timeline items. Billing, credit and
   context-window stops are ignored, as is a notice quoted inside a blockquote or code fence.
2. **Read the reset.** ISO timestamp, epoch, `in 2 hours`, or `resets 3pm`. No reset means a
   fixed fallback delay (15 min by default).
3. **Resume or hand off.** With auto-switch off, the same agent gets one "continue" at that
   time, capped at three attempts. With auto-switch on, the plugin starts a **replacement
   agent** in the same workspace on the next provider in the configured chain, and records the
   handoff instead of scheduling a resume.

The replacement agent receives a synthesised brief: the user's recent requests, the source
agent's working directory and the files it edited (paths only), and an explicit instruction to
check `git status`/`git diff` before acting. The source agent's last message is included only
when the user opts in. A bare rate limit (a 429 with no reset) never triggers a handoff. It does not receive the source conversation, because
Paseo cannot move a provider session between agents.

## Multiple accounts

A subscription's window is shared by every agent on that account, so the plugin treats each
Paseo provider id as an account and keeps a cooldown registry: provider, reset instant, and the
scope the notice named (session, weekly, model). The registry persists across restarts because a
5-hour window outlives a reload.

That changes three decisions:

- **Resume timing.** An agent whose account is still cooling waits for that account's reset rather
  than a fixed delay. Agents sharing one reset are jittered and capped per tick, so a shared
  boundary does not turn into a burst.
- **Handoff target.** The chain walk skips cooling accounts. A ladder such as
  `claude-work → claude-personal → codex` stays useful when the first account is out.
- **Hop budget.** Lineage is a hop counter in agent metadata, not a one-hop flag, so a task may
  visit `maxHops` accounts. The default of one keeps the current safety.

What the plugin still cannot see is whether a *free* account actually has quota: a chain entry
that is not cooling may still be exhausted if its provider never printed a reset. The first
continue on that account fails and counts as an attempt.

## Why this is only a workaround

| Limit | Consequence |
| --- | --- |
| No cross-provider session transfer | The replacement cannot see prior tool results, reasoning, or files it already read. It re-derives context, so it costs more and can repeat work |
| No usage awareness | The plugin cannot verify the fallback provider has quota. It assumes, and a failed attempt burns a turn |
| Duplicate agents | The user ends up with two agent tabs for one task, one of them stopped. Paseo's lists and the worktree view show both |
| Permission and sandbox mismatch | The replacement uses that provider's defaults, not the stopped agent's mode. A stricter provider may block, a looser one may do more than intended |
| No timeline continuity | The handoff is a new conversation. The history of the task is split across two agents with no link except a plugin metadata key |
| Provider identity is a string | The chain is `provider/model` text. No validation, no discovery of which providers are installed or have quota |

## What Paseo should own

The plugin can only act after the fact, through the public SDK. Paseo has the information and
the lifecycle to do it properly.

### 1. A fallback declaration on the agent

```ts
config: {
  provider: "claude/claude-opus-5",
  fallback: [
    { provider: "codex/gpt-6-astra" },
    { provider: "deepseek-harness-native/deepseek-flash" },
  ],
}
```

The composer could offer "continue on ▾" next to the provider picker. The value is saved with
the agent, so it survives restarts and applies to every turn.

### 2. A usage-limit signal from providers

Providers already know: Claude Code prints the reset, Codex returns a wham/usage payload,
ACP agents return structured errors. Paseo should normalise this into a timeline event:

```ts
{ type: "usage_limit", provider, scope, resetAt, source: "provider" | "inferred" }
```

A plugin or the daemon can then schedule or switch without scraping assistant text, which is
what every current workaround does.

### 3. `agent.handoff` as a daemon operation

```ts
await agent.handoff({
  to: "codex/gpt-6-astra",
  carry: { transcript: "summary" | "tail", files: true, branch: true },
  cancelSource: true,
});
```

The daemon owns what the next provider needs: a transcript summary generated by the model it
already has, the list of touched files, the branch and diff stat, the permission mode. That is
strictly better than a plugin guessing from three timeline items, and it is the one place a
summary can be produced cheaply — the source provider is the one out of quota, so the summary
must come from the fallback itself, in a first turn that is cheap by construction.

### 4. Continuity in the UI

The handoff should be one task with two runtimes, not two tasks: a `handoff` row in the source
timeline that opens the replacement, the replacement's header showing "continued from …", and
the pair archived and merged together. That keeps the worktree view and the agent list honest —
today a plugin cannot do this, so the user sees a duplicate.

### 5. Usage-aware ordering

A fallback list should be evaluated against what Paseo already knows: the providers' usage
sources (`server.registerUsageSource`, Paseo 0.11+). `fallback: ["auto"]` could mean "the next
provider with quota, cheapest still-available first". The plugin cannot do that: it sees usage
only through whatever the provider prints.

## MVP for an issue

1. Normalise the usage-limit event (Claude, Codex, OpenCode first).
2. Accept `fallback` in agent config and persist it.
3. Implement `agent.handoff` with a daemon-generated brief and `cancelSource`.
4. Show the handoff as a timeline row and a banner on the replacement.
5. Defer usage-aware ordering and model-level switching (`setOptions({ model })`) to a follow-up;
   the latter already works for providers that support live model changes and preserves context,
   which is strictly cheaper than a handoff.

## Where the plugin goes from here

If Paseo ships `fallback`, this plugin should shrink to scheduling only, and drop the handoff
path. Until then the plugin keeps it opt-in, one hop, and visible: every handoff is a row the
user can dismiss, and the replacement is a normal agent they can inspect.
