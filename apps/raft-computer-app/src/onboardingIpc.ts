import { clipboard, ipcMain, shell, type BrowserWindow } from "electron";
import {
  type ComputerApi,
  type ComputerApiEvent,
} from "@botiverse/raft-computer/lib";
import { hasValidUserSession } from "./onboardingAuth.js";
import { assertNoLegacyMigrationCandidates } from "./onboardingMigration.js";
import type { OnboardingTarget } from "./onboardingWindow.js";

export function registerOnboardingIpc(
  getApi: () => ComputerApi | null,
  getWindow: () => BrowserWindow | null,
  slockHome: string,
  getDashboardUrl: () => string,
  getInitialTarget: () => OnboardingTarget | null = () => null,
): void {
  ipcMain.handle("onboarding:is-logged-in", async () => {
    return hasValidUserSession(slockHome);
  });

  ipcMain.handle("onboarding:login", async () => {
    const api = getApi();
    if (!api) throw new Error("Computer API not initialized");
    const win = getWindow();
    const sendEvent = (event: ComputerApiEvent) => {
      win?.webContents.send("onboarding:event", event);
    };
    const result = await api.login({}, sendEvent);
    return { userId: result.userId };
  });

  ipcMain.handle("onboarding:list-workspaces", async () => {
    const api = getApi();
    if (!api) throw new Error("Computer API not initialized");
    return api.listWorkspaces();
  });

  ipcMain.handle("onboarding:attach", async (_event, serverSlug: string) => {
    const api = getApi();
    if (!api) throw new Error("Computer API not initialized");
    const win = getWindow();
    const sendEvent = (event: ComputerApiEvent) => {
      win?.webContents.send("onboarding:event", event);
    };
    await assertNoLegacyMigrationCandidates(slockHome, serverSlug);
    const result = await api.attach({ serverSlug }, sendEvent);
    return { serverId: result.serverId, serverSlug: result.serverSlug, machineId: result.machineId ?? null };
  });

  ipcMain.handle("onboarding:start-service", async (_event, target?: { serverId?: string; serverLabel?: string | null }) => {
    const api = getApi();
    if (!api) throw new Error("Computer API not initialized");
    const win = getWindow();
    const sendEvent = (event: ComputerApiEvent) => {
      win?.webContents.send("onboarding:event", event);
    };
    await api.start(
      {
        serverId: target?.serverId ?? null,
        serverLabel: target?.serverLabel ?? null,
      },
      sendEvent,
    );
  });

  ipcMain.handle("onboarding:get-status", async () => {
    const api = getApi();
    if (!api) throw new Error("Computer API not initialized");
    const report = await api.getStatus();
    return {
      loggedIn: report.loggedIn,
      servers: report.servers.map((s) => ({
        serverId: s.serverId,
        serverSlug: s.serverSlug,
        health: s.health,
        serverConnected: s.serverConnected,
        machineId: s.machineId,
      })),
    };
  });

  ipcMain.handle("onboarding:get-dashboard-url", () => {
    return getDashboardUrl();
  });

  ipcMain.handle("onboarding:get-initial-target", () => {
    return getInitialTarget();
  });

  ipcMain.handle("onboarding:open-external", async (_event, url: string) => {
    if (!url.startsWith("https://") && !url.startsWith("http://")) return;
    await shell.openExternal(url);
  });

  ipcMain.handle("onboarding:copy-text", (_event, text: string) => {
    if (typeof text !== "string") return;
    clipboard.writeText(text.slice(0, 20_000));
  });

  ipcMain.on("onboarding:close", () => {
    const win = getWindow();
    win?.close();
  });
}
