// The shape of `window.raftDesktop`: what Raft Desktop's preload
// (apps/desktop/src/app/preload.ts) exposes to the web app it runs, through
// contextBridge. The preload declares its object with `satisfies
// RaftDesktopBridge`, and the web reads it through one typed accessor
// (packages/web src/utils/desktopBridge.ts), so a renamed or reshaped
// capability is a type error on both sides instead of a silent no-op.
//
// Types only: no runtime, so the preload (sandboxed) and the web share it
// without either loading the other's code. Every value crosses the
// contextBridge structured clone: plain data, functions and promises only.

import type { DesktopNotificationKind } from "./desktopNotifications";

/** The window's visibility and the user's presence, as the shell sees them. */
export interface DesktopWindowActivity {
  revision: number;
  visible: boolean;
  minimized: boolean;
  focused: boolean;
  /**
   * No keyboard/mouse input for ACTIVE_INPUT_WINDOW_MS (AWAY_AFTER_IDLE_SECONDS
   * in the shell; 10 minutes in shells before the computer-active protocol),
   * or the screen is locked.
   */
  away: boolean;
  /**
   * The screen is locked (powerMonitor lock / unlock and the idle state).
   * Absent in older shells: the web then reads `away` as possibly locked.
   */
  locked?: boolean;
  /**
   * Epoch ms of the last system-wide keyboard/mouse input, sampled by the
   * shell whatever window has focus. Absent or null when unknown. Only the
   * presence report (phone alert routing) reads it.
   */
  lastInputAt?: number | null;
}

/**
 * The machine woke from sleep (powerMonitor `resume`) or the screen was
 * unlocked (`unlock-screen`). A closed window only hides, so the page may see
 * no focus or visibilitychange: the web reconnects and re-reads on this.
 */
export interface DesktopSystemResume {
  reason: "resume" | "unlock-screen";
}

/**
 * How the shell draws the title bar. "overlay": the window controls (macOS
 * traffic lights, Windows/Linux caption buttons) are laid over the page's top
 * row under the Window Controls Overlay (navigator.windowControlsOverlay, CSS
 * env(titlebar-area-*)); "native": the window manager's own frame (Linux opt-out).
 */
export type DesktopTitleBarMode = "overlay" | "native";

/** How the shell opened this window (preload, read synchronously at boot). */
export interface DesktopLaunchInfo {
  /**
   * The in-app route (pathname + search) the window's first load reopened
   * after an update restart, or null for a normal launch. That load arrives
   * with no referrer like a link from outside, but the person was already
   * there: the web treats it like a reload, not a message-link landing.
   */
  resumedRoute: string | null;
}

/** The caption-button overlay's colours (#rrggbb). */
export interface DesktopTitleBarOverlayColors {
  color: string;
  symbolColor: string;
}

/** What the web reports for the window controls: the top bar's colours and height (CSS px). */
export interface DesktopTitleBarOverlay extends DesktopTitleBarOverlayColors {
  height?: number;
}

export interface DesktopServerMenuEntry {
  id: string;
  name: string;
}

/** The servers the native Server menu names (switcher order) and the current one. */
export interface DesktopServerMenuState {
  servers: DesktopServerMenuEntry[];
  currentId: string | null;
}

/** ⌘1…⌘9 picks a server; ⌘⇧[ / ⌘⇧] steps through them. */
export type DesktopServerSwitchRequest = { serverId: string } | { delta: -1 | 1 };

/**
 * A native input the web cannot receive itself, translated by the shell into
 * what the user asked for; the web executes it. Main sends every native entry
 * point through the one `commands` channel:
 * - history: the History menu (⌘[ ⌘] / Alt+← →), a macOS swipe, a Windows /
 *   Linux mouse side button or media key (`app-command`)
 * - open-settings: the app menu's Settings… (⌘,)
 * - switch-server: the Server menu (⌘1…⌘9 by id, ⌘⇧[ ⌘⇧] by delta)
 * - open-route: a raft:// link or a notification click; main has already
 *   checked the path against DESKTOP_DEEP_LINK_ROUTE_PREFIXES (desktopRoutes.ts)
 */
export type HostCommand =
  | { type: "history"; direction: "back" | "forward" }
  | { type: "open-settings" }
  | ({ type: "switch-server" } & DesktopServerSwitchRequest)
  | { type: "open-route"; path: string }
  // The tray menu's Pause notifications ▸ (Windows / Linux): the web PATCHes
  // the account pausedUntil. `tomorrow` = next 09:00 local time.
  | { type: "pause-notifications"; minutes: number | "tomorrow" }
  // The tray / Dock menu's "Open This Device…", Help › "Raft Computer
  // Troubleshooting…" and a Computer notification's click: the web opens this
  // machine's Computer panel (on the current server), with that section open.
  | { type: "open-this-device"; section?: DesktopThisDeviceSection };

/** A section of the This device panel a host command opens. */
export type DesktopThisDeviceSection = "troubleshoot";

/** Facts about the shell the preload knows synchronously, before the web renders. */
export interface DesktopHostFacts {
  /** The shell opens a second in-app window or tab for window.open (Raft Desktop: no, it has none). */
  canOpenNewWindow: boolean;
}

