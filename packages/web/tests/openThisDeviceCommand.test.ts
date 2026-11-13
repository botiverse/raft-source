// The tray / Dock menu's "Open this device…", Help › "Raft Computer
// Troubleshooting…" and a Computer notification's click arrive as the host
// command {type: "open-this-device", section?}; the web opens This device on
// the current server: the computer's own page when this machine is one of its
// computers, otherwise /computers/this-device.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { executeHostCommand } from "../src/host/hostCommands";
import type { HostCommandDeps } from "../src/host/hostCommands";
import { useServerStore } from "../src/store/serverStore";
import { useMachineStore } from "../src/store/machineStore";
import { holdLocalComputerForTests } from "../src/components/machine/localComputer/localComputerStore";
import { installFakeLocalComputer } from "./helpers/fakeLocalComputer";
import type { FakeLocalComputer } from "./helpers/fakeLocalComputer";

const initialServer = useServerStore.getState();
const initialMachines = useMachineStore.getState();
let local: FakeLocalComputer | null = null;

afterEach(() => {
  local?.cleanup();
  local = null;
  useServerStore.setState(initialServer, true);
  useMachineStore.setState(initialMachines, true);
});

function run(command: Parameters<typeof executeHostCommand>[0]): string[] {
  const visited: string[] = [];
  const deps: HostCommandDeps = { navigate: (to) => { visited.push(to); }, stepHistory: () => {}, layerOpen: () => false };
  executeHostCommand(command, deps);
  return visited;
}

test("not one of this server's computers: the standalone This device page, with the section", () => {
  useServerStore.setState({ current: { id: "server-1", slug: "acme" } } as never);
  useMachineStore.setState({ machines: [] } as never);
  assert.deepEqual(run({ type: "open-this-device" }), ["/s/acme/computers/this-device"]);
  assert.deepEqual(run({ type: "open-this-device", section: "troubleshoot" }), ["/s/acme/computers/this-device?section=troubleshoot"]);
});

test("one of this server's computers: its own page", async () => {
  local = installFakeLocalComputer({ machineId: "m-self" });
  holdLocalComputerForTests();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  useServerStore.setState({ current: { id: "server-1", slug: "acme" } } as never);
  useMachineStore.setState({ machines: [{ id: "m-self", hostname: "local-mac" }] } as never);
  assert.deepEqual(run({ type: "open-this-device", section: "troubleshoot" }), ["/s/acme/computer/m-self?section=troubleshoot"]);
  assert.deepEqual(run({ type: "open-this-device" }), ["/s/acme/computer/m-self"]);
});

test("no current server, or a section it does not know: nowhere / no section", () => {
  useServerStore.setState({ current: null } as never);
  assert.deepEqual(run({ type: "open-this-device" }), []);
  useServerStore.setState({ current: { id: "server-1", slug: "acme" } } as never);
  useMachineStore.setState({ machines: [] } as never);
  assert.deepEqual(run({ type: "open-this-device", section: "elsewhere" as never }), ["/s/acme/computers/this-device"]);
});
