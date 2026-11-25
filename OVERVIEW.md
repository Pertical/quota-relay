# Quota Relay

Keeps work moving when a subscription runs out. When an agent stops at a usage limit, Quota Relay
continues the same agent after the reset the provider stated. If you have another account with
quota left, it can move the task there instead of waiting.

## How it works

Quota Relay reads the turn that stopped from the agent timeline Paseo already has. It recognises
short provider limit notices and reads the reset time from them, including a named time zone.
Billing, credit and context-window stops are ignored, as is a notice quoted in a code block. At
the reset, plus up to a minute of jitter, it sends one continue prompt. It tries up to three
times per stop.

A bare rate limit, such as a 429 with no reset time, is treated as a short blip: the same agent
continues after two minutes, and the task never moves to another account.

## Setup

Nothing is required to resume after a limit. The sidebar row lists waiting agents, with
**Resume now** and **Cancel**.

To switch accounts, open the plugin's settings, turn on **Switch account instead of waiting**, and
list your accounts in order, for example `claude-work, claude-personal, codex`. The settings
screen warns about entries this host does not have.

## Settings

- **Automatic resumes**: the master switch.
- **Switch account instead of waiting**: start a new agent on the next account that is not out of
  quota. This spends that account's tokens.
- **Accounts**: the order to try. Add `/model` to an entry to pick a model.
- **Maximum handoffs per task**: how many times one task may move.
- **Prefer the account with the most quota left**: pick by Paseo's usage data instead of list order.
- **Include the stopped agent's last message**: off by default.
- **Extra instructions**: added to every handoff brief.

## What it reads and sends

- It reads no credentials, makes no network calls and runs no processes. Quota is only inferred
  from what the provider said in the conversation and from Paseo's own usage data.
- A handoff brief goes to the agent provider you chose. It contains your recent requests (with
  key and token shapes redacted), the stopped agent's folder and the paths of files it edited.
  The stopped agent's own output is not included unless you turn that on.
- Schedules, account cooldowns and the last 24 hours of outcomes (agent ids, titles, providers
  and times) are stored on the daemon, readable by your user only. When a task is handed off, the
  redacted requests from its brief are kept in the new agent's Paseo metadata, so a further
  handoff can pass them on. Nothing is stored anywhere else.
- Background helper agents are left alone. Sub-agents are resumed but never replaced.

## Limits

- Quota cannot be checked in advance, so a resume may arrive early. It counts as a try.
- A handoff cannot move the provider session, so the new agent may repeat some work.
- The new agent starts in the workspace root and is told which folder to continue in. It uses the
  target provider's default permission mode.
- After a daemon restart, scheduled resumes start once a Paseo app connects to the daemon.
