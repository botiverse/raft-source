// Native application menu. A real Mac app has a full menu with working
// Edit/View/Window roles and app-level shortcuts; without it even Cmd+C in a
// web input can be unreliable and the app "feels like a webpage".

import { Menu, app, shell } from "electron";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";

export interface AppMenuActions {
  openAbout(): void;
  checkForUpdates(): void;
  reload(): void;
  zoom(direction: "in" | "out" | "reset"): void;
  focusedServerWindow(): BrowserWindow | null;
}

export function installApplicationMenu(actions: AppMenuActions): void {
  const appName = app.getName();

  const template: MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        { label: `About ${appName}`, click: () => actions.openAbout() },
        { label: "Check for Updates…", click: () => actions.checkForUpdates() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => actions.reload(),
        },
        { type: "separator" },
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: () => actions.zoom("reset"),
        },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+Plus",
          click: () => actions.zoom("in"),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: () => actions.zoom("out"),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
        {
          label: "Toggle Developer Tools",
          accelerator: "Alt+CmdOrCtrl+I",
          click: () => actions.focusedServerWindow()?.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: "Window",
      role: "windowMenu",
    },
    {
      role: "help",
      submenu: [
        {
          label: "Raft Help",
          click: () => void shell.openExternal("https://raft.build"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
