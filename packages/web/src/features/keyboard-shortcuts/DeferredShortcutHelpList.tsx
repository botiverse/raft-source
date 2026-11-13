import { Suspense } from "react";
import type { ComponentProps } from "react";
import { useIntl } from "react-intl";
import { deferredPanel } from "../../boot/deferredUi";
import { PanelLoading } from "../../components/layout/PanelLoading";
import type { ShortcutHelpList as ShortcutHelpListComponent } from "./ShortcutHelpList";

// The shortcuts list (every command, its keys and the editor for them) shows
// only once the panel or page is open, so it is deferred (boot/deferredUi):
// fetched after the first screen. The panel itself stays in the layout: it
// owns ⌘/ and closes when a thread or profile opens.
const LazyShortcutHelpList = deferredPanel(() => import("./ShortcutHelpList").then((module) => ({ default: module.ShortcutHelpList })));

/** ShortcutHelpList, its code deferred: a loading line in its place until it is in. */
export function ShortcutHelpList(props: ComponentProps<typeof ShortcutHelpListComponent>) {
  const { formatMessage } = useIntl();
  return (
    <Suspense fallback={<PanelLoading className="flex min-h-40" label={formatMessage({ id: "layout.main.loading" })} />}>
      <LazyShortcutHelpList {...props} />
    </Suspense>
  );
}
