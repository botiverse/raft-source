import { contextBridge, ipcRenderer } from "electron";

export interface OnboardingApi {
  isLoggedIn(): Promise<boolean>;
  login(): Promise<{ userId: string }>;
  listWorkspaces(): Promise<
    | { status: "success"; workspaces: Array<{ id: string; name: string; slug: string; role: string; attachable: boolean; alreadyAttached: boolean }> }
    | { status: "not_logged_in" }
    | { status: "error"; code: string }
  >;
  attach(serverSlug: string): Promise<{ serverId: string; serverSlug: string; machineId: string | null }>;
  startService(target?: { serverId: string; serverLabel?: string | null }): Promise<void>;
  getStatus(): Promise<{
    loggedIn: boolean;
    servers: Array<{ serverId: string; serverSlug: string | null; health: string; serverConnected: boolean; machineId: string | null }>;
  }>;
  getDashboardUrl(): Promise<string>;
  getInitialTarget(): Promise<{ serverId: string; serverLabel?: string | null } | null>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  onEvent(callback: (event: { kind: string; [key: string]: unknown }) => void): () => void;
  onTargetChanged(callback: (target: { serverId: string; serverLabel?: string | null } | null) => void): () => void;
  closeWindow(): void;
}

contextBridge.exposeInMainWorld("onboardingApi", {
  isLoggedIn: () => ipcRenderer.invoke("onboarding:is-logged-in"),
  login: () => ipcRenderer.invoke("onboarding:login"),
  listWorkspaces: () => ipcRenderer.invoke("onboarding:list-workspaces"),
  attach: (serverSlug: string) => ipcRenderer.invoke("onboarding:attach", serverSlug),
  startService: (target?: { serverId: string; serverLabel?: string | null }) =>
    ipcRenderer.invoke("onboarding:start-service", target),
  getStatus: () => ipcRenderer.invoke("onboarding:get-status"),
  getDashboardUrl: () => ipcRenderer.invoke("onboarding:get-dashboard-url"),
  getInitialTarget: () => ipcRenderer.invoke("onboarding:get-initial-target"),
  openExternal: (url: string) => ipcRenderer.invoke("onboarding:open-external", url),
  copyText: (text: string) => ipcRenderer.invoke("onboarding:copy-text", text),
  onEvent: (callback: (event: { kind: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { kind: string }) => callback(data);
    ipcRenderer.on("onboarding:event", handler);
    return () => ipcRenderer.removeListener("onboarding:event", handler);
  },
  onTargetChanged: (callback: (target: { serverId: string; serverLabel?: string | null } | null) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      target: { serverId: string; serverLabel?: string | null } | null,
    ) => callback(target);
    ipcRenderer.on("onboarding:target-changed", handler);
    return () => ipcRenderer.removeListener("onboarding:target-changed", handler);
  },
  closeWindow: () => ipcRenderer.send("onboarding:close"),
} satisfies OnboardingApi);
