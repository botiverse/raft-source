// k-harness --adapter fixture: Computer's kHostAdapter under K's own
// service-tier acceptance teeth (#wg-k task #2, Track A step 4).
//
//   node --import tsx <k-carrier>/harness/src/cli.ts \
//     --adapter packages/computer/src/kHostAdapterHarnessFixture.ts
//
// What is REAL here: the adapter (production createKHostAdapter), the IPC
// client path (real connectService over the real unix socket + codec), the
// stop path (real StopService: pidfile -> SIGTERM -> wait-for-exit), the
// spawn path (the adapter's default detached spawn of the staged artifact),
// and the releases themselves (kAcceptanceApp source stamped by K's
// artifact factory, run as real processes). What is fixture-owned: the
// managed-set reads (static, matching what the app attests) and the slot
// resolution root.
//
// Slot resolution: the harness owns K's stateDir (<sandbox>/state) and K
// stages at <stateDir>/slots/<slot>/artifact.bin — so the fixture points
// the adapter's slot resolution at THAT root. In production the same
// alignment holds by construction (createUpgrader gets
// stateDir = kStateDir(slockHome), the adapter default resolves under it).
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  createKHostAdapter,
  type KHostAdapter,
  type KSlot,
} from "./kHostAdapter.js";
import { servicePidPath } from "./paths.js";
import { ACCEPTANCE_MANAGED, COMPUTER_ACCEPTANCE_APP_SOURCE } from "./kAcceptanceApp.js";

interface ReadbackSurfaceShape {
  id: string;
  read(): Promise<{ value: string; source: string }>;
}

export default function createFixture(stateDir: string): KHostAdapter & {
  running: KSlot | null;
  parked: boolean;
  startId: string | null;
  lifecycleSurfaces(): ReadbackSurfaceShape[];
  releaseSource(): string;
} {
  // One root for everything: K's slots live under it AND it serves as the
  // app's SLOCK_HOME (socket/pidfile under <stateDir>/computer/run/).
  const installRoot = stateDir;

  let running: KSlot | null = null;
  let parked = false;
  let lastStartId: string | null = null;

  const adapter = createKHostAdapter(installRoot, {
    // K's engine stages at <stateDir>/slots/<slot>/artifact.bin (harness
    // owns stateDir here); everything else uses the PRODUCTION defaults.
    resolveSlotBinaryFn: (_home, slot) => join(stateDir, "slots", slot, "artifact.bin"),
    listManagedServerIdsFn: async () => [...ACCEPTANCE_MANAGED.managedServerIds],
    readManagedMachineIdentitiesFn: async () => ({ ...ACCEPTANCE_MANAGED.managedMachineIdentities }),
    resumeTimeoutMs: 10_000,
    resumePollIntervalMs: 50,
  });

  return {
    async quiesce() {
      await adapter.quiesce();
      parked = true;
    },
    async stop(slot) {
      await adapter.stop(slot);
      running = null;
    },
    async start(slot) {
      await adapter.start(slot);
      running = slot;
    },
    async healthProbe() {
      const evidence = await adapter.healthProbe();
      lastStartId = evidence.startId;
      return evidence;
    },
    async resume() {
      await adapter.resume();
      parked = false;
    },
    get running() {
      return running;
    },
    get parked() {
      return parked;
    },
    get startId() {
      return lastStartId;
    },
    // The app's OS-lifecycle read-back surface: what the live process was
    // actually spawned from (/proc cmdline), which references the promoted
    // experiment artifact during readback — and keeps referencing it after
    // promote, because argv outlives the slot-directory rename.
    lifecycleSurfaces() {
      return [
        {
          id: "adapter.autostart-cmdline",
          read: async () => {
            const pid = Number((await readFile(servicePidPath(installRoot), "utf8")).trim());
            const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
            return {
              value: cmdline.split("\0").join(" ").trim(),
              source: "adapter.autostart-cmdline",
            };
          },
        },
      ];
    },
    releaseSource() {
      return COMPUTER_ACCEPTANCE_APP_SOURCE;
    },
  };
}
