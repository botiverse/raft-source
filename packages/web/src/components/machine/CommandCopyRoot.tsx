import { CopyableCodeRoot } from "@botiverse/raft-ui";
import { useCallback } from "react";
import type { ReactNode } from "react";
import type { CommandCopyTarget } from "../../features/computer/machineDetailTypes";

export function CommandCopyRoot({
  target,
  copied,
  onCopy,
  children,
}: {
  target: CommandCopyTarget;
  copied: boolean;
  onCopy: (target: CommandCopyTarget) => void;
  children: ReactNode;
}) {
  const handleCopy = useCallback(() => onCopy(target), [onCopy, target]);
  return (
    <CopyableCodeRoot copied={copied} onCopy={handleCopy}>
      {children}
    </CopyableCodeRoot>
  );
}
