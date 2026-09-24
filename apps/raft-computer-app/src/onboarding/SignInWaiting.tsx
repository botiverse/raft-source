import React from "react";
import { RaftMark, TextLink } from "./ui.js";

export function SignInWaiting({
  userCode,
  onOpenBrowser,
}: {
  userCode: string;
  onOpenBrowser: () => void;
}) {
  return (
    <div className="onb-card onb-card--center">
      <RaftMark size={48} />
      <div style={{ height: 20 }} />
      <h1 className="onb-title" style={{ fontSize: 20 }}>
        Complete sign-in in your browser
      </h1>
      <p className="onb-desc">
        We opened your browser to finish signing in.
        {userCode && (
          <>
            {" "}If asked for a code: <code className="onb-code">{userCode}</code>
          </>
        )}
      </p>
      <div className="onb-spacer" />
      <TextLink onClick={onOpenBrowser}>Open browser again</TextLink>
    </div>
  );
}
