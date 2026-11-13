import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

import { ambientProcessEnv } from "./processEnvPatch";

import type { DeviceClass } from "@botiverse/raft-shared";

/**
 * A coarse kind of machine for the Computer icon (laptop, Mac mini, server,
 * ...). Only the category leaves the machine: the model name, model id and
 * DMI strings it is derived from are read here and dropped. Unknown or
 * unreadable → undefined, and the UI falls back to an icon by OS.
 */

const MAC_MODEL_NAMES: ReadonlyArray<[RegExp, DeviceClass]> = [
  [/^macbook/i, "laptop"],
  [/^mac mini/i, "mini"],
  [/^mac studio/i, "studio"],
  [/^imac/i, "imac"],
  [/^mac pro/i, "desktop"],
];

/** `system_profiler SPHardwareDataType -json` output → category. */
export function classifyMacHardware(json: string): DeviceClass | undefined {
  let item: { machine_name?: unknown; machine_model?: unknown } | undefined;
  try {
    item = (JSON.parse(json) as { SPHardwareDataType?: Array<typeof item> }).SPHardwareDataType?.[0];
  } catch {
    return undefined;
  }
  if (typeof item?.machine_model === "string" && /^VirtualMac/i.test(item.machine_model)) return "vm";
  const name = typeof item?.machine_name === "string" ? item.machine_name.trim() : "";
  return MAC_MODEL_NAMES.find(([pattern]) => pattern.test(name))?.[1];
}

// SMBIOS 3.x chassis types (DMTF DSP0134 §7.4.1).
const LAPTOP_CHASSIS = new Set([8, 9, 10, 14, 31, 32]);
const DESKTOP_CHASSIS = new Set([3, 4, 5, 6, 7, 13, 15, 16, 35, 36]);
const SERVER_CHASSIS = new Set([17, 23, 28, 29]);
const VM_VENDOR = /qemu|kvm|vmware|virtualbox|innotek|xen|bochs|parallels|amazon ec2|google compute engine|microsoft corporation virtual|hyper-v|openstack|digitalocean|hetzner vserver/i;

export interface LinuxDmi {
  chassisType?: string;
  sysVendor?: string;
  productName?: string;
  hypervisorType?: string;
}

/** Linux DMI fields (sysfs, world-readable) → category. */
export function classifyLinuxDmi(dmi: LinuxDmi): DeviceClass | undefined {
  const vendor = `${(dmi.sysVendor ?? "").trim()} ${(dmi.productName ?? "").trim()}`;
  if (VM_VENDOR.test(vendor) || (dmi.hypervisorType ?? "").trim() !== "") return "vm";
  const chassis = Number.parseInt((dmi.chassisType ?? "").trim(), 10);
  if (LAPTOP_CHASSIS.has(chassis)) return "laptop";
  if (DESKTOP_CHASSIS.has(chassis)) return "desktop";
  if (SERVER_CHASSIS.has(chassis)) return "server";
  return undefined;
}

export function readOptional(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

const MAC_PROFILER_TIMEOUT_MS = 5_000;

function readMacHardware(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "/usr/sbin/system_profiler",
      ["SPHardwareDataType", "-json"],
      { timeout: MAC_PROFILER_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, env: ambientProcessEnv() },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

export async function detectDeviceClass(
  platform: NodeJS.Platform = process.platform,
  io: { macHardware?: () => Promise<string | undefined>; readFile?: (file: string) => string | undefined } = {},
): Promise<DeviceClass | undefined> {
  try {
    if (platform === "darwin") {
      const json = await (io.macHardware ?? readMacHardware)();
      return json === undefined ? undefined : classifyMacHardware(json);
    }
    if (platform === "linux") {
      const read = io.readFile ?? readOptional;
      // WSL sees no host DMI; the Server already has os_variant for it.
      if (/microsoft/i.test(read("/proc/sys/kernel/osrelease") ?? "")) return undefined;
      return classifyLinuxDmi({
        chassisType: read("/sys/class/dmi/id/chassis_type"),
        sysVendor: read("/sys/class/dmi/id/sys_vendor"),
        productName: read("/sys/class/dmi/id/product_name"),
        hypervisorType: read("/sys/hypervisor/type"),
      });
    }
  } catch {
    // Any failure means "unknown"; the icon falls back to the OS.
  }
  return undefined;
}