/** An OS notification the renderer asks the shell to post (the shell validates it). */
export interface DesktopNotificationRequest {
  /** Dedupe id, the same for both sources (`message:<messageId>`). */
  id: string;
  kind: DesktopNotificationKind;
  /** macOS title. Plain text. */
  title: string;
  /** macOS subtitle (usually the server name). Windows/Linux fold it into the title. */
  subtitle?: string;
  body: string;
  /** Windows group header (the server name). */
  groupTitle?: string;
  /** `<serverId>:<conversationId>`: macOS threadIdentifier / Windows Group. */
  groupKey: string;
  /** Replace a visible notification with the same key (task status bursts). */
  replaceKey?: string;
  /** In-app route opened on click (`/s/<slug>/...`). */
  route: string;
  /** Personally addressed: never folded into a burst. */
  mentioned: boolean;
  source: "local" | "server";
  /** The account sound setting is off. Older shells ignore it. */
  silent?: boolean;
  /** Source message seq in the group; clearGroup(groupKey, throughSeq) closes only seq <= throughSeq. */
  seq?: number | null;
  /** Answers POST /notifications/test: the shell resolves show() once the OS showed it (or failed). */
  testId?: string;
  /**
   * A user-initiated test notification: skips the shell's throttle (burst
   * coalescing and rate limit) only, so the result is truthful. Everything
   * else (validation, dedupe, display) is the same path.
   */
  test?: boolean;
}

/** What show() reports (shells from the unified notifications on; older ones return undefined). */
export interface DesktopNotificationShowResult {
  shown: boolean;
  /** Why it was not shown: invalid, duplicate, unsupported, failed, throttled, timeout (no OS confirmation within 10 s). */
  reason?: string;
}

/** An update of the local Computer, as its service records it. */
export interface DesktopComputerUpgrade {
  phase: string;
  percent: number | null;
  outcome: unknown | null;
  targetVersion: string;
  updatedAt?: string;
}

/** The local Computer's status (secret-free): the fields the web reads. */
export interface DesktopComputerStatus {
  /** The servers this machine is attached to; machineId is its id there. */
  servers?: { serverId: string; serverSlug: string | null; machineId?: string | null }[];
  service?: { running: boolean; version?: { version?: string | null } | null };
  upgrade?: DesktopComputerUpgrade | null;
}

/** Attach with a single-use `dvat_*` attach token (device-auth design v2 §3.3). */
export interface DesktopComputerEnableWithTokenInput {
  serverSlug: string;
  /** The server the token was approved for. */
  serverId: string;
  serverUrl: string;
  attachToken: string;
}

/** What the device-flow authorize carries about this machine. */
export interface DesktopComputerAttachGrantRequest {
  machineName: string;
  hostname: string;
  os: string;
}

/** A secret-free identity of the app's own web session (user, session family, SHA-256 of the refresh token). */
export interface DesktopOwnSessionIdentity {
  userId: string;
  sessionFamilyId: string | null;
  refreshTokenSha256: string;
}

/**
 * The one official Raft Computer on this machine, as Raft Desktop sees it.
 * Desktop does not embed Computer: it drives the install the official
 * installer made (`~/.local/bin/raft-computer`) through its CLI.
 */
export interface DesktopComputerHostState {
  /** The official install is present. */
  installed: boolean;
  /** Its version (`raft-computer --version`), when installed. */
  version: string | null;
  /**
   * What the installed Computer reports it can do (`status --json`
   * capabilities, COMPUTER_CLI_CAPABILITIES); [] for one too old to say, null
   * when not installed or not read yet. A feature that needs a missing one
   * says "Update Raft Computer to use …"; start / stop / restart always work.
   */
  capabilities: string[] | null;
  /** The installer supports this OS and architecture (Add This Mac can install it). */
  installSupported: boolean;
  /**
   * How it comes back after a restart: "login-item": Raft Desktop opens at
   * login (its login item) and starts it; "app-open": when Raft Desktop is
   * opened (no login item on this platform, or it is turned off).
   */
  startsWith: "login-item" | "app-open";
  /** Stopped from Raft Desktop: Desktop does not start it when it opens. */
  stoppedByUser: boolean;
  /** An update started from here is running (Computer's own `upgrade`). */
  updating: boolean;
  /**
   * The operation on the Computer running now (one at a time: the move, an
   * install, an update, Add This Mac, start / restart); null when idle.
   * Absent from an older Raft Desktop.
   */
  operation?: "migration" | "install" | "update" | "attach" | "start" | "restart" | null;
  /** The one-time move from an older Desktop's embedded Computer to the official install. */
  migration:
    | { state: "none" }
    | { state: "running"; step: string }
    | { state: "failed"; step: string; code: string; message: string };
  /**
   * Finished attempts of the move whose product event
   * (`desktop_computer_migration_finished`) has not reached the server and
   * that no window holds a lease on now (claimMigrationReports). Absent from
   * an older Raft Desktop.
   */
  migrationReportsPending?: number;
  /**
   * Installed, but `--version` or `status --json` failed: the secret-free
   * reason (null when it read fine, or nothing is installed). Its presence
   * also says this Raft Desktop runs diagnostics (`doctor --json`) and
   * Repair while what the Computer can do is unknown. Absent from an older
   * Raft Desktop.
   */
  readError?: string | null;
  /**
   * Nothing is installed at the official location, yet the Computer home
   * holds server attachments (and no K slots): an older Raft Desktop's
   * embedded Computer that never moved (Windows, Linux). Install then
   * finishes the move (asked, never automatic). Absent from an older Raft
   * Desktop.
   */
  leftoverAttachments?: boolean;
}

/**
 * One finished attempt of the move, as Desktop recorded it for the product
 * event `desktop_computer_migration_finished`: its properties only (closed
 * lists, versions and bounded integers). The web checks them against the
 * registry again before sending.
 */
export interface DesktopComputerMigrationReport {
  event: "desktop_computer_migration_finished";
  properties: Record<string, string | number>;
}

