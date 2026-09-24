import React from "react";
import { RaftMark, Button, TextLink } from "./ui.js";

export function Success({
  workspaceName,
  onOpenWorkspace,
  onConnectMore,
  onDone,
}: {
  workspaceName: string;
  onOpenWorkspace: () => void;
  onConnectMore?: () => void;
  onDone: () => void;
}) {
  return (
    <div className="onb-card onb-card--center">
      <RaftMark size={48} />
      <div style={{ height: 16 }} />
      <h1 className="onb-title" style={{ fontSize: 18 }}>
        This Computer is online
      </h1>
      <p className="onb-desc">
        Go back to {workspaceName} to create or manage agents that can use this
        Computer.
      </p>
      <div className="onb-spacer" />
      <Button variant="dark" onClick={onOpenWorkspace}>
        Open workspace
      </Button>
      {onConnectMore && (
        <TextLink onClick={onConnectMore}>Connect another server</TextLink>
      )}
      <TextLink onClick={onDone}>Done</TextLink>
    </div>
  );
}
