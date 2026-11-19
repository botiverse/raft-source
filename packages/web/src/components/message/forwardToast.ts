import { showToast } from "../toastBridge";

type ForwardToastOptions = {
  action?: {
    label: string;
    onClick?: () => void;
  };
  dismissible?: boolean;
};

/**
 * The Forward flow's, the desktop sign-in's and the desktop notices' toasts
 * (desktopNotice). They are the app's toasts (LocalizedToastProvider), at
 * the one place every toast takes, the bottom center above the composer
 * (Raft DS › Toast › Where it appears): they used to have a viewport of their
 * own at the top center, over the search bar (cindyz, 2026-11-14).
 */
function addForwardToast(
  intent: "info" | "success" | "warning" | "error",
  title: string,
  options: ForwardToastOptions = {},
) {
  return showToast({
    actionProps: options.action
      ? { children: options.action.label, onClick: () => options.action?.onClick?.() }
      : undefined,
    title,
    type: intent,
    priority: intent === "error" ? "high" : undefined,
    data: {
      intent,
      hasClose: options.dismissible ?? false,
    },
  });
}

export const forwardToast = {
  info(title: string, options?: ForwardToastOptions) {
    return addForwardToast("info", title, options);
  },
  success(title: string, options?: ForwardToastOptions) {
    return addForwardToast("success", title, options);
  },
  warning(title: string, options?: ForwardToastOptions) {
    return addForwardToast("warning", title, options);
  },
  error(title: string, options?: ForwardToastOptions) {
    return addForwardToast("error", title, options);
  },
};