/**
 * The reports one claim leases to one window: no other window gets them
 * until the lease expires (or Desktop restarts). The window acks each one
 * once a batch with it was accepted; an unacked one is claimable again.
 */
export interface DesktopComputerMigrationLease {
  leaseId: string;
  reports: DesktopComputerMigrationReport[];
}

/** One step of Add This Mac as it happens: install (when missing or too old) → attach → start. */
export interface DesktopComputerEnableProgress {
  step: "install" | "attach" | "start";
  state: "active" | "done" | "failed" | "skipped";
  /** install done: the version installed (or already there). */
  version?: string;
  /** failed: the error code (secret-free), as the bridge rejects with. */
  error?: string;
}

/** Agent turns running on this machine's Computer now. */
export interface DesktopComputerTurnActivity {
  /** Agents in the middle of a turn. */
  busyAgents: number;
  /** Some server's runner could not report: there may be more. */
  unknown?: boolean;
}

/** What "Stop" (wait for the current turns) did. */
export type DesktopComputerStopWhenIdleResult = { outcome: "stopped" } | { outcome: "cancelled" };

/** One line of the diagnostics report (secret-redacted). */
export interface DesktopComputerDiagnosticsCheck {
  name: string;
  ok: boolean;
  /** Raw, secret-redacted detail: shown only under "Technical details". */
  detail: string;
  /** A heading line, not a check. */
  section?: boolean;
}

/** What "Run Diagnostics" found (`raft-computer doctor --json`), local only. */
export interface DesktopComputerDiagnosticsReport {
  checks: DesktopComputerDiagnosticsCheck[];
  allOk: boolean;
  /** A cleanup ran: how many leftovers it removed. */
  cleaned?: { removed: number } | null;
  /** The installed Computer's version. */
  installedVersion: string | null;
  ranAt: string;
}

/** This app drives the machine's official Raft Computer: its status and operations. */
export interface DesktopComputerBridge {
  /** A host-capable build. */
  hostCapable: boolean;
  /** The OS hostname, to match this machine to its row when no attachment names it. */
  getLocalInfo(): Promise<{ hostname: string }>;
  /** null: not installed, or its status could not be read. */
  getStatus(): Promise<DesktopComputerStatus | null>;
  /** Pushed on the shell's poll. Returns unsubscribe. */
  onStatus(handler: (status: DesktopComputerStatus | null) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  // Optional: absent on shells before this model, where the web hides what each drives.
  getHostState?(): Promise<DesktopComputerHostState>;
  /** Pushed when the host state changes. Returns unsubscribe. */
  onHostState?(handler: (state: DesktopComputerHostState) => void): () => void;
  /** Install the official Computer when it is missing or older than the minimum (progress: the install step). */
  ensureInstalled?(): Promise<{ version: string }>;
  /** What the device-flow authorize asks approval for (the installed Computer answers). */
  getAttachGrantRequest?(): Promise<DesktopComputerAttachGrantRequest>;
  /** Attach with a one-time attach token, then start it (progress: attach, start). */
  enableWithToken?(input: DesktopComputerEnableWithTokenInput): Promise<unknown>;
  /** Add This Mac's steps as they happen. Returns unsubscribe. */
  onEnableProgress?(handler: (progress: DesktopComputerEnableProgress) => void): () => void;
  /** Delete a user-session.json an older Desktop copied from this session. */
  forgetOwnSessionCopy?(identity: DesktopOwnSessionIdentity): Promise<unknown>;
  /** Agent turns running now (null: cannot tell). */
  getTurnActivity?(): Promise<DesktopComputerTurnActivity | null>;
  /** Stop once the current agent turns finish (stop() stops now; cancelStopWhenIdle gives up waiting). */
  stopWhenIdle?(): Promise<DesktopComputerStopWhenIdleResult>;
  cancelStopWhenIdle?(): Promise<void>;
  /** Leave one server (`raft-computer detach`: revoked there, removed here). */
  detach?(serverId: string): Promise<void>;
  /** Run `raft-computer doctor` here (nothing is uploaded). */
  runDiagnostics?(options?: { cleanup?: boolean }): Promise<DesktopComputerDiagnosticsReport>;
  /** Raft Computer's log folder. */
  openComputerLogs?(): Promise<void>;
  /** Raft Desktop's own log folder. */
  openDesktopLogs?(): Promise<void>;
  /**
   * Computer's own update path (`raft-computer upgrade`); a Computer whose
   * status cannot be read is repaired with the bundled installer. Nothing
   * installed: installs it, and starts it when it is attached somewhere;
   * with leftoverAttachments, finishes the move from the embedded Computer.
   */
  updateComputer?(): Promise<void>;
  /** Retry a failed move from the embedded Computer (resumes where it stopped). */
  retryMigration?(): Promise<void>;
  /**
   * Lease the move's unsent reports (DesktopComputerHostState.migrationReportsPending)
   * to this window: while the lease lasts no other window gets them.
   */
  claimMigrationReports?(): Promise<DesktopComputerMigrationLease>;
  /** These reports (their `report_id`) reached the server: they are never sent again. */
  ackMigrationReports?(leaseId: string, reportIds: string[]): Promise<void>;
}

/** The app's own update, as the shell reports it. */
export type DesktopAppUpdateStatus = (
  | { state: "unsupported" }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "none" }
  | { state: "downloading"; percent: number }
  /** macOS: downloaded, Squirrel is staging it in the background. */
  | { state: "staging"; version: string }
  | { state: "downloaded"; version: string; checkFailed?: boolean }
  /** "Restart to Update" was chosen: waiting for the download, preparing, or restarting. */
  | { state: "installing"; version: string; phase?: "waiting" | "preparing" | "restarting"; startedAt?: number; percent?: number }
  | { state: "error"; message: string; during?: "check" | "download" }
) & { required?: { minimum: string; running: string } };

