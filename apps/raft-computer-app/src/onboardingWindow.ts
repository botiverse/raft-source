import { BrowserWindow } from "electron";
import { join } from "node:path";

let onboardingWindow: BrowserWindow | null = null;
let onboardingTarget: OnboardingTarget | null = null;

export interface OnboardingTarget {
  serverId: string;
  serverLabel?: string | null;
}

export function getOnboardingWindow(): BrowserWindow | null {
  return onboardingWindow;
}

export function getOnboardingTarget(): OnboardingTarget | null {
  return onboardingTarget;
}

export function createOnboardingWindow(distDir: string, target?: OnboardingTarget): BrowserWindow {
  onboardingTarget = target ?? null;
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    onboardingWindow.webContents.send("onboarding:target-changed", onboardingTarget);
    return onboardingWindow;
  }

  onboardingWindow = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: "hiddenInset",
    roundedCorners: false,
    show: false,
    webPreferences: {
      preload: join(distDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  onboardingWindow.loadFile(join(distDir, "onboarding.html"));
  onboardingWindow.once("ready-to-show", () => {
    onboardingWindow?.show();
  });
  onboardingWindow.on("closed", () => {
    onboardingWindow = null;
    onboardingTarget = null;
  });

  return onboardingWindow;
}
