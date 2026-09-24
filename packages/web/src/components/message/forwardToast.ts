import type { ComponentPropsWithRef, ReactNode } from "react";
import { createToastManager } from "raft-ui";

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
