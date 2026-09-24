// Pure (Electron-free) enable-input contract + validation, so the guard can be
// unit-tested / ablated without loading the Electron-coupled ComputerHost.

export interface EnableComputerInput {
  serverSlug: string;
  serverUrl: string;
  accessToken: string;
  refreshToken: string;
  // Optional display label for the Computer credential; defaults to the machine
  // hostname server-side when omitted.
  name?: string;
  // The signed-in user's identity, persisted into the shared session so local
  // surfaces (ComputerStatusReport.userId/userName/userEmail) match what a
  // device-code login would write — otherwise they read back null.
  userId?: string;
  userEmail?: string;
  userName?: string;
  userDisplayName?: string;
}

// Fix #1 guard: an enable payload must carry non-empty tokens + server before we
// (destructively) write the shared user-session. Without this, a malformed call
// clobbers a working session with a garbage one, THEN attach fails.
export function isValidEnableInput(input: unknown): input is EnableComputerInput {
  const i = input as Partial<EnableComputerInput> | null | undefined;
  return (
    !!i &&
    typeof i.accessToken === "string" && i.accessToken.length > 0 &&
    typeof i.refreshToken === "string" && i.refreshToken.length > 0 &&
    typeof i.serverSlug === "string" && i.serverSlug.length > 0 &&
    typeof i.serverUrl === "string" && i.serverUrl.length > 0
  );
}
