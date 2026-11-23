import { createElement, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { createToastManager, PortalContainerProvider } from "@botiverse/raft-ui";
import LocalizedToastProvider from "../../components/LocalizedToastProvider";
import { attachShortcutDocument } from "../shortcuts/dispatcher";
import { OwnerDocumentContext } from "../../utils/ownerDocument";
import type { OwnerWindow } from "../../utils/ownerDocument";
import { ObjectWindowContext } from "./objectWindowContext";
import { ObjectWindowFocus } from "./ObjectWindowFocus";
import { ObjectWindowLocationRaise } from "./ObjectWindowLocationRaise";
import { ObjectWindowNavigation } from "./ObjectWindowNavigation";
import { closeAllObjectWindows, closeObjectWindow, useObjectWindowStore } from "./objectWindowStore";
import type { ObjectWindowEntry } from "./objectWindowStore";
import { raiseMainWindow } from "./raiseMainWindow";

/**
 * One object window's portal: its object drawn into the window's document by
 * this page's React tree, with what makes a subtree at home in another
 * window: its document and window for the code that reads them
 * (useOwnerDocument, useOwnerWindow, useObjectWindow), its body for every
 * overlay (raft-ui's PortalContainerProvider: popovers, menus, tooltips,
 * dialogs, the toast viewport; the web's own portals read the same), toasts
 * of its own (a ToastProvider on its own manager: useToast() and showToast
 * there show here), the shortcut registry listening on it (a global command
 * typed there also raises the main window), its focus, and links acting on
 * the main window.
 */
function ObjectWindowPortal({ entry }: { entry: ObjectWindowEntry }) {
  const { name, doc, win, root, kind, payload, revision } = entry;
  const render = useObjectWindowStore((state) => state.kinds.get(kind)?.render);
  const [toastManager] = useState(() => createToastManager());
  const close = useMemo(() => () => closeObjectWindow(name), [name]);
  const owner = useMemo(() => ({ doc, win: win as OwnerWindow }), [doc, win]);
  const context = useMemo(() => ({ name, doc, win, close }), [name, doc, win, close]);

  useEffect(() => attachShortcutDocument(doc, { onGlobalCommand: () => { void raiseMainWindow(); } }), [doc]);

  return createPortal(
    <OwnerDocumentContext value={owner}>
      <ObjectWindowContext value={context}>
        <PortalContainerProvider container={doc.body}>
          <LocalizedToastProvider toastManager={toastManager} objectWindowDocument={doc}>
            <ObjectWindowFocus entry={entry} />
            <ObjectWindowNavigation doc={doc} />
            {/* The kind's render as a component of its own (its hooks are its own), remounted when the object is
                replaced or the window reloaded. */}
            {render ? createElement(render, { key: revision, name, payload, close }) : null}
          </LocalizedToastProvider>
        </PortalContainerProvider>
      </ObjectWindowContext>
    </OwnerDocumentContext>,
    root,
    name,
  );
}

/**
 * Every open object window's portal (features/objectWindows). Mounted once by
 * the layout, beside the WebLinkRouter, inside the router; the layout
 * unmounting (a server switch, a sign-out) closes them all, as their objects
 * belong to the server they were opened in.
 */
export function ObjectWindowsHost() {
  const windows = useObjectWindowStore((state) => state.windows);
  useEffect(() => () => closeAllObjectWindows(), []);
  return (
    <>
      <ObjectWindowLocationRaise />
      {Array.from(windows.values(), (entry) => <ObjectWindowPortal key={entry.name} entry={entry} />)}
    </>
  );
}
