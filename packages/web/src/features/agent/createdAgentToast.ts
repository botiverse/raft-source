import { toast } from "@botiverse/raft-ui";
import type { IntlShape } from "react-intl";
import { requestComposerFocusOnceShown } from "../../components/message/composerFocusRequest";
import type { useAppNavigate } from "../../hooks/useAppNavigate";
import { useChannelStore } from "../../store/channelStore";
import type { Channel } from "../../store/channelStore";
import { useProfileStore } from "../../store/profileStore";
import { useServerStore } from "../../store/serverStore";
import { useThreadStore } from "../../store/threadStore";
import { focusLost } from "../../utils/focusGuard";
import { watchFocusIntent } from "../../utils/focusRequest";
import { opensProfileInPanel } from "../members/useMembersProfileRedirect";

type AppNavigate = Pick<ReturnType<typeof useAppNavigate>, "toDm">;
type CreatedAgent = { id: string; name: string; displayName?: string | null };

/** The conversation column (MainLayout's `data-main-column`): the region that will hold the DM's composer. */
const mainColumn = () => document.querySelector<HTMLElement>("[data-main-column]");

/**
 * Focus waits on the conversation column while the DM's page loads, so it is
 * never on nothing (Raft DS › Toast, Behavior). The column takes focus only
 * for this: it is focusable until focus leaves it (the composer taking it).
 */
function holdFocusOnMainColumn(): void {
  const column = mainColumn();
  if (!column || column === document.activeElement) return;
  if (!column.hasAttribute("tabindex")) {
    column.setAttribute("tabindex", "-1");
    column.addEventListener("blur", () => column.removeAttribute("tabindex"), { once: true });
  }
  column.focus({ preventScroll: true });
}

/**
 * View on the "Created <name>" toast: the new agent's DM in the middle (the
 * existing DM, else one opened now, as Message on a profile does) and its
 * profile beside it in the side panel, with focus in the DM's composer. Where
 * the profile would be its own page over the DM (a phone), only the DM opens,
 * so the composer focus lands on stays in view. A press or focus move of the
 * person's own while the DM is opened means they went on: nothing moves.
 */
export async function viewCreatedAgent(
  agent: CreatedAgent,
  serverId: string | undefined,
  nav: AppNavigate,
  formatMessage: IntlShape["formatMessage"],
): Promise<void> {
  const onServer = () => useServerStore.getState().current?.id === serverId;
  // Another server now: its stores and `nav`'s address are not this agent's.
  if (!onServer()) return;
  const wanted = watchFocusIntent(mainColumn, { repeat: true });
  useThreadStore.getState().closeThread();
  const { dmChannels, openDM } = useChannelStore.getState();
  let dm: Channel | undefined = dmChannels.find((channel) => channel.peerType === "agent" && channel.peerId === agent.id);
  if (!dm) {
    try {
      dm = await openDM(agent.id);
    } catch {
      if (!onServer()) return;
      toast.error(formatMessage({ id: "agent.create.createdToast.openFailed" }, { name: agent.displayName || agent.name }));
      // The toast that was pressed has gone: focus stays on this page, not on nothing.
      if (wanted() && focusLost()) holdFocusOnMainColumn();
      return;
    }
  }
  if (!onServer() || !wanted()) return;
  nav.toDm(dm.id);
  // After the navigation: the profile's ?profile= is written onto the DM's address.
  if (opensProfileInPanel()) useProfileStore.getState().openProfile("agent", agent.id, { openSource: "channel" });
  holdFocusOnMainColumn();
  requestComposerFocusOnceShown(dm.id, wanted);
}

/**
 * The receipt for an agent created from the sidebar, the Members page or a
 * Computer (#triage:abdb39d9, cindyz 2026-11-12): the person stays where they
 * were, and View takes them to the agent. Shown once the create dialog has
 * closed (Raft DS › Toast: no toast with an action over a modal). The `toast`
 * command API gives a toast with an action its 8 seconds.
 */
export function showCreatedAgentToast(
  agent: CreatedAgent,
  formatMessage: IntlShape["formatMessage"],
  nav: AppNavigate,
): void {
  const serverId = useServerStore.getState().current?.id;
  const id = toast.success(
    formatMessage({ id: "agent.create.createdToast.title" }, { name: agent.displayName || agent.name }),
    {
      action: {
        label: formatMessage({ id: "agent.create.createdToast.view" }),
        onClick: () => {
          // Close first: closing hands keyboard focus back to where it was
          // before F6, which is where the press's focus intent starts from.
          toast.dismiss(id);
          void viewCreatedAgent(agent, serverId, nav, formatMessage);
        },
      },
    },
  );
}
