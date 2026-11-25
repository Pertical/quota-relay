import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { listRpc } from "./shared/rpc";
import { RelayScreen, RELAY_LIST_KEY } from "./client/screen";
import { RelaySettingsScreen } from "./client/settings";
import { RELAY_ICON } from "./client/icon";

const SCREEN_ID = "quota-relay";
const TITLE = "Quota Relay";

/**
 * Poll quickly only while something is scheduled. The poll also hands the daemon a fresh SDK
 * handle after a restart, so it never stops entirely.
 */
const BUSY_POLL_MS = 15_000;
const IDLE_POLL_MS = 60_000;

function RelayItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const list = useRpc(listRpc);
  const data = useQuery({
    queryKey: RELAY_LIST_KEY,
    queryFn: () => list({}),
    refetchInterval: (query) =>
      query.state.data?.jobs.some((job) => job.status === "pending") ? BUSY_POLL_MS : IDLE_POLL_MS,
  });
  const count = data.data?.jobs.filter((job) => job.status === "pending").length ?? 0;
  return (
    <SidebarRow
      icon={RELAY_ICON}
      label={count > 0 ? `${TITLE} (${count} waiting)` : TITLE}
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: SCREEN_ID, title: TITLE, Component: RelayScreen });
  client.addSettingsScreen({ id: `${SCREEN_ID}-settings`, title: TITLE, icon: RELAY_ICON, Component: RelaySettingsScreen });
  client.addSidebarFooterItem({ id: SCREEN_ID, title: TITLE, Component: RelayItem });
  return () => {};
}
