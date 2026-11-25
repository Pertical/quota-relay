import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createEngine, type EngineApi } from "./server/engine";
import type { Job } from "./server/jobs";
import { checkChain, parseChain } from "./shared/handoff";
import { cancelRpc, checkChainRpc, listRpc, resumeNowRpc } from "./shared/rpc";
import { relaySettings, type Settings } from "./shared/settings";

/** How often a due resume is attempted. An empty schedule costs one in-memory check. */
const TICK_MS = 30_000;

const view = (job: Job) => ({
  agentId: job.agentId,
  provider: job.provider,
  title: job.title,
  kind: job.kind,
  handoffAgentId: job.handoffAgentId,
  dueAt: job.dueAt,
  attempts: job.attempts,
  status: job.status,
});

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(relaySettings);

  const readSettings = async (): Promise<Settings | null> => {
    const current = await settings.read().catch(() => null);
    return current?.status === "ready" ? current.values : null;
  };

  const engine = createEngine(readSettings);
  // The daemon hands the API to hook and RPC contexts; the timer reuses the last one it saw.
  let api: EngineApi | null = null;
  const remember = (paseo: unknown): EngineApi => {
    api = paseo as EngineApi;
    return api;
  };
  const report = (error: unknown) =>
    console.error("[quota-relay] tick failed", (error as { code?: string })?.code ?? "error");

  const stops: Array<() => void> = [
    server.addHook("agent.turn.after", async (event, context) => {
      const paseo = remember(context.paseo);
      await engine.onTurnAfter(paseo, event);
    }),
  ];

  server.handle(listRpc, async (_input, context) => {
    remember(context.paseo);
    const { jobs, accounts, history } = await engine.list();
    const now = Date.now();
    return {
      jobs: jobs.map(view),
      accounts: Object.entries(accounts).map(([provider, state]) => ({
        provider,
        resetAt: state.resetAt,
        cooling: Date.parse(state.resetAt) > now,
        scope: state.scope ?? null,
      })),
      history: history.map((entry) => ({
        at: entry.at,
        agentId: entry.agentId,
        title: entry.title,
        provider: entry.provider,
        outcome: entry.outcome,
        detail: entry.detail,
      })),
    };
  });
  server.handle(cancelRpc, async ({ agentId }, context) => {
    remember(context.paseo);
    return { ok: await engine.cancel(agentId) };
  });
  server.handle(resumeNowRpc, async ({ agentId }, context) => {
    const paseo = remember(context.paseo);
    return engine.resumeNow(paseo, agentId);
  });
  server.handle(checkChainRpc, async ({ chain }, context) => {
    remember(context.paseo);
    try {
      const result = await context.paseo.providers.listAvailable();
      return { ...checkChain(parseChain(chain), result.providers), checked: true };
    } catch {
      return { unknown: [], unavailable: [], checked: false };
    }
  });

  const timer = setInterval(() => {
    const current = api;
    if (current) void engine.tick(current).catch(report);
  }, TICK_MS);

  return () => {
    clearInterval(timer);
    for (const stop of stops) stop();
  };
}