export type DesktopStartupMark = "renderer-mounted" | "session-authenticated" | "workspace-ready";

/**
 * The loopback for desktop sign-in and account linking (RFC 8252 §7.3). The web
 * owns the flow — PKCE verifier and challenge, the `state`, the server's
 * /auth/mobile/oauth/* calls and the token exchange; the shell only receives
 * one HTTP callback on 127.0.0.1 and brings the window forward when it lands.
 * One attempt at a time; every call is scoped to its attempt id and to the
 * renderer that began it.
 */
export interface DesktopAuthBridge {
  /**
   * Bind 127.0.0.1 on a free port for one attempt. `state` ([A-Za-z0-9_-]{16,256})
   * travels in the redirect URI's fragment; the callback is accepted only with it.
   * Supersedes an earlier attempt.
   */
  beginLoopback(request: { state: string }): Promise<{ attemptId: string; redirectUri: string }>;
  /**
   * Open the provider's authorization URL in the system browser. Rejects (and
   * ends the attempt) unless it is an https URL on a sign-in provider's host.
   */
  openAuthorizationUrl(attemptId: string, authorizationUrl: string): Promise<void>;
  /**
   * Resolves with the one-time code and the state once the browser comes back.
   * Rejects on cancel, timeout (default and maximum 5 minutes) or a superseding
   * attempt, and with `oauth_provider_error:<reason>` when the provider leg failed.
   */
  awaitCallback(attemptId: string, options?: { timeoutMs?: number }): Promise<{ code: string; state: string }>;
  cancel(attemptId: string): void;
  /**
   * Passkey sign-in through the app-login handoff (server routes/appLogin.ts,
   * client `raft-desktop`): bind 127.0.0.1 on a free port for one attempt and
   * return `returnUri`, exactly `http://127.0.0.1:<port>/callback` (the
   * server's loopback rule: that path, no query, no fragment). The browser
   * comes back with a GET `/callback?requestId=…&code=…` (or `&error=…`).
   * Shares the one-attempt slot with beginLoopback; awaitCallback and cancel
   * work on it, awaitCallback resolving `{ code, state }` with `state` = the
   * callback's requestId, and rejecting with `oauth_provider_error:<error>`
   * on an error callback (`expired`, `access_denied`); for this attempt it
   * waits up to 10 minutes (the server request's lifetime). Absent on shells
   * without it: the web then offers no passkey sign-in in Desktop.
   */
  beginAppLoginLoopback?(): Promise<{ attemptId: string; returnUri: string }>;
  /**
   * Open the app-login confirm page in the system browser and accept the
   * attempt's callback only for `requestId`. Rejects (and ends the attempt)
   * unless `loginUrl` is https on the Raft app's host, path `/login/app`,
   * with `request=<requestId>` (and optionally `method=passkey`).
   */
  openAppLoginUrl?(attemptId: string, request: { requestId: string; loginUrl: string }): Promise<void>;
}

/**
 * Where the web preview's native view sits: the web panel's placeholder box
 * in CSS px, relative to the window's content (getBoundingClientRect). The
 * shell converts it to DIP with the page's zoom.
 */
export interface DesktopWebPreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The native view's page, as the shell reports it after every navigation, title or loading change. */
export interface DesktopWebPreviewState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

/**
 * What a tab's page asked for and the shell refused (packages/shared
 * linkRouter.ts: a page-initiated action is never dropped without a word):
 * - `raft`: a navigation to one of Raft's own pages (they open in the app);
 * - `raft-sign-in`: the same, for Raft's sign-in for another site
 *   (isRaftAuthorizeUrl), and a sign-in the app took and Raft's server then
 *   refused (`url` is then the tab's own page, never the address asked for);
 * - `scheme`: a link another application opens (mailto:, tel:, a custom
 *   protocol);
 * - `popup`: a window with no address of its own (window.open() then a
 *   script fills it), which the built-in browser has no place for yet.
 * - `download`: a file the page started to download, which the built-in
 *   browser does not save itself: the shell hands its address to the system
 *   browser, and the tab says so (`file`: its name, when the page gave one),
 *   so a click on a download is never answered by nothing
 *   (#proj-workspace:#292). A shell before it said nothing, and a web before
 *   it shows nothing for it (an unknown reason is no notice).
 * Or what the shell refused the tab itself:
 * - `storage`: no page is made for the tab (`url` is the address it would
 *   show), because the browser's saved site data could not be cleared for
 *   the account signed in; said on a tab that has no page.
 * - `media-system`: the person allowed the site the microphone or camera
 *   (`media`: which), but the operating system has not given Raft itself
 *   access (macOS System Settings > Privacy & Security): the page was told
 *   no. A web before it shows nothing for it.
 * `at` tells one refusal from the next (the web keeps a dismissal by it).
 */
export interface DesktopWebPreviewBlocked {
  url: string;
  reason: "raft" | "raft-sign-in" | "scheme" | "popup" | "storage" | "download" | "media-system";
  /** A download's file name (`download` only), at most 200 characters, when the page named one. */
  file?: string;
  /** What the system refused (`media-system` only). */
  media?: DesktopWebPreviewMediaKind[];
  at: number;
}

/** A device a page of the built-in browser may ask to use (a `media` permission: audio is the microphone, video the camera). */
export type DesktopWebPreviewMediaKind = "microphone" | "camera";

