import type { ComponentProps, CSSProperties, PropsWithChildren } from "react";
import { TraceIdNote } from "./errors/TraceIdNote";
import { CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  ToastAction,
  ToastActions,
  ToastBody,
  ToastClose,
  ToastContent,
  ToastPortal,
  ToastProvider,
  ToastRoot,
  ToastIcon,
  ToastDescription,
  ToastTitle,
  ToastViewport,
  useToastManager,
} from "@botiverse/raft-ui";
import { useEffect, useMemo, useRef } from "react";
import { useIntl } from "react-intl";
import { registerObjectWindowToastManager, setToastManager } from "./toastBridge";
import { takeRecentFailedRequestTraceId } from "../utils/requestTraceId";
import { useToastViewportBottom } from "./toastViewportBottom";
import AvatarSlot from "./ui/AvatarSlot";

/**
 * What a toast may carry beyond raft-ui's own fields. `person`: the toast is about
 * someone, so it leads with their avatar instead of its intent's icon (Raft Design
 * System › Toast: "When the toast is about someone, show their avatar there").
 */
export type LocalizedToastData = {
  intent?: string;
  /** Draw a Dismiss (×). Off unless asked: Raft DS › Toast (raft-ui 0.28) has
   *  none, a toast closes by itself, by a swipe or with Esc. */
  hasClose?: boolean;
  hasIcon?: boolean;
  contentClassName?: string;
  person?: { avatarUrl?: string | null };
  /** The failed request's trace id: shown with a copy button under the text (#proj-o11y:#18). */
  traceId?: string;
};


/**
 * The default raft-ui toast close control intentionally uses English fallback
 * copy. The app owns the active locale, so keep the same provider/manager
 * contract while supplying localized visible and accessible dismissal text
 * for the rare toast that asks for a close (`dismissible: true`).
 *
 * Raft Design System › Toast: the neutral HUD (raft-ui's raft toast recipe).
 * A receipt with no "who" leads with its intent's Lucide icon (raft-ui 0.22,
 * design/foundations/alignment.md#a-mark-that-leads-text): information Info,
 * done CircleCheck, a problem TriangleAlert. A status light never says what
 * kind of notice it is.
 */
const TOAST_ICON: Record<string, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: TriangleAlert,
};

function ToastIntentIcon({ intent }: { intent: string | undefined }) {
  const Icon = (intent && TOAST_ICON[intent]) || Info;
  return <Icon aria-hidden="true" data-testid="localized-toast-intent-icon" data-intent={intent ?? "info"} />;
}
/**
 * An error toast raised right after an API request failed shows that request's
 * trace id with a copy button (#proj-o11y:#18), unless it already names one.
 * Done here, where every toast renders, because raft-ui's `toast.error` adds to
 * the manager directly, past `showToast`. The id is taken once, when the toast
 * first renders (right after it was added), and kept for that toast while it
 * shows (8 s, past the 5 s window); taking it means a later error toast does not
 * repeat it.
 */
function useErrorToastTraceIds(toasts: ReadonlyArray<{ id: string; type?: string; data?: LocalizedToastData }>) {
  const byToastId = useRef(new Map<string, string | null>());
  const known = byToastId.current;
  for (const toastObject of toasts) {
    if (toastObject.type !== "error" || toastObject.data?.traceId || known.has(toastObject.id)) continue;
    known.set(toastObject.id, takeRecentFailedRequestTraceId());
  }
  for (const id of known.keys()) {
    if (!toasts.some((toastObject) => toastObject.id === id)) known.delete(id);
  }
  return (toastObject: { id: string; data?: LocalizedToastData }) =>
    toastObject.data?.traceId ?? known.get(toastObject.id) ?? null;
}

/**
 * A closing toast fades out of the flow. The toasts are laid out inline (in
 * flow, newest first) on the viewport's floor, and a closing one stays mounted
 * for its fade: kept in flow, it would hold its slot under the newer toast that
 * replaces it, lifting that one a slot, which then drops when it goes (an
 * Activity row's Done twice in quick succession). Out of flow, on the floor and
 * under the newer one, it fades where it was and the newer takes its place.
 * It takes no presses meant for the newer one's action.
 */
const CLOSING_TOAST_CLASS = "absolute inset-x-0 bottom-0 z-below pointer-events-none";

