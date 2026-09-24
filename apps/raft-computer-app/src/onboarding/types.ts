export interface WorkspaceEntry {
  id: string;
  name: string;
  slug: string;
  role: string;
  attachable: boolean;
  alreadyAttached: boolean;
}

export interface OnboardingTarget {
  serverId: string;
  serverLabel?: string | null;
}

export type OnboardingStep =
  | { step: "loading" }
  | { step: "sign-in" }
  | { step: "sign-in-waiting"; verifyUrl: string; userCode: string }
  | { step: "workspaces-loading" }
  | { step: "workspaces"; workspaces: WorkspaceEntry[]; selected: string | null }
  | { step: "workspaces-empty"; reason: "no-servers" | "all-connected" }
  | { step: "connecting"; workspaceName: string; workspaceSlug: string }
  | { step: "bringing-online"; workspaceName: string; workspaceSlug: string; serverId: string; machineId: string | null }
  | { step: "verifying"; workspaceName: string; workspaceSlug: string; serverId: string; machineId: string | null }
  | { step: "success"; workspaceName: string; workspaceSlug: string; machineId: string | null; canConnectMore: boolean }
  | {
      step: "recovery";
      failedStep: "sign-in" | "connect" | "bring-online";
      message: string;
      errorCode?: string;
      actionId: string;
      workspaceName?: string;
      workspaceSlug?: string;
      serverId?: string;
    };

export interface OnboardingApi {
  isLoggedIn(): Promise<boolean>;
  login(): Promise<{ userId: string }>;
  listWorkspaces(): Promise<
    | {
        status: "success";
        workspaces: WorkspaceEntry[];
      }
    | { status: "not_logged_in" }
    | { status: "error"; code: string }
  >;
  attach(serverSlug: string): Promise<{ serverId: string; serverSlug: string; machineId: string | null }>;
  startService(target?: OnboardingTarget): Promise<void>;
  getStatus(): Promise<{
    loggedIn: boolean;
    servers: Array<{
      serverId: string;
      serverSlug: string | null;
      health: string;
      serverConnected: boolean;
      machineId: string | null;
    }>;
  }>;
  getDashboardUrl(): Promise<string>;
  getInitialTarget(): Promise<OnboardingTarget | null>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  onEvent(
    callback: (event: { kind: string; [key: string]: unknown }) => void,
  ): () => void;
  onTargetChanged(callback: (target: OnboardingTarget | null) => void): () => void;
  closeWindow(): void;
}

declare global {
  interface Window {
    onboardingApi: OnboardingApi;
  }
}