/** What a site may do with one device, as the person set it: always, never, or ask each time (the default). */
export type DesktopWebPreviewSiteSetting = "allow" | "block" | "ask";

/** A tab's site (its main frame's origin) and what it may do with each device. */
export interface DesktopWebPreviewSitePermissions {
  /** The origin the settings are kept for (`https://deck.raft.build`). */
  origin: string;
  microphone: DesktopWebPreviewSiteSetting;
  camera: DesktopWebPreviewSiteSetting;
}

/**
 * A page asked to use a device and the shell waits for the person (the prompt bar under the address row):
 * `kinds` are the devices it asks for that the site has no answer for yet. Answered with
 * DesktopWebPreviewTabsBridge.answerPermission, by `id`.
 */
export interface DesktopWebPreviewPermissionPrompt {
  id: string;
  origin: string;
  kinds: DesktopWebPreviewMediaKind[];
}

/** One tab of the built-in browser, as the shell reports it after every navigation, title or loading change. */
export interface DesktopWebPreviewTabState extends DesktopWebPreviewState {
  tabId: string;
  /** The last thing the page asked for that was refused, until its next navigation; absent on shells that predate it. */
  blocked?: DesktopWebPreviewBlocked | null;
  /** The device prompt waiting for the person in this tab, or null. Absent on shells that predate site permissions. */
  permissionPrompt?: DesktopWebPreviewPermissionPrompt | null;
  /** The tab's site and its device settings; null where the page is not one that may ask (not a secure origin). */
  site?: DesktopWebPreviewSitePermissions | null;
  /** The devices the page was given since its document loaded (the tab strip's and the address row's indicator). */
  media?: DesktopWebPreviewMediaKind[];
  /** Sound comes out of the page (the speaker on the tab). Absent on shells that predate it: no speaker shows. */
  audible?: boolean;
  /** The person muted the tab (`setMuted`). Absent on shells that predate it. */
  muted?: boolean;
}

/**
 * What a tab's page asks the browser for, which only the web can do (it keeps
 * the tab list): `open-tab`, a new tab on `url` (a link opened in a new tab or
 * window, target=_blank, window.open), behind the tab in front when
 * `background`, placed after the tab that asked (`openerTabId`); or a
 * `command`.
 */
export type DesktopWebPreviewTabRequest =
  | { type: "open-tab"; url: string; background: boolean; openerTabId: string }
  /**
   * A browser command pressed with the keyboard focus in a tab's page
   * (`tabId`), which acts on the tab list: close that tab, a new tab, the
   * tab after / before the one in front, the address field, the tab at
   * `index` (-1: the last one). The shell decided the key (its one shortcut
   * table); the web only carries the command out.
   *
   * `find`, `find-next`, `find-previous`: the find field for that tab's
   * page, and the match after / before the one marked. The shell sends
   * `find` only to a page that listens for matches (`onFound`), and the
   * other two only while that tab's page has a search running; until then
   * the keys stay the page's own.
   */
  | { type: "command"; command: "close-tab" | "new-tab" | "next-tab" | "previous-tab" | "focus-address" | "select-tab" | "find" | "find-next" | "find-previous"; index?: number; tabId: string };

/** A search's result in a tab's page (find in page): how many matches, and which one is marked (1-based; 0: none). */
export interface DesktopWebPreviewFound {
  tabId: string;
  matches: number;
  active: number;
}

/** One tab of the list the shell owns (DesktopWebPreviewTabListBridge): `url` null is an empty tab. */
export interface DesktopWebPreviewListedTab {
  id: string;
  url: string | null;
  title: string;
  loading: boolean;
}

/** One conversation's browser in that list: its tabs in order and the one in front. */
export interface DesktopWebPreviewListedBrowser {
  /** The conversation the browser belongs to. */
  owner: string;
  tabs: DesktopWebPreviewListedTab[];
  /** The one of its own tabs last in front. */
  activeId: string;
  /** A pinned tab is in front of the conversation's own (DesktopWebPreviewPinnedTabs.activeId). */
  pinnedFront?: boolean;
}

/**
 * The window's pinned tabs (#proj-workspace:#297): they belong to the window, not to a conversation, lead every
 * conversation's strip, keep their pages when the window goes to another conversation, and are kept across a
 * restart.
 */
export interface DesktopWebPreviewPinnedTabs {
  tabs: DesktopWebPreviewListedTab[];
  /** The pinned tab last in front. */
  activeId: string;
  /** The pinned tabs show beside a conversation with no tabs of its own (the browser's panel is open there). */
  open: boolean;
}

/** The window's browsers, as the shell keeps them. */
export interface DesktopWebPreviewTabList {
  browsers: DesktopWebPreviewListedBrowser[];
  /** The window's pinned tabs. Absent: none (or a shell from before them). */
  pinned?: DesktopWebPreviewPinnedTabs;
  /**
   * Which change of the list this is: it only grows for the shell's life, over `get`, `dispatch` and `onChange`
   * alike, so of two lists the one with the larger number is the newer (an answer that arrives after a newer
   * change is dropped). Absent: not ordered, and taken as it comes.
   */
  revision?: number;
}

