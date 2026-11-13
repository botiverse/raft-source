import type { ComponentPropsWithRef, ReactNode } from "react";
import { createToastManager } from "@botiverse/raft-ui";
import { toastTimeout } from "../toastBridge";

export const forwardToastManager = createToastManager();

type ForwardToastOptions = {
  action?: {
    label: ReactNode;
    onClick?: ComponentPropsWithRef<"button">["onClick"];
  };
  dismissible?: boolean;
};

function addForwardToast(
  intent: "info" | "success" | "warning" | "error",
  title: string,
  options: ForwardToastOptions = {},
) {
  return forwardToastManager.add({
    actionProps: options.action
      ? { children: options.action.label, onClick: options.action.onClick }
      : undefined,
    // 8s with an action or as an error, 5s (the provider's) otherwise.
    timeout: toastTimeout({ hasAction: Boolean(options.action), type: intent }),
    title,
    type: intent,
    priority: intent === "error" ? "high" : undefined,
    data: {
      intent,
      hasClose: options.dismissible ?? false,
      hasIcon: false,
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
