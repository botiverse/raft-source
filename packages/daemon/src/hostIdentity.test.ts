import { describe, expect, it } from "vitest";

import {
  hostIdHashForServer,
  normalizeHardwareId,
  parseIoregPlatformUuid,
  parseRegMachineGuid,
  readHardwareId,
} from "./hostIdentity";

const MACHINE_ID = "8a7b6c5d4e3f4a1b9c2d0e1f2a3b4c5d";

describe("hostIdHashForServer", () => {
  it("is stable for one machine and server, and 32 hex chars", () => {
    const hash = hostIdHashForServer(MACHINE_ID, "server-a");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hostIdHashForServer(MACHINE_ID, "server-a")).toBe(hash);
  });

  it("differs between servers for the same machine, and between machines on one server", () => {
    expect(hostIdHashForServer(MACHINE_ID, "server-a")).not.toBe(hostIdHashForServer(MACHINE_ID, "server-b"));
    expect(hostIdHashForServer(MACHINE_ID, "server-a")).not.toBe(hostIdHashForServer("ffeeddccbbaa99887766554433221100", "server-a"));
  });

  it("never contains the hardware ID", () => {
    expect(hostIdHashForServer(MACHINE_ID, "server-a")).not.toContain(MACHINE_ID.slice(0, 12));
  });
});

describe("normalizeHardwareId", () => {
  it("accepts machine-id, UUID and GUID forms, case- and dash-insensitively", () => {
    expect(normalizeHardwareId(`${MACHINE_ID}\n`)).toBe(MACHINE_ID);
    expect(normalizeHardwareId("12345678-ABCD-4EF0-9123-456789ABCDEF")).toBe("12345678abcd4ef09123456789abcdef");
  });

  it("rejects empty, short, all-zero and non-hex values", () => {
    expect(normalizeHardwareId(undefined)).toBeUndefined();
    expect(normalizeHardwareId("")).toBeUndefined();
    expect(normalizeHardwareId("abc123")).toBeUndefined();
    expect(normalizeHardwareId("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(normalizeHardwareId("uninitialized")).toBeUndefined();
  });
});

describe("parsers", () => {
  it("reads IOPlatformUUID from ioreg output", () => {
    const output = `+-o J314sAP  <class IOPlatformExpertDevice>\n    {\n      "IOPlatformSerialNumber" = "SERIAL"\n      "IOPlatformUUID" = "12345678-ABCD-4EF0-9123-456789ABCDEF"\n    }\n`;
    expect(parseIoregPlatformUuid(output)).toBe("12345678-ABCD-4EF0-9123-456789ABCDEF");
    expect(parseIoregPlatformUuid("nothing here")).toBeUndefined();
  });

  it("reads MachineGuid from reg query output", () => {
    const output = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\r\n";
    expect(parseRegMachineGuid(output)).toBe("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
  });
});

describe("readHardwareId", () => {
  it("Linux reads /etc/machine-id, falling back to the dbus copy", async () => {
    await expect(readHardwareId("linux", { readFile: (f) => (f === "/etc/machine-id" ? `${MACHINE_ID}\n` : undefined) })).resolves.toBe(MACHINE_ID);
    await expect(readHardwareId("linux", { readFile: (f) => (f === "/var/lib/dbus/machine-id" ? MACHINE_ID : undefined) })).resolves.toBe(MACHINE_ID);
    await expect(readHardwareId("linux", { readFile: () => undefined })).resolves.toBeUndefined();
  });

  it("macOS and Windows read their system IDs; a failed command is unknown", async () => {
    const ioreg = `"IOPlatformUUID" = "12345678-ABCD-4EF0-9123-456789ABCDEF"`;
    await expect(readHardwareId("darwin", { run: async () => ioreg })).resolves.toBe("12345678abcd4ef09123456789abcdef");
    await expect(readHardwareId("win32", { run: async () => "MachineGuid    REG_SZ    0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" })).resolves.toBe("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
    await expect(readHardwareId("darwin", { run: async () => undefined })).resolves.toBeUndefined();
    await expect(readHardwareId("darwin", { run: async () => { throw new Error("spawn failed"); } })).resolves.toBeUndefined();
  });
});
