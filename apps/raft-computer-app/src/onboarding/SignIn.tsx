import React, { useState } from "react";
import { RaftMark, Button } from "./ui.js";

export function SignIn({ onSignIn }: { onSignIn: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);

  const handleClick = () => {
    setBusy(true);
    void onSignIn().catch(() => setBusy(false));
  };

  return (
    <div className="onb-card onb-card--center">
      <RaftMark size={48} />
      <div style={{ height: 20 }} />
      <h1 className="onb-title" style={{ fontSize: 20 }}>
        Sign in to Raft Desktop
      </h1>
      <p className="onb-desc">
        Connect this computer to your Raft workspace so your agents can run
        here.
      </p>
      <div className="onb-spacer" />
      <Button onClick={handleClick} disabled={busy}>
        {busy ? "Opening browser..." : "Sign in"}
      </Button>
    </div>
  );
}
