import { isHostShell } from "../../embed";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useMessageStore } from "../../store/messageStore";
import { useProfileStore } from "../../store/profileStore";
import { useThreadStore } from "../../store/threadStore";
import { isThreadBehindChannel, isThreadMaximized, useUIStore } from "../../store/uiStore";
import { DESKTOP_SHELL_QUERY } from "./desktopShell";

/**
 * The open thread in MainLayout's row (uiStore's shared contract): its Focus Mode as the row applies it
 * (`data-thread-maximized`), whether it stepped behind its channel (`data-thread-behind`), and whether Focus Mode
 * would apply if set (`focusApplies`): only for a thread open beside its own conversation, the one open, and not
 * under a profile covering it (a phone's). The thread's Expand (#189 rule 5) shows only where `focusApplies`: pressing
 * it works wherever it shows, as every other region's does.
 */
export function useThreadRowState(): { maximized: boolean; behind: boolean; focusApplies: boolean } {
  const parentMessageId = useThreadStore((s) => s.openParentMessageId);
  const parentChannelId = useThreadStore((s) => s.openParentChannelId);
  const currentChannelId = useMessageStore((s) => s.currentChannelId);
  const maximized = useUIStore((s) => s.threadMaximized);
  const behind = useUIStore((s) => s.threadBehindChannel);
  const profileOpen = useProfileStore((s) => !!s.profileId);
  // ShellFrame's `useIsDesktopShell` (MainLayout's `isDesktop`), without the shell's own module.
  const desktop = useMediaQuery(DESKTOP_SHELL_QUERY) && !isHostShell();
  const profileCovers = profileOpen && !desktop;
  const focusApplies = isThreadMaximized(true, parentMessageId, parentChannelId, currentChannelId, profileCovers);
  return {
    maximized: maximized && focusApplies,
    behind: isThreadBehindChannel(behind, parentMessageId, parentChannelId, currentChannelId),
    focusApplies,
  };
}