/**
 * What the web asks of the shell's tab list. The shell validates every part
 * (an address by the same rule as an open) and keeps its own caps:
 * - `open`: `url` in front, in the tab already on it, else a new tab (at the
 *   cap it takes the tab in front); makes the browser where there is none;
 * - `open-tab`: a new tab on `url` after `afterTabId` (else last), behind the
 *   one in front when `background`;
 * - `new-tab`: a new empty tab in front;
 * - `close-tab`: the last tab closes the browser; `close`: the whole browser;
 * - `move`: to where the tab `to` stands, or one place `left` or `right`; a
 *   pinned tab moves among the pinned ones only, any other among its own.
 *
 * On a shell with `pins` (DesktopWebPreviewTabListBridge), where `owner` is the
 * conversation the strip is beside and `tabId` may name a pinned tab in every
 * intent above:
 * - `pin`: the tab becomes the window's (last of the pinned ones); refused
 *   where a strip would pass the cap, which counts pinned and own tabs together;
 * - `unpin`: the pinned tab becomes the first of `owner`'s own tabs;
 * - `duplicate`: a new tab on the tab's address, in front, after it (a pinned
 *   tab's: first of `owner`'s own);
 * - `close-others`, `close-right`: close `owner`'s own tabs but this one, or
 *   after this one; a pinned tab is never closed by them.
 */
export type DesktopWebPreviewTabIntent =
  | { type: "open"; owner: string; url: string }
  | { type: "open-tab"; owner: string; url: string; background?: boolean; afterTabId?: string }
  | { type: "new-tab"; owner: string }
  | { type: "activate"; owner: string; tabId: string }
  | { type: "close-tab"; owner: string; tabId: string }
  | { type: "move"; owner: string; tabId: string; to: string }
  | { type: "navigate"; owner: string; tabId: string; url: string }
  | { type: "pin" | "unpin" | "duplicate" | "close-others" | "close-right"; owner: string; tabId: string }
  | { type: "close"; owner: string };

/**
 * The built-in browser's tab list, owned by the shell (#proj-workspace:#295):
 * the shell names the tabs, keeps their order, the one in front, each one's
 * address, title and loading state, makes and destroys their views, and
 * keeps the list across a reload of the app's page and across a restart (a
 * tab that comes back is an address and a title until it is shown). The web
 * mirrors it and sends intents. With it, the web does not call `open`,
 * `activate`, `close` or `closeAll` of DesktopWebPreviewTabsBridge.
 */
export interface DesktopWebPreviewTabListBridge {
  /**
   * The window's list for the signed-in `account` (an opaque key: the user's
   * id). The shell keeps one account's list: asked for another account, the
   * list before is dropped. Called once per page load, before anything else
   * here.
   */
  get(account: string): Promise<DesktopWebPreviewTabList>;
  /**
   * Resolves with the list after the intent (unchanged where the shell refused it). Rejects when the shell does not
   * hold this page as the list's owner (before `get`, or after it dropped the list on a sign-out): nothing changed.
   */
  dispatch(intent: DesktopWebPreviewTabIntent): Promise<DesktopWebPreviewTabList>;
  /**
   * Which conversation's browser the window is on (`owner`; null: none, and
   * only the pinned tabs keep their views), and whether its panel is on screen (`showing`: the tab
   * in front shows; it may be a conversation with no tabs of its own, whose strip is the pinned ones).
   * Views exist only for that conversation's own tabs, and for the pinned ones.
   *
   * `options.backgroundMedia`: this web shows a speaker on a tab that plays and can mute it (`setMuted`), so a tab
   * behind plays on, heard, as a Chrome background tab, and a page of a conversation left that plays keeps playing
   * (#proj-workspace:#299). Absent (a web from before): every tab not in front is muted and the pages of a
   * conversation left are destroyed, as before. A shell from before ignores it.
   */
  present(owner: string | null, showing: boolean, options?: { backgroundMedia?: boolean }): void;
  /** The list after each change. Returns unsubscribe. */
  onChange(handler: (list: DesktopWebPreviewTabList) => void): () => void;
  /**
   * The shell has pinned tabs (#proj-workspace:#297): `pin`, `unpin`, `duplicate`, `close-others` and `close-right`
   * are intents it knows, and its list carries `pinned`. Absent on a shell from before them: the web offers none
   * of the five (the shell would refuse them).
   */
  pins?: true;
}

/**
 * The built-in browser's tabs (desktop_web_preview_view_v0): one native view
 * per tab, each under the same rules as the single view (session partition,
 * http(s) only, not Raft's own hosts). The web names the tabs (1 to 64 of
 * A–Z a–z 0–9 _ -) and keeps their order and titles; the shell keeps the
 * pages. At most one view shows, and the shell caps how many exist per
 * window. Absent on shells that predate it: the web keeps the single view.
 */
