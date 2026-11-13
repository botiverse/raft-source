import { useIntl } from "react-intl";
import { PanelBody, ScrollArea } from "@botiverse/raft-ui";
import PanelHeader from "../../components/ui/PanelHeader";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { useServerStore } from "../../store/serverStore";
import { ShortcutHelpList } from "./DeferredShortcutHelpList";

/**
 * The keyboard shortcuts as a phone's pushed page (`/s/:slug/keyboard-shortcuts`),
 * opened from Settings › Resources the way Release Notes is: PanelHeader with
 * Back and the title, then the list scrolling under it. Below 768px there is
 * no rail, no Help menu and no side column for the panel.
 */
export function ShortcutHelpPage() {
  const { formatMessage } = useIntl();
  const serverSlug = useServerStore((s) => s.current?.slug);
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}/settings` : "/");
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="keyboard-shortcuts-page">
      <PanelHeader title={formatMessage({ id: "keyboardShortcuts.title" })} onMobileBack={onMobileBack} />
      <PanelBody className="bg-layer-canvas text-foreground">
        <ScrollArea className="h-full min-h-0" contentClassName="px-4 py-4 md:px-(--surface-inset)">
          <ShortcutHelpList />
        </ScrollArea>
      </PanelBody>
    </div>
  );
}
