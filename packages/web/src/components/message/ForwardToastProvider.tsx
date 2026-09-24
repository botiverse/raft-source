import type { PropsWithChildren } from "react";
import {
  ToastAction,
  ToastActions,
  ToastBody,
  ToastClose,
  ToastContent,
  ToastPortal,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport,
  useToastManager,
} from "raft-ui";
import { forwardToastManager } from "./forwardToast";

// Backport raft-ui >=0.0.20's placement-aware stacked motion while Web remains
// on 0.0.15 for the legacy BottomSheet API used by the Forward mobile flow.
const TOP_STACKED_TOAST_CLASS = "top-0 bottom-auto w-full max-w-full origin-top [--toast-y:calc(var(--toast-offset-y)+(var(--toast-index)*var(--toast-gap))+var(--toast-swipe-movement-y))] [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))))_scale(var(--toast-scale))] data-[expanded]:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-y))_scale(1)] data-[starting-style]:[transform:translateY(-120%)_scale(0.98)] [&[data-ending-style]:not([data-swipe-direction])]:[transform:translateY(-120%)_scale(0.98)]";

function ForwardToastList() {
  const { toasts } = useToastManager();

  return toasts.map((toastObject) => {
    const showAction = Boolean(toastObject.actionProps?.children);
    const showClose = toastObject.data?.hasClose === true;
    const isSuccess = toastObject.data?.intent === "success";

    return (
      <ToastRoot
        key={toastObject.id}
        layout="stacked"
        toast={toastObject}
        swipeDirection={["up", "right"]}
        className={TOP_STACKED_TOAST_CLASS}
      >
        <ToastContent className="grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0">
          <ToastBody className="min-w-0 flex-1 text-left">
            <ToastTitle className={`whitespace-normal break-words text-left ${isSuccess ? "text-sm font-medium leading-5" : ""}`} />
          </ToastBody>
          {showAction || showClose ? (
            <ToastActions className="col-span-1 col-start-2 row-start-1 w-auto shrink-0 justify-self-end">
              {showClose ? <ToastClose /> : null}
              {showAction ? (
                <ToastAction className="border-0 bg-transparent px-0 py-1 text-xs font-medium text-black/55 shadow-none transition-colors hover:border-transparent hover:bg-transparent hover:text-black hover:no-underline hover:shadow-none hover:translate-x-0 hover:translate-y-0" />
              ) : null}
            </ToastActions>
          ) : null}
        </ToastContent>
      </ToastRoot>
    );
  });
}

export function ForwardToastProvider({ children }: PropsWithChildren) {
  return (
    <ToastProvider
      limit={3}
      renderViewport={false}
      toastManager={forwardToastManager}
      timeout={5000}
    >
      {children}
      <ToastPortal>
        <ToastViewport
          className="forward-toast-viewport flex h-[var(--toast-frontmost-height)] w-[min(24rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] flex-col items-stretch gap-2"
          placement="top-center"
        >
          <ForwardToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  );
}
