import { useServerStore } from "../../../store/serverStore";
import { showToast } from "../../../components/toastBridge";
import type { IntlShape } from "react-intl";

/**
 * A server setting that affects others applied at once: the toast offers Undo,
 * which puts the previous value back through the same save (its result shows
 * beside the switch). Undo works once, and only on the server it was changed
 * on; after a switch to another server it says so instead.
 */
export function showUndoToast({
  title,
  serverId,
  formatMessage,
  undo,
}: {
  title: string;
  serverId: string;
  formatMessage: IntlShape["formatMessage"];
  undo: () => void;
}) {
  let used = false;
  showToast({
    title,
    type: "success",
    actionProps: {
      children: formatMessage({ id: "settings.common.undo" }),
      onClick: () => {
        if (used) return;
        used = true;
        if (useServerStore.getState().current?.id !== serverId) {
          showToast({ title: formatMessage({ id: "settings.common.undoOtherServer" }), type: "error" });
          return;
        }
        undo();
      },
    },
  });
}