export interface DesktopWebPreviewTabsBridge {
  /**
   * Load `url` in the tab, creating its view (hidden until activated) on
   * first use. `owner` is the conversation the browser belongs to: an open
   * for another owner first destroys every view of the one before.
   */
  open(owner: string, tabId: string, url: string): void;
  /** Show this tab's view and hide every other one; null hides them all (the browser is not in front). */
  activate(tabId: string | null): void;
  /** Destroy the tab's view. */
  close(tabId: string): void;
  /** Destroy every tab's view (the browser closed, or the window left its conversation). */
  closeAll(): void;
  back(tabId: string): void;
  forward(tabId: string): void;
  reload(tabId: string): void;
  /**
   * Find in page. `find` searches the tab's page for `text` (not empty):
   * `fresh` starts a search, else it moves to the match after (`forward`) or
   * before the one marked. `stopFind` ends the search and clears its marks;
   * `focusPage` hands the page the keyboard. `onFound` reports each search's
   * matches. All three absent on shells that predate find in page: the web
   * shows no find field.
   */
  find?(tabId: string, text: string, options: { forward: boolean; fresh: boolean }): void;
  stopFind?(tabId: string, focusPage: boolean): void;
  onFound?(handler: (found: DesktopWebPreviewFound) => void): () => void;
  /** Where the showing tab's view goes; every tab shares the one placeholder. */
  setBounds(bounds: DesktopWebPreviewBounds): void;
  /** As DesktopWebPreviewBridge.setVisible, for the active tab's view. */
  setVisible(visible: boolean): Promise<string | null>;
  /** Each tab's page after each change. Returns unsubscribe. */
  onState(handler: (state: DesktopWebPreviewTabState) => void): () => void;
  /** What a tab's page asks the browser for. Returns unsubscribe. Absent on shells that predate it: a page's new windows go to the system browser. */
  onRequest?(handler: (request: DesktopWebPreviewTabRequest) => void): () => void;
  /**
   * The person's answer to the tab's device prompt (DesktopWebPreviewTabState.permissionPrompt, by its id): `allow`
   * and `block` are kept for the site, `dismiss` answers no this time only (the site asks again next time). Absent,
   * with `setSitePermission`, on shells that predate site permissions.
   */
  answerPermission?(tabId: string, promptId: string, answer: "allow" | "block" | "dismiss"): void;
  /**
   * The person changed what the tab's site may do with a device (the site settings at the address row's start). The
   * shell keeps it for the site the tab shows now, never one the web names; taking away a device the page was given
   * reloads the page, so it stops using it.
   */
  setSitePermission?(tabId: string, kind: DesktopWebPreviewMediaKind, setting: DesktopWebPreviewSiteSetting): void;
  /**
   * Mute or unmute the tab's page (the speaker on the tab, as Chrome's): kept for the tab across its navigations,
   * reported back as DesktopWebPreviewTabState.muted. Absent on shells that predate it: the web shows no speaker.
   */
  setMuted?(tabId: string, muted: boolean): void;
  /** The tab list as the shell's own state. Absent on shells that predate it: the web keeps the list and drives the views with the methods above. */
  list?: DesktopWebPreviewTabListBridge;
}

/**
 * The pane of the workspace grid that holds the keyboard focus in the app's own page: its kind (one the shell knows
 * a shortcut table for: "browser"), whose it is (the conversation), and its tab in front (null: none).
 */
export interface DesktopPaneFocus {
  kind: string;
  owner: string;
  tabId: string | null;
}

/**
 * Keys belong to the pane that holds the keyboard focus (apps/desktop paneKeys.ts): the shell offers each key to
 * that pane's shortcut table first, and only a key it does not claim reaches the window's menu. The web says which
 * pane that is (packages/web paneFocus.ts), and null as soon as none: the focus left every pane, the pane went.
 * The shell also drops it when this page reloads or navigates.
 */
export interface DesktopPaneFocusBridge {
  set(focus: DesktopPaneFocus | null): void;
}

/** A page of the built-in browser asked to sign in with Raft, and Raft's server accepted the request. */
export interface DesktopWebPreviewRaftSignInRequest {
  /** The shell's id for the request: what `complete` and `cancel` name. */
  requestId: string;
  /**
   * The query of the Login with Raft setup address the server answered with
   * (`?flow=oidc&client_id=…&return_to=…`): what the consent is fed, in place
   * of the setup page's own `window.location.search`.
   */
  setupSearch: string;
}

/**
 * "Sign in with Raft" from a page of the built-in browser
 * (desktop_browser_raft_sign_in_v0), without a second Raft sign-in: the shell
 * stops the page's navigation to Raft's authorize endpoint, asks the server
 * about it, and has the web show Raft's consent in the app's own window. The
 * web approves with its own session and hands the app's return address back;
 * the shell loads it in the tab that asked, after checking it. Absent on
 * shells that predate it: that navigation is only stopped, as before.
 */
export interface DesktopWebPreviewRaftSignInBridge {
  /**
   * The feature is on for what this window shows and `accountKey` (an opaque
   * id of the signed-in account) is signed in. An account other than the one
   * the browser's storage belongs to empties that storage first.
   */
  arm(accountKey: string): void;
  /**
   * `accountKey` is signed in, whether or not the feature is on: browser
   * storage the shell recorded as another account's is emptied, as at a
   * sign-out (an account can follow another with no signed-out state in
   * between, on a Server where the feature is off). Said before `arm`.
   * Absent on the first shells with this bridge.
   */
  account?(accountKey: string): void;
  /** The feature is off for what this window shows now: its pending requests are dropped. */
  disarm(): void;
  /** Nobody is signed in: every pending request is dropped and the browser's storage emptied (if this feature ever served it). */
  signedOut(): void;
  /** A request to show the consent for. Returns unsubscribe. */
  onRequest(handler: (request: DesktopWebPreviewRaftSignInRequest) => void): () => void;
  /** The shell dropped this request (its tab closed or navigated, it expired): close its consent. Returns unsubscribe. */
  onClosed(handler: (requestId: string) => void): () => void;
  /** The address the consent would have navigated to (the app's return address with the code, or with an error). One use. */
  complete(requestId: string, url: string): void;
  /** The person dismissed the consent. */
  cancel(requestId: string): void;
  /**
   * The web will not show the consent for this request (it names another return address than the App is registered
   * with, or carries what Raft has no words for): the request ends as with `cancel`, and its tab says Raft's sign-in
   * was not available there. Absent on shells that predate it: `cancel` then.
   */
  refuse?(requestId: string): void;
}

/**
 * The web preview's real browser view (desktop_web_preview_view_v0): one
 * Electron WebContentsView per window, in its own session partition, laid
 * over the web panel's placeholder. The shell validates every input (http(s)
 * only, not Raft's own hosts; finite bounds). Absent on shells without it:
 * the web keeps the sandboxed frame.
 */