function LocalizedToastList() {
  const { formatMessage } = useIntl();
  const { toasts } = useToastManager<LocalizedToastData>();
  const dismissLabel = formatMessage({ id: "common.toast.close" });
  const traceIdOf = useErrorToastTraceIds(toasts);

  return toasts.map((toastObject) => {
    const traceId = traceIdOf(toastObject);
    const showAction = Boolean(toastObject.actionProps?.children);
    const showClose = toastObject.data?.hasClose === true;
    const showIcon = toastObject.data?.hasIcon !== false;
    const intent = toastObject.data?.intent ?? toastObject.type;
    const person = toastObject.data?.person;
    return (
      <ToastRoot
        key={toastObject.id}
        toast={toastObject}
        layout="inline"
        className={toastObject.transitionStatus === "ending" ? CLOSING_TOAST_CLASS : undefined}
        data-testid="localized-toast-row"
      >
        <ToastContent
          className={[
            "!grid-cols-[auto_minmax(0,1fr)_auto] !items-center !gap-x-3 !gap-y-0",
            toastObject.data?.contentClassName,
          ].filter(Boolean).join(" ")}
          data-testid="localized-toast-content-row"
        >
          {showIcon ? (
            <ToastIcon className="flex size-5 items-center justify-center border-0 bg-transparent p-0 shadow-none" data-testid="localized-toast-icon">
              {person ? (
                <span aria-hidden="true" data-testid="localized-toast-person">
                  <AvatarSlot context="compact-list" type="human" humanAvatarUrl={person.avatarUrl} />
                </span>
              ) : (
                <ToastIntentIcon intent={intent} />
              )}
            </ToastIcon>
          ) : null}
          <ToastBody className="min-w-0 text-left" data-testid="localized-toast-content">
            <ToastTitle className="whitespace-normal break-words font-normal" />
            {toastObject.description ? <ToastDescription /> : null}
            {traceId ? <TraceIdNote traceId={traceId} surface="dark" /> : null}
          </ToastBody>
          {showAction || showClose ? (
            <ToastActions
              className="!col-span-1 !col-start-3 !row-start-1 !w-auto shrink-0 justify-self-end"
              data-testid="localized-toast-actions"
            >
              {showClose ? (
                <ToastClose
                  aria-label={dismissLabel}
                  aria-hidden={false}
                  data-testid="localized-toast-close"
                >
                  <X size={16} aria-hidden="true" />
                </ToastClose>
              ) : null}
              {showAction ? <ToastAction /> : null}
            </ToastActions>
          ) : null}
        </ToastContent>
      </ToastRoot>
    );
  });
}

/**
 * Publishes the live manager to `toastBridge` for surfaces that may render without a provider: the app's, or an
 * object window's (`objectWindowDocument`), which showToast uses while that window has the focus.
 */
function ToastManagerBridge({ objectWindowDocument }: { objectWindowDocument?: Document }) {
  const manager = useToastManager();
  useEffect(() => {
    if (objectWindowDocument) return registerObjectWindowToastManager(objectWindowDocument, manager);
    setToastManager(manager);
    return () => setToastManager(null);
  }, [manager, objectWindowDocument]);
  return null;
}

/** An object window's viewport: the window's bottom (it has no composer or tab bar to sit above). */
function ObjectWindowToastViewport() {
  return (
    <ToastViewport data-testid="localized-toast-viewport" data-toast-viewport="">
      <LocalizedToastList />
    </ToastViewport>
  );
}

/** The toast viewport, offset by `useToastViewportBottom`, which holds its page height while a toast shows. */
function LocalizedToastViewport() {
  const { toasts } = useToastManager();
  const viewportBottom = useToastViewportBottom(toasts.length > 0);
  const viewportStyle = useMemo(
    () => (viewportBottom === null ? undefined : ({ "--toast-viewport-bottom": `${viewportBottom}px` } as CSSProperties)),
    [viewportBottom],
  );
  return (
    <ToastViewport style={viewportStyle} data-testid="localized-toast-viewport" data-toast-viewport="">
      <LocalizedToastList />
    </ToastViewport>
  );
}

/**
 * raft-ui 0.28's defaults are Raft's toast rules, so none are restated here:
 * one toast at a time (a newer one replaces and closes the older), 5 seconds,
 * 8 with an action or as an error (`toast.*`; `showToast` sets its own), and
 * the bottom center. The viewport sits 16px above `--toast-viewport-bottom`,
 * which `useToastViewportBottom` measures at every width (above the composer
 * or the bar in its place, the tab bar or the keyboard, holding the page's
 * height while a toast shows; raft-design #1217); a page with no floor gets
 * 0, the window's bottom.
 */
export default function LocalizedToastProvider({
  children,
  toastManager,
  objectWindowDocument,
}: PropsWithChildren<{
  /**
   * The manager this provider shows: an object window's own (default: raft-ui's app-wide one). Its viewport
   * portals to the nearest PortalContainerProvider's container (the object window's body), and useToast() under it
   * shows there.
   */
  toastManager?: ComponentProps<typeof ToastProvider>["toastManager"];
  /** The object window this provider serves (features/objectWindows): showToast reaches it while it has the focus. */
  objectWindowDocument?: Document;
}>) {
  return (
    <ToastProvider renderViewport={false} {...(toastManager ? { toastManager } : null)}>
      <ToastManagerBridge objectWindowDocument={objectWindowDocument} />
      {children}
      <ToastPortal>
        {objectWindowDocument ? <ObjectWindowToastViewport /> : <LocalizedToastViewport />}
      </ToastPortal>
    </ToastProvider>
  );
}
