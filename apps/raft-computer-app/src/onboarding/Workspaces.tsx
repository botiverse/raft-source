import React from "react";
import type { WorkspaceEntry } from "./types.js";
import { RaftMark, Button, WorkspaceAvatar } from "./ui.js";

export function Workspaces({
  workspaces,
  selected,
  onSelect,
  onConnect,
}: {
  workspaces: WorkspaceEntry[];
  selected: string | null;
  onSelect: (slug: string) => void;
  onConnect: () => void;
}) {
  const eligible = workspaces.filter((w) => w.attachable && !w.alreadyAttached);

  return (
    <div className="onb-card onb-card--center">
      <RaftMark size={48} />
      <div style={{ height: 20 }} />
      <h1 className="onb-title" style={{ fontSize: 20 }}>
        Connect this Computer
      </h1>
      <p className="onb-desc" style={{ marginBottom: 16 }}>
        Pick a server:
      </p>
      <div className="onb-ws-list" style={{ width: "100%", textAlign: "left" }}>
        {eligible.map((ws) => (
          <button
            key={ws.slug}
            className={`onb-ws-row ${selected === ws.slug ? "onb-ws-row--selected" : ""}`}
            onClick={() => onSelect(ws.slug)}
          >
            <WorkspaceAvatar name={ws.name} />
            <span className="onb-ws-name">{ws.name}</span>
            {selected === ws.slug && (
              <span style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>&#10003;</span>
            )}
          </button>
        ))}
      </div>
      <div className="onb-spacer" />
      <Button onClick={onConnect} disabled={!selected}>
        Connect this Computer
      </Button>
    </div>
  );
}
