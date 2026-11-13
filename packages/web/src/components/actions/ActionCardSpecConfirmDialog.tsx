import type { ReactNode } from "react";
import type { ActionCardSpecMsg } from "@botiverse/raft-shared";
import ConfirmDialog from "../ConfirmDialog";
import { useActionCardMsgText } from "./ActionCardSpecRenderer";

/**
 * The spec card's generic confirm: the server's title, body and verb; red only
 * for a destructive execute. An action that grants permissions has its own
 * dialog instead (useActionCardNativeConfirm).
 */
export function ActionCardSpecConfirmDialog({ title, confirmLabel, destructive, onConfirm, onClose, children }: {
  title: ActionCardSpecMsg;
  confirmLabel: ActionCardSpecMsg;
  destructive: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  children: ReactNode;
}) {
  // The dialog's title and button take text: entity params as plain names.
  return (
    <ConfirmDialog
      title={useActionCardMsgText(title)}
      confirmLabel={useActionCardMsgText(confirmLabel)}
      confirmVariant={destructive ? "danger" : "primary"}
      plainMessage
      message={children}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
