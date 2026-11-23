import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { createLoopbackLoginPresenter, installSwitchToCodeKey, loopbackUnavailableReason } from "./loopbackLoginPrompt";
import type { ComputerTracer } from "./lib/traceTypes";

const TTY = { stdinIsTTY: true, stdoutIsTTY: true };
const notWsl = () => "6.8.0-generic";

test("mode selection: a desktop terminal may use loopback", () => {
  assert.equal(loopbackUnavailableReason({ ...TTY, env: {}, platform: "darwin" }), undefined);
  assert.equal(loopbackUnavailableReason({ ...TTY, env: {}, platform: "win32" }), undefined);
  assert.equal(loopbackUnavailableReason({ ...TTY, env: { DISPLAY: ":0" }, platform: "linux", readKernelRelease: notWsl }), undefined);
  assert.equal(loopbackUnavailableReason({ ...TTY, env: { WAYLAND_DISPLAY: "wayland-0" }, platform: "linux", readKernelRelease: notWsl }), undefined);
});

test("mode selection: each fallback reason", () => {
  assert.equal(loopbackUnavailableReason({ ...TTY, deviceCodeFlag: true, env: {}, platform: "darwin" }), "flag");
  assert.equal(loopbackUnavailableReason({ stdinIsTTY: false, stdoutIsTTY: true, env: {}, platform: "darwin" }), "no_tty");
  assert.equal(loopbackUnavailableReason({ stdinIsTTY: true, stdoutIsTTY: false, env: {}, platform: "darwin" }), "no_tty");
  assert.equal(loopbackUnavailableReason({ ...TTY, env: { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, platform: "darwin" }), "ssh");
  assert.equal(loopbackUnavailableReason({ ...TTY, env: { SSH_TTY: "/dev/pts/1", DISPLAY: ":0" }, platform: "linux", readKernelRelease: notWsl }), "ssh");
  assert.equal(loopbackUnavailableReason({ ...TTY, env: {}, platform: "linux", readKernelRelease: notWsl }), "no_display");
  // WSL wins over a WSLg display.
  assert.equal(loopbackUnavailableReason({ ...TTY, env: { DISPLAY: ":0", WSL_DISTRO_NAME: "Ubuntu" }, platform: "linux", readKernelRelease: notWsl }), "wsl");
  assert.equal(
    loopbackUnavailableReason({ ...TTY, env: { DISPLAY: ":0" }, platform: "linux", readKernelRelease: () => "5.15.153.1-microsoft-standard-WSL2" }),
    "wsl",
  );
  // An unreadable kernel release is not WSL.
  assert.equal(
    loopbackUnavailableReason({ ...TTY, env: { DISPLAY: ":0" }, platform: "linux", readKernelRelease: () => { throw new Error("EACCES"); } }),
    undefined,
  );
  // --device-code wins over everything.
  assert.equal(loopbackUnavailableReason({ deviceCodeFlag: true, stdinIsTTY: false, env: { SSH_TTY: "x" }, platform: "linux" }), "flag");
});

type FakeTty = PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (raw: boolean) => void; rawCalls: boolean[] };

function fakeTty(): FakeTty {
  const input = new PassThrough() as FakeTty;
  input.isTTY = true;
  input.isRaw = false;
  input.rawCalls = [];
  input.setRawMode = (raw) => {
    input.rawCalls.push(raw);
    input.isRaw = raw;
  };
  return input;
}

test("c switches to a code and restores the terminal mode", () => {
  const input = fakeTty();
  let switched = 0;
  const cleanup = installSwitchToCodeKey({ input, onSwitch: () => (switched += 1), interrupt: () => assert.fail("no interrupt") });
  assert.ok(cleanup);
  assert.equal(input.isRaw, true);
  input.write("x");
  assert.equal(switched, 0);
  input.write("c");
  input.write("c");
  assert.equal(switched, 1);
  assert.equal(input.isRaw, false);
  cleanup();
  assert.deepEqual(input.rawCalls, [true, false]);
});

test("Ctrl-C in raw mode restores the terminal, then interrupts as before", () => {
  const input = fakeTty();
  const order: string[] = [];
  installSwitchToCodeKey({ input, onSwitch: () => assert.fail("no switch"), interrupt: () => order.push(`interrupt raw=${input.isRaw}`) });
  input.write("\u0003");
  assert.deepEqual(order, ["interrupt raw=false"]);
});

test("cleanup restores the terminal mode it found (already raw stays raw)", () => {
  const input = fakeTty();
  input.isRaw = true;
  const cleanup = installSwitchToCodeKey({ input, onSwitch: () => {} });
  cleanup?.();
  assert.equal(input.isRaw, true);
});

test("no raw-mode TTY: no key listener", () => {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  assert.equal(installSwitchToCodeKey({ input, onSwitch: () => {} }), null);
  input.isTTY = true; // a TTY without setRawMode
  assert.equal(installSwitchToCodeKey({ input, onSwitch: () => {} }), null);
});

function captureStdout(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk).replace(/\n$/, ""));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