export interface DesktopWebPreviewBridge {
  /** Show `url` in the view, creating it on first use. */
  open(url: string): void;
  /** Destroy the view (the panel closed or unmounted). */
  close(): void;
  setBounds(bounds: DesktopWebPreviewBounds): void;
  back(): void;
  forward(): void;
  reload(): void;
  /**
   * Show or hide the view (it always draws above the page). Hiding resolves
   * with a snapshot of the page as a data URL, taken just before it hid, for
   * the placeholder to show while it is hidden (null when there is none);
   * showing resolves null.
   */
  setVisible(visible: boolean): Promise<string | null>;
  /** The view's page after each change. Returns unsubscribe. */
  onState(handler: (state: DesktopWebPreviewState) => void): () => void;
  /**
   * Called from a link's `contextmenu` event, before the shell's native menu
   * for that right-click: this http(s) link may open beside the conversation,
   * so the menu offers Open Beside next to Open in Browser. One right-click
   * only. Absent on shells that predate it: the menu has no such item.
   */
  offerLinkMenu?(url: string): void;
  /** The person picked Open Beside in that menu, for the address offered. Returns unsubscribe. */
  onOpenLinkBeside?(handler: (url: string) => void): () => void;
  /** The built-in browser's tabs. Absent on shells that predate them: one page, through the methods above. */
  tabs?: DesktopWebPreviewTabsBridge;
  /** Sign in with Raft from a page of the built-in browser. Absent on shells that predate it. */
  raftSignIn?: DesktopWebPreviewRaftSignInBridge;
}

export interface RaftDesktopBridge {
  isDesktop: true;
  facts: DesktopHostFacts;
  platform: string;
  /** How the shell draws the title bar; undefined when it did not say. */
  titleBar: DesktopTitleBarMode | undefined;
  /** How the shell opened this window. Absent on shells that predate it. */
  launch?: DesktopLaunchInfo;
  versions: { electron: string; chrome: string };
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    /**
     * The web's top bar reports its colours and height: Windows / Linux paint the
     * caption-button overlay in them, and the shell keeps the last report for the
     * next window's first frame.
     */
    setTitleBarOverlay(overlay: DesktopTitleBarOverlay): void;
  };
  /** The desktop app's own version (e.g. "1.21.40"). */
  getAppVersion(): Promise<string>;
  isFocused(): Promise<boolean>;
  onFocusChange(handler: (focused: boolean) => void): () => void;
  isFullScreen(): Promise<boolean>;
  onFullScreenChange(handler: (fullScreen: boolean) => void): () => void;
  getWindowActivity(): Promise<DesktopWindowActivity | null>;
  onWindowActivity(handler: (state: DesktopWindowActivity) => void): () => void;
  /** powerMonitor resume / unlock-screen (DesktopSystemResume). Absent in shells that predate it. */
  onSystemResume?(handler: (event: DesktopSystemResume) => void): () => void;
  /** Dock / taskbar unread badge (0 clears it). */
  setBadgeCount(count: number): void;
  focusWindow(): void;
  notifications: {
    /** Older shells return undefined; newer ones resolve once the OS showed it or refused. */
    show(request: DesktopNotificationRequest): Promise<DesktopNotificationShowResult> | void;
    /**
     * The conversation was read: retract its notifications. With throughSeq,
     * only those whose seq is <= it (older shells ignore the argument and clear all).
     */
    clearGroup(groupKey: string, throughSeq?: number | null): void;
  };
  /**
   * Windows / Linux: keep running in the tray after the last window closes
   * (default on). Absent on macOS shells and on shells from before the setting.
   */
  /**
   * Opens the OS notification settings for Raft: macOS System Settings ›
   * Notifications, Windows Settings › Notifications. Absent on Linux and on
   * shells from before it.
   */
  openNotificationSettings?(): void;
  runInBackground?: {
    /**
     * Whether keeping running in the background is possible here: false on a
     * Linux desktop with no tray host (no StatusNotifierWatcher), where closing
     * the last window quits. Resolves once the shell's tray probe finishes.
     * Shells before it lack the method (treat as available).
     */
    available?(): Promise<boolean>;
    get(): Promise<boolean>;
    set(enabled: boolean): Promise<boolean>;
  };
  /** Native menus, gestures, deep links and notification clicks (see HostCommand). */
  commands: {
    /** Commands that arrived before the first subscriber (cold start) replay to it. Returns unsubscribe. */
    on(handler: (command: HostCommand) => void): () => void;
  };
  /** The web reports its servers (switcher order) and the current one, for the native Server menu. */
  setServerList(state: DesktopServerMenuState): void;
  startupMark(label: DesktopStartupMark): void;
  /** Desktop sign-in's native half: the RFC 8252 loopback (the web runs the flow). */
  auth: DesktopAuthBridge;
  computer: DesktopComputerBridge;
  handoff: {
    listSessions(): Promise<unknown>;
    sessionExcerpt(input: { transcriptPath: string; tool: string }): Promise<unknown>;
    searchContent(query: string): Promise<unknown>;
  };
  appUpdate: {
    getStatus(): Promise<DesktopAppUpdateStatus>;
    onStatus(handler: (status: DesktopAppUpdateStatus) => void): () => void;
    restartToApply(): void;
    checkNow(): void;
    claimWhatsNew(): Promise<string | null>;
    downloadInstaller(): void;
  };
  /** The web preview's native browser view. Absent on shells that predate it. */
  webPreview?: DesktopWebPreviewBridge;
  /** Which pane of the workspace holds the keyboard focus, for its keys. Absent on shells that predate it. */
  paneFocus?: DesktopPaneFocusBridge;
}
