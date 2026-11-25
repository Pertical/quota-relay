import { useRpc, useSettings } from "@getpaseo/plugin/client";
import type { SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Text } from "react-native";
import { checkChainRpc } from "../shared/rpc";
import { MAX_HOPS_LIMIT, relaySettings, type Settings } from "../shared/settings";

const HOP_OPTIONS = Array.from({ length: MAX_HOPS_LIMIT }, (_, index) => {
  const hops = index + 1;
  return { value: String(hops), label: hops === 1 ? "1 handoff" : `${hops} handoffs` };
});

/** One line naming chain entries a handoff could not use, or null when the chain looks fine. */
function chainWarning(check: { unknown: string[]; unavailable: string[]; checked: boolean } | undefined): string | null {
  if (!check?.checked) return null;
  const parts: string[] = [];
  if (check.unknown.length > 0) parts.push(`Not a provider on this host: ${check.unknown.join(", ")}`);
  if (check.unavailable.length > 0) parts.push(`Not available right now: ${check.unavailable.join(", ")}`);
  return parts.length > 0 ? parts.join(". ") : null;
}

export function RelaySettingsScreen() {
  const settings = useSettings(relaySettings);
  const checkChain = useRpc(checkChainRpc);
  const toast = useToast();
  const chain = useRef<SettingsInputHandle>(null);
  const note = useRef<SettingsInputHandle>(null);
  const [edited, setEdited] = useState(false);

  const savedChain = settings.status === "ready" ? settings.values.fallbackChain : "";
  const switching = settings.status === "ready" && settings.values.autoSwitch;
  const check = useQuery({
    queryKey: ["quota-relay", "check-chain", savedChain],
    queryFn: () => checkChain({ chain: savedChain }),
    enabled: switching && savedChain.trim().length > 0,
    staleTime: 5 * 60_000,
  });

  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Quota Relay">
        <SettingsCard>
          <Text>{settings.status === "loading" ? "Loading…" : "Settings are unavailable."}</Text>
        </SettingsCard>
      </SettingsSection>
    );
  }

  const values = settings.values;
  const save = async (patch: Partial<Settings>): Promise<boolean> => {
    const ok = await settings.save({ ...values, ...patch }, settings.revision);
    if (!ok) toast.show("Could not save. Reopen settings and try again.", { variant: "error" });
    return ok;
  };

  const saveText = async () => {
    const noteText = note.current?.getText().trim() ?? "";
    const ok = await save({
      fallbackChain: chain.current?.getText().trim() ?? values.fallbackChain,
      handoffNote: noteText.length > 0 ? noteText : null,
    });
    if (ok) {
      setEdited(false);
      toast.show("Saved", { variant: "success" });
    }
  };

  return (
    <>
      <SettingsSection title="Resume">
        <SettingsCard>
          <SettingsSwitch
            label="Automatic resumes"
            hint="When an agent stops at a usage limit, continue it once the limit resets."
            value={values.enabled}
            onValueChange={(enabled) => void save({ enabled })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Switch accounts"
        info="Instead of waiting, start a new agent on another account that still has quota. It gets a short brief: your recent requests and the files the stopped agent edited."
      >
        <SettingsCard>
          <SettingsSwitch
            label="Switch account instead of waiting"
            hint="Spends the other account's tokens. Short rate-limit blips never switch."
            value={values.autoSwitch}
            disabled={!values.enabled}
            onValueChange={(autoSwitch) => void save({ autoSwitch })}
          />
          {values.autoSwitch ? (
            <>
              <SettingsInput
                ref={chain}
                label="Accounts"
                hint="Provider ids in order, comma separated. Add /model to pick a model. Accounts still out of quota are skipped."
                error={edited ? null : chainWarning(check.data)}
                initialValue={values.fallbackChain}
                placeholder="claude-work, claude-personal, codex"
                onChangeText={() => setEdited(true)}
              />
              <SettingsInput
                ref={note}
                label="Extra instructions"
                hint="Optional. Added to every handoff brief."
                initialValue={values.handoffNote ?? ""}
                placeholder="Keep the existing API shape."
                onChangeText={() => setEdited(true)}
              />
              <SettingsAction
                label={edited ? "Unsaved changes" : "Accounts and instructions"}
                actionLabel="Save"
                disabled={!edited}
                onPress={() => void saveText()}
              />
              <SettingsSelect
                label="Maximum handoffs per task"
                hint="How many times one task may move to another account."
                value={String(Math.max(1, values.maxHops))}
                options={HOP_OPTIONS}
                onValueChange={(value) => void save({ maxHops: Number(value) })}
              />
              <SettingsSwitch
                label="Prefer the account with the most quota left"
                hint="Uses Paseo's usage data to pick among eligible accounts. Accounts without data keep their order."
                value={values.rebalance}
                onValueChange={(rebalance) => void save({ rebalance })}
              />
              <SettingsSwitch
                label="Include the stopped agent's last message"
                hint="Off by default. The new agent may be another vendor, and that message can contain anything the agent read."
                value={values.handoffIncludeLastMessage}
                onValueChange={(handoffIncludeLastMessage) => void save({ handoffIncludeLastMessage })}
              />
            </>
          ) : null}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
