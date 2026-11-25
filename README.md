# Quota Relay

A [Paseo](https://paseo.sh) plugin that keeps work moving when a subscription runs out. When an
agent stops at a usage limit, Quota Relay continues the same agent after the reset. If you have
another account with quota left, it can move the task there straight away instead.

It reads no credentials, makes no network calls and runs no processes. It reads the agent
timeline Paseo already has, waits, and asks Paseo to send a message.

## Install

```bash
paseo plugin install github:Pertical/quota-relay
```

Requires Paseo 0.17 or newer, with plugins enabled in **Settings → Plugins**.

## Use

Nothing to set up. When an agent hits a usage limit, it appears under **Quota Relay** in the
sidebar with the time it will continue. You can resume it now or cancel.

To move tasks to another account instead of waiting, open **Settings → Quota Relay**, turn on
**Switch account instead of waiting**, and list your accounts in order:

```
claude-work, claude-personal, codex
```

Use the provider ids Paseo shows. Add `/model` to pick a model, as in `codex/gpt-5`. The settings
screen warns you about entries this host doesn't have.

## How it behaves

- **Resume.** The reset time is read from the provider's notice: ISO timestamps, epoch seconds,
  `in 2 hours 10 minutes`, and `resets 3pm (Asia/Tokyo)` all work. At that time, plus up to a
  minute of jitter, it sends one continue prompt. Up to three tries per stop.
- **Rate-limit blips.** A bare `429 Too Many Requests` with no reset is not a used-up
  subscription. It waits two minutes on the same agent and never switches accounts.
- **Switch accounts.** A new agent starts in the same workspace on the next account that is not
  out of quota. It gets a short brief: your recent requests, the folder the stopped agent was
  working in, and the files it edited (paths only). It is told to inspect the working tree first.
- **Most quota first.** Optionally, pick the eligible account with the most quota left, from
  Paseo's usage data, instead of following list order.
- **Hidden helpers.** Background helper agents are left alone. Sub-agents are resumed but never
  replaced, since their parent owns the task.
- **Remembers.** Schedules, account cooldowns and the last 24 hours of outcomes survive restarts.

## Privacy

- **What a handoff sends to the other account:** your own recent requests (with key and token
  shapes redacted), the working directory, the edited file paths, and any extra instructions you
  set. The stopped agent's output is not copied unless you turn on **Include the stopped agent's
  last message**, because the new agent may be a different vendor.
- **What is stored:** agent ids, titles, provider ids and times, in
  `plugin-data/quota-relay/` under the Paseo home. The folder is owner-only and writes are atomic.
  The plugin's own files hold no conversation text. The redacted requests from a handoff brief
  are kept in the new agent's Paseo metadata, on your machine, so a further handoff can pass them
  on.
- **Only reported stops act on their own.** A limit-looking sentence in the agent's own text only
  shows a **Confirm** row. Quoted docs or tool output can't send a prompt.

## Limits

- Quota can't be checked in advance, so a resume may arrive before the limit has lifted. That
  turn fails and counts as a try.
- A handoff can't carry the provider session. The new agent starts from the brief, not the
  transcript, so it may repeat some work.
- The new agent starts in the workspace root and is told which folder to continue in.
- The new agent uses the target provider's default permission mode, not the stopped agent's.
- After a daemon restart, scheduled resumes start once a Paseo app is connected to the daemon.

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/quota-relay
paseo plugin reload quota-relay
```

[docs/DESIGN.md](docs/DESIGN.md) makes the case for making fallback a first-class Paseo feature.

MIT.
