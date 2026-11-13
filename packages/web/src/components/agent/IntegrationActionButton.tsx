import { useCallback } from "react";
import type { ReactNode } from "react";
import { Button } from "@botiverse/raft-ui";
import type { MessageId } from "../../i18n/messages";

/** One approve / deny / revoke button: posts `path` with `body` through the tab's shared `onAct`. */
export function IntegrationActionButton({
  path,
  body,
  failureMessageId,
  onAct,
  variant,
  children,
}: {
  path: string;
  body: unknown;
  failureMessageId: MessageId;
  onAct: (path: string, body: unknown, failureMessageId: MessageId) => void;
  variant?: "outline";
  children: ReactNode;
}) {
  const handleClick = useCallback(() => onAct(path, body, failureMessageId), [onAct, path, body, failureMessageId]);
  return (
    <Button variant={variant} size="md" onClick={handleClick}>
      {children}
    </Button>
  );
}
