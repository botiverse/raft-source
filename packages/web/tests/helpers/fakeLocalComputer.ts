// A fake Raft Desktop computer bridge (`raftDesktop.computer`) for tests of the
// web's local-Computer surfaces (components/machine/localComputer). Desktop
// drives the one official Raft Computer install: the fake reports its host
// state (installed, version, how it starts, a move from an embedded Computer)
// and its status, and `machineId` as this machine's attachment, so the web
// knows which of the server's machines it runs on.
//
// Add This Mac is install → one-time grant → enableWithToken: unless
// `grants: false`, the fake also answers the device flow's POSTs on the app's
// API client for whatever server is asked, so a test can click Add and see
// `enableWithToken:<slug>`. Returns the cleanup.
import type {
  DesktopComputerBridge,
  DesktopComputerEnableProgress,
  DesktopComputerEnableWithTokenInput,
  DesktopComputerHostState,
  DesktopComputerStatus,
} from "@botiverse/raft-shared";
import api from "../../src/api/client";
import { useServerStore } from "../../src/store/serverStore";
import { holdLocalComputerForTests, resetLocalComputerStoreForTests } from "../../src/components/machine/localComputer/localComputerStore";

export const INSTALLED: DesktopComputerHostState = {
  installed: true,
  version: "1.0.60",
  capabilities: ["attach-token-stdin", "approval-request", "active-turns", "doctor-json", "upgrade-yes"],
  installSupported: true,
  startsWith: "login-item",
  stoppedByUser: false,
  updating: false,
  migration: { state: "none" },
};

export const NOT_INSTALLED: DesktopComputerHostState = { ...INSTALLED, installed: false, version: null };

export interface FakeLocalComputer {
  calls: string[];
  /** What each token enable was given (tests of what crosses IPC). */
  tokenInputs: DesktopComputerEnableWithTokenInput[];
  push(status: DesktopComputerStatus | null): void;
  /** Push a host state (onHostState), as the shell does when it changes. */
  pushHost(state: DesktopComputerHostState): void;
  /** The next operation rejects with this (an Error with this message, as IPC delivers it). */
  failNext(message: string): void;
  /** Connect now and wait for the identity, as a running app already has it. */
  ready(): Promise<void>;
  /** Operations wait until the returned release is called. */
  hold(): () => void;
  /**
   * The bridge's reads (status, host state, local info) wait until the
   * returned release for that read is called, as on a cold start.
   */
  holdReads(): Record<FakeRead, () => void>;
  /** Every read of this kind rejects with this message from now on. */
  failRead(read: FakeRead, message: string): void;
  /** An Add This Mac step, to every `onEnableProgress` subscriber (a shell built with `enableProgress`). */
  emitEnableProgress(progress: DesktopComputerEnableProgress): void;
  cleanup(): void;
}

export type FakeRead = "getStatus" | "getHostState" | "getLocalInfo";

/** A server id the device flow accepts (a UUID), stable per slug. */
function serverUuid(slug: string): string {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `00000000-0000-4000-8000-${hash.toString(16).padStart(12, "0").slice(-12)}`;
}