function recordingTracer(): ComputerTracer & { events: Array<{ name: string; attrs: unknown }> } {
  const events: Array<{ name: string; attrs: unknown }> = [];
  return {
    events,
    startSpan: () => assert.fail("no span"),
    emitEvent: (name, options) => {
      events.push({ name, attrs: options.attrs });
    },
  } as ComputerTracer & { events: Array<{ name: string; attrs: unknown }> };
}

test("presenter: --device-code is passed to the service as the `flag` reason", () => {
  const presenter = createLoopbackLoginPresenter({ deviceCode: true, input: fakeTty() });
  assert.equal(presenter.options.unavailableReason, "flag");
  assert.ok(presenter.options.switchToDeviceCode);
});

test("presenter: waiting lines, c aborts the switch signal, events traced", () => {
  const input = fakeTty();
  const tracer = recordingTracer();
  const presenter = createLoopbackLoginPresenter({
    input,
    tracer,
    environment: { stdoutIsTTY: true, env: {}, platform: "darwin" },
  });
  assert.equal(presenter.options.unavailableReason, undefined);
  const lines = captureStdout(() => {
    assert.equal(presenter.handleEvent({ kind: "login.mode", mode: "loopback" }), true);
    assert.equal(
      presenter.handleEvent({
        kind: "login.loopback-waiting",
        approvalUrl: "https://app.example/login/device?request=r",
        expiresAt: new Date().toISOString(),
        expiresInSeconds: 600,
        canSwitchToCode: true,
      }),
      true,
    );
  });
  assert.equal(lines[0], "Approve this Computer in the browser window that just opened.");
  assert.ok(lines.includes("No browser? Press c to get a code you can enter on another device."));
  assert.equal(input.isRaw, true);

  input.write("c");
  assert.equal(presenter.options.switchToDeviceCode?.aborted, true);
  assert.equal(input.isRaw, false);

  const fallback = captureStdout(() => {
    presenter.handleEvent({ kind: "login.mode", mode: "device_code", reason: "user_chose_code" });
  });
  assert.deepEqual(fallback, ["Getting a code you can enter on another device…"]);
  presenter.handleEvent({ kind: "login.loopback.result", result: "approved", msToResult: 1234 });
  assert.deepEqual(tracer.events, [
    { name: "computer.login.mode", attrs: { mode: "loopback" } },
    { name: "computer.login.mode", attrs: { mode: "device_code", reason: "user_chose_code" } },
    { name: "computer.login.loopback.result", attrs: { result: "approved", ms_to_result: 1234 } },
  ]);
  // Other events are left to the caller.
  assert.equal(presenter.handleEvent({ kind: "login.polling" }), false);
  presenter.cleanup();
});

test("presenter: a terminal result stops reading keys and restores the terminal", () => {
  const input = fakeTty();
  const presenter = createLoopbackLoginPresenter({ input, environment: { stdoutIsTTY: true, env: {}, platform: "darwin" } });
  captureStdout(() => {
    presenter.handleEvent({
      kind: "login.loopback-waiting",
      approvalUrl: "https://app.example/login/device?request=r",
      expiresAt: new Date().toISOString(),
      expiresInSeconds: 600,
      canSwitchToCode: true,
    });
  });
  assert.equal(input.isRaw, true);
  presenter.handleEvent({ kind: "login.loopback.result", result: "state_mismatch" });
  assert.equal(input.isRaw, true);
  presenter.handleEvent({ kind: "login.loopback.result", result: "denied", msToResult: 5 });
  assert.equal(input.isRaw, false);
  input.write("c");
  assert.equal(presenter.options.switchToDeviceCode?.aborted, false);
});

test("presenter: quiet reasons print nothing", () => {
  const presenter = createLoopbackLoginPresenter({ input: fakeTty() });
  for (const reason of ["no_tty", "flag", "no_grant", "server_unsupported"] as const) {
    assert.deepEqual(captureStdout(() => presenter.handleEvent({ kind: "login.mode", mode: "device_code", reason })), []);
  }
  assert.equal(
    captureStdout(() => presenter.handleEvent({ kind: "login.mode", mode: "device_code", reason: "ssh" })).length,
    1,
  );
});

test("presenter: a device code from a --pair authorize traces only whether it paired", () => {
  const tracer = recordingTracer();
  const presenter = createLoopbackLoginPresenter({ input: fakeTty(), tracer });
  const code = { kind: "login.device-code", verifyUrl: "https://app.example/login/device", userCode: "ABCD-1234", expiresAt: new Date().toISOString(), expiresInSeconds: 600 } as const;
  assert.equal(presenter.handleEvent({ ...code, paired: true }), false);
  presenter.handleEvent({ ...code, paired: false });
  // Without --pair the event has no `paired`: nothing is traced.
  presenter.handleEvent(code);
  assert.deepEqual(tracer.events, [
    { name: "computer.login.pairing", attrs: { pairing_sent: true, paired: true } },
    { name: "computer.login.pairing", attrs: { pairing_sent: true, paired: false } },
  ]);
});
