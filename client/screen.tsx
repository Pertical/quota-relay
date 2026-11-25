import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { cancelRpc, listRpc, resumeNowRpc } from "../shared/rpc";
import { relaySettings } from "../shared/settings";

/** Shared with the sidebar row, so both read one query instead of polling twice. */
export const RELAY_LIST_KEY = ["quota-relay", "list"] as const;
const QUERY_KEY = RELAY_LIST_KEY;

const OUTCOME_LABELS = {
  resumed: "Continue sent",
  "handed-off": "Handed off",
  "gave-up": "Gave up",
  cancelled: "Cancelled",
} as const;

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function RelayScreen({ theme, layout, navigation }: PluginScreenProps) {
  const list = useRpc(listRpc);
  const cancel = useRpc(cancelRpc);
  const resumeNow = useRpc(resumeNowRpc);
  const settings = useSettings(relaySettings);
  const queryClient = useQueryClient();

  const data = useQuery({ queryKey: QUERY_KEY, queryFn: () => list({}), refetchInterval: 15_000 });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const cancelJob = useMutation({ mutationFn: (agentId: string) => cancel({ agentId }), onSuccess: invalidate });
  const sendNow = useMutation({ mutationFn: (agentId: string) => resumeNow({ agentId }), onSuccess: invalidate });

  const enabled = settings.status === "ready" ? settings.values.enabled : true;
  const toggle = () => {
    if (settings.status !== "ready") return;
    void settings.save({ ...settings.values, enabled: !settings.values.enabled }, settings.revision);
  };

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      body: { padding: layout.compact ? 16 : 24, gap: layout.compact ? 12 : 16 },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 20, fontWeight: "600" as const },
      section: { color: theme.colors.foregroundMuted, fontSize: 12, letterSpacing: 0.6 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      card: { gap: 6, padding: 12, borderRadius: 10, backgroundColor: theme.colors.surface1 },
      name: { color: theme.colors.foreground, fontWeight: "600" as const },
      detail: { color: theme.colors.foregroundMuted, fontSize: 13 },
      actions: { flexDirection: "row" as const, gap: 8, marginTop: 4 },
      button: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: theme.colors.surface2 },
      primary: { backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.foreground, fontSize: 13 },
      primaryText: { color: theme.colors.accentForeground, fontSize: 13 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  const jobs = data.data?.jobs ?? [];
  const accounts = (data.data?.accounts ?? []).filter((account) => account.cooling);
  const history = data.data?.history ?? [];
  // A refused resume returns its reason; a transport failure throws.
  const sendError = sendNow.data?.error ?? (sendNow.error ? "Could not reach the daemon" : null);
  const pending = jobs.filter((job) => job.status === "pending" && (job.kind === "resume" || job.kind === "confirm"));

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <Text style={styles.title}>Quota Relay</Text>
      <Text style={styles.hint}>
        When an agent stops at a usage limit, it continues after the reset, or moves to another
        account if switching is on in settings.
      </Text>

      <View style={styles.row}>
        <View style={{ gap: 2, flexShrink: 1 }}>
          <Text style={styles.name}>Automatic resumes</Text>
          <Text style={styles.detail}>{enabled ? "On" : "Off — nothing is scheduled or sent"}</Text>
        </View>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: enabled }}
          accessibilityLabel="Automatic resumes"
          onPress={toggle}
          style={[styles.button, enabled ? styles.primary : null]}
        >
          <Text style={enabled ? styles.primaryText : styles.buttonText}>{enabled ? "On" : "Off"}</Text>
        </Pressable>
      </View>

      {accounts.length > 0 ? (
        <>
          <Text style={styles.section}>Accounts out of quota</Text>
          {accounts.map((account) => (
            <View key={account.provider} style={styles.card}>
              <Text style={styles.name}>{account.provider}</Text>
              <Text style={styles.detail}>
                free again at {when(account.resetAt)}
                {account.scope && account.scope !== "unknown" ? ` · ${account.scope} limit` : ""}
              </Text>
            </View>
          ))}
        </>
      ) : null}

      <Text style={styles.section}>Scheduled</Text>
      {pending.length === 0 ? (
        <Text style={styles.hint}>Nothing waiting. This fills when an agent stops at a usage limit.</Text>
      ) : (
        pending.map((job) => (
          <View key={job.agentId} style={styles.card}>
            <Text style={styles.name}>{job.title ?? job.agentId.slice(0, 8)}</Text>
            <Text style={styles.detail}>
              {job.kind === "confirm"
                ? `${job.provider} · limit seen in the agent's message — confirm to send`
                : `${job.provider} · resumes at ${when(job.dueAt)}${job.attempts > 0 ? ` · ${job.attempts} sent` : ""}`}
            </Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${job.kind === "confirm" ? "Confirm" : "Resume"} ${job.title ?? job.agentId} now`}
                style={[styles.button, styles.primary]}
                onPress={() => sendNow.mutate(job.agentId)}
              >
                <Text style={styles.primaryText}>{job.kind === "confirm" ? "Confirm" : "Resume now"}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Cancel the resume for ${job.title ?? job.agentId}`}
                style={styles.button}
                onPress={() => cancelJob.mutate(job.agentId)}
              >
                <Text style={styles.danger}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ))
      )}

      {jobs.some((job) => job.kind === "handoff") ? <Text style={styles.section}>Handed off</Text> : null}
      {jobs
        .filter((job) => job.kind === "handoff")
        .map((job) => (
          <View key={job.agentId} style={styles.card}>
            <Text style={styles.name}>{job.title ?? job.agentId.slice(0, 8)}</Text>
            <Text style={styles.detail}>{job.provider} ran out · a new agent continues the task</Text>
            <View style={styles.actions}>
              {navigation?.openAgent && job.handoffAgentId ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open the agent continuing ${job.title ?? job.agentId}`}
                  style={[styles.button, styles.primary]}
                  onPress={() => navigation.openAgent?.({ agentId: job.handoffAgentId as string })}
                >
                  <Text style={styles.primaryText}>Open</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Dismiss the handoff record for ${job.title ?? job.agentId}`}
                style={styles.button}
                onPress={() => cancelJob.mutate(job.agentId)}
              >
                <Text style={styles.danger}>Dismiss</Text>
              </Pressable>
            </View>
          </View>
        ))}

      {history.length > 0 ? (
        <>
          <Text style={styles.section}>Last 24 hours</Text>
          {history.slice(0, 8).map((entry) => (
            <View key={`${entry.agentId}-${entry.at}`} style={styles.row}>
              <View style={{ gap: 2, flexShrink: 1 }}>
                <Text style={styles.name}>{entry.title ?? entry.agentId.slice(0, 8)}</Text>
                <Text style={styles.detail}>
                  {OUTCOME_LABELS[entry.outcome]}
                  {entry.detail ? ` · ${entry.detail}` : ""}
                </Text>
              </View>
              <Text style={styles.detail}>{when(entry.at)}</Text>
            </View>
          ))}
        </>
      ) : null}

      {sendError ? <Text style={styles.danger}>{sendError}</Text> : null}
    </ScrollView>
  );
}