export function installFakeLocalComputer({
  machineId = null,
  hostname = "local-mac",
  running = false,
  platform = "darwin",
  hostCapable = true,
  servers,
  upgrade = null,
  host = INSTALLED,
  status: statusOverride,
  grants = true,
  enableProgress = false,
  extra = {},
}: {
  /** The host state; null: a shell without getHostState. Partial values merge onto INSTALLED. */
  host?: Partial<DesktopComputerHostState> | null;
  /** The status as given (null: not installed, or unreadable); default from running / servers. */
  status?: DesktopComputerStatus | null;
  /** Answer the device flow's POSTs on the API client (default on). */
  grants?: boolean;
  /** A shell with `onEnableProgress` (tests drive it with emitEnableProgress). */
  enableProgress?: boolean;
  /** More optional bridge members, as given. */
  extra?: Partial<DesktopComputerBridge>;
  /** Attachments other than this server's (installed, but not here). */
  servers?: DesktopComputerStatus["servers"];
  upgrade?: DesktopComputerStatus["upgrade"];
  machineId?: string | null;
  hostname?: string;
  running?: boolean;
  platform?: string;
  hostCapable?: boolean;
} = {}): FakeLocalComputer {
  resetLocalComputerStoreForTests();
  const listeners = new Set<(status: DesktopComputerStatus | null) => void>();
  const hostListeners = new Set<(state: DesktopComputerHostState) => void>();
  const progressListeners = new Set<(progress: DesktopComputerEnableProgress) => void>();
  const calls: string[] = [];
  const tokenInputs: DesktopComputerEnableWithTokenInput[] = [];
  let failure: string | null = null;
  let gate: Promise<void> | null = null;
  const readGates: Partial<Record<FakeRead, Promise<void>>> = {};
  const readFailures: Partial<Record<FakeRead, string>> = {};
  const read = async <T,>(kind: FakeRead, value: () => T): Promise<T> => {
    await readGates[kind];
    const readFailure = readFailures[kind];
    if (readFailure) {
      throw new Error(`Error invoking remote method: Error: ${readFailure}`);
    }
    return value();
  };
  const hostState: DesktopComputerHostState | null = host === null ? null : { ...INSTALLED, ...host };
  const attachments = servers ?? (machineId ? [{ serverId: "server-1", serverSlug: "acme", machineId }] : []);
  // Not installed (and nothing said otherwise): Raft Computer has no status to read.
  const status: DesktopComputerStatus | null = statusOverride !== undefined
    ? statusOverride
    : hostState && !hostState.installed && attachments.length === 0 && !running
      ? null
      : { servers: attachments, service: { running, ...(hostState?.version ? { version: { version: hostState.version } } : {}) }, upgrade };
  const settle = async () => {
    if (gate) await gate;
    if (failure) {
      const message = failure;
      failure = null;
      throw new Error(`Error invoking remote method: Error: ${message}`);
    }
  };
  const op = (name: string) => async () => {
    calls.push(name);
    await settle();
  };
  const computer: DesktopComputerBridge = {
    hostCapable,
    getLocalInfo: () => read("getLocalInfo", () => ({ hostname })),
    getStatus: () => read("getStatus", () => status),
    onStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: op("start"),
    stop: op("stop"),
    restart: op("restart"),
    ...(hostState ? {
      getHostState: () => read("getHostState", () => hostState),
      onHostState: (handler: (state: DesktopComputerHostState) => void) => {
        hostListeners.add(handler);
        return () => { hostListeners.delete(handler); };
      },
    } : {}),
    ensureInstalled: async () => {
      calls.push("ensureInstalled");
      await settle();
      return { version: hostState?.version ?? "1.0.60" };
    },
    getAttachGrantRequest: async () => ({ machineName: "local-mac", hostname, os: "macOS" }),
    enableWithToken: async (input: DesktopComputerEnableWithTokenInput) => {
      calls.push(`enableWithToken:${input.serverSlug}`);
      tokenInputs.push(input);
      await settle();
    },
    ...(enableProgress ? {
      onEnableProgress: (handler: (progress: DesktopComputerEnableProgress) => void) => {
        progressListeners.add(handler);
        return () => { progressListeners.delete(handler); };
      },
    } : {}),
    updateComputer: op("updateComputer"),
    retryMigration: op("retryMigration"),
    openComputerLogs: op("openComputerLogs"),
    openDesktopLogs: op("openDesktopLogs"),
    ...extra,
  };
  const bridge = { isDesktop: true, platform, computer };
  (globalThis as { raftDesktop?: unknown }).raftDesktop = bridge;

  // The device flow, approved for whichever of this person's servers is asked.
  const originalPost = api.post;
  if (grants) {
    let approved: string | null = null;
    const slugs = () => {
      const { current, servers: known } = useServerStore.getState();
      return [...new Set([current?.slug, ...(known ?? []).map((server) => server?.slug)].filter((slug): slug is string => typeof slug === "string"))];
    };
    api.post = (async (url: string, body: Record<string, unknown>) => {
      if (url === "/auth/device/authorize") return { status: 201, data: { deviceCode: "dvc_fake", userCode: "FAKE-0001", interval: 1, expiresIn: 600 } };
      if (url === "/auth/device/describe") {
        return { status: 200, data: { approvalTicket: "ticket", grant: { kind: "computer_attach", servers: slugs().map((slug) => ({ id: serverUuid(slug), slug })) } } };
      }
      if (url === "/auth/device/approve") {
        approved = slugs().find((slug) => serverUuid(slug) === body.serverId) ?? null;
        return { status: 200, data: { ok: true } };
      }
      if (url === "/auth/device/token" && approved) {
        return { status: 200, data: { kind: "computer_attach", attachToken: "dvat_fake", serverId: serverUuid(approved), serverSlug: approved } };
      }
      return originalPost.call(api, url, body);
    }) as typeof api.post;
  }
  return {
    calls,
    tokenInputs,
    push: (next) => { for (const listener of [...listeners]) listener(next); },
    pushHost: (next) => { for (const listener of [...hostListeners]) listener(next); },
    failNext: (message) => { failure = message; },
    ready: async () => {
      holdLocalComputerForTests();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    },
    hold: () => {
      let release = () => {};
      gate = new Promise<void>((resolve) => { release = resolve; });
      return () => { gate = null; release(); };
    },
    holdReads: () => {
      const releases = {} as Record<FakeRead, () => void>;
      for (const kind of ["getStatus", "getHostState", "getLocalInfo"] as const) {
        readGates[kind] = new Promise<void>((resolve) => {
          releases[kind] = () => { delete readGates[kind]; resolve(); };
        });
      }
      return releases;
    },
    failRead: (kind, message) => { readFailures[kind] = message; },
    emitEnableProgress: (progress) => { for (const listener of [...progressListeners]) listener(progress); },
    cleanup: () => {
      delete (globalThis as { raftDesktop?: unknown }).raftDesktop;
      if (grants) api.post = originalPost;
      resetLocalComputerStoreForTests();
    },
  };
}
