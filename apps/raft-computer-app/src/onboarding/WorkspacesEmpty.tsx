import React from "react";
import { RaftMark, Button, TextLink } from "./ui.js";

export function WorkspacesEmpty({
  reason,
  onOpenRaft,
  onRefresh,
}: {
  reason: "no-servers" | "all-connected";
  onOpenRaft: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="onb-card onb-card--center">
      <RaftMark size={36} />
      <div style={{ height: 16 }} />
      {reason === "all-connected" ? (
        <>
          <h1 className="onb-title">All your servers are already connected</h1>
          <p className="onb-desc">
            Every server you have access to is already connected to this
            Computer. Open Raft to manage your servers.
          </p>
        </>
      ) : (
        <>
          <h1 className="onb-title">No servers yet</h1>
          <p className="onb-desc">
            Create or join a server in Raft, then come back here.
          </p>
        </>
      )}
      <div className="onb-spacer" />
      <Button onClick={onOpenRaft}>
        {reason === "all-connected" ? "Open servers" : "Open Raft in browser"}
      </Button>
      <TextLink onClick={onRefresh}>Refresh</TextLink>
    </div>
  );
}
