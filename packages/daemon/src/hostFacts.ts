import { existsSync } from "node:fs";

import { OS_ID_LIKE_MAX, normalizeOsId, normalizeOsRelease, type DeviceClass, type HostProvider } from "@botiverse/raft-shared";
import { detectDeviceClass, readOptional } from "./deviceClass";

/**
 * What the Computer reports about the machine it runs on: the device class,
 * the cloud / VM platform and the OS release (Linux `/etc/os-release`,
 * macOS `SystemVersion.plist`). Everything is worked out here
 * from local, world-readable files; only these results leave the machine,
 * never the DMI strings, serials, UUIDs or paths they come from. Nothing is
 * spawned and no cloud API is called. Unknown → undefined, nothing guessed.
 */
export interface HostFacts {
  deviceClass?: DeviceClass;
  hostProvider?: HostProvider;
  osRelease?: string;
  osId?: string;
  osIdLike?: string[];
}

export interface LinuxHostFiles {
  sysVendor?: string;
  productName?: string;
  kernelRelease?: string;
}

// Each row matches the trimmed DMI string from its start, case-insensitively,
// and cites where the string comes from. Keep only verified rows: a platform
// that is not listed shows as a plain VM. Not listed on purpose: Oracle Cloud
// (identified by chassis asset tag `OracleCloud.com`, not the vendor), Tencent
// Cloud (no source found), Azure (its vendor string is the same as local Hyper-V).
const DMI_PROVIDERS: ReadonlyArray<{ provider: HostProvider; field: "sysVendor" | "productName"; prefix: RegExp }> = [
  // systemd src/basic/virt.c dmi_vendor_table; cloud-init ds-identify (Ec2).
  { provider: "aws", field: "sysVendor", prefix: /^amazon ec2/i },
  // cloud-init ds-identify dscheck_GCE.
  { provider: "gcp", field: "productName", prefix: /^google compute engine/i },
  // cloud-init ds-identify dscheck_Hetzner; also seen on our Hetzner machines.
  { provider: "hetzner", field: "sysVendor", prefix: /^hetzner/i },
  // cloud-init ds-identify dscheck_DigitalOcean.
  { provider: "digitalocean", field: "sysVendor", prefix: /^digitalocean/i },
  // cloud-init ds-identify dscheck_Vultr.
  { provider: "vultr", field: "sysVendor", prefix: /^vultr/i },
  // cloud-init ds-identify dscheck_Akamai.
  { provider: "linode", field: "sysVendor", prefix: /^(linode|akamai)/i },
  // cloud-init ds-identify dscheck_Scaleway.
  { provider: "scaleway", field: "sysVendor", prefix: /^scaleway/i },
  // cloud-init ds-identify dscheck_AliYun.
  { provider: "alibaba", field: "productName", prefix: /^alibaba cloud ecs/i },
  // cloud-init ds-identify dscheck_UpCloud.
  { provider: "upcloud", field: "sysVendor", prefix: /^upcloud/i },
  // cloud-init ds-identify dscheck_Exoscale.
  { provider: "exoscale", field: "productName", prefix: /^exoscale/i },
  // cloud-init ds-identify dscheck_OpenStack.
  { provider: "openstack", field: "productName", prefix: /^openstack (nova|compute)/i },
];

// Platforms whose firmware names nobody, recognized by a folder they keep on
// their VMs (checked on machines we use).
const PLATFORM_DIRS: ReadonlyArray<[string, HostProvider]> = [
  ["/exe.dev", "exe_dev"],
  ["/.sprite", "sprites"],
];

/** Platform folders, then the Fly.io kernel suffix, then DMI vendor / product. */
export function classifyHostProvider(files: LinuxHostFiles, exists: (path: string) => boolean = existsSync): HostProvider | undefined {
  for (const [dir, provider] of PLATFORM_DIRS) {
    if (exists(dir)) return provider;
  }
  // Fly.io kernels end in `-fly` (checked on a Fly machine).
  if (/-fly$/i.test((files.kernelRelease ?? "").trim())) return "fly";
  for (const row of DMI_PROVIDERS) {
    if (row.prefix.test((files[row.field] ?? "").trim())) return row.provider;
  }
  return undefined;
}

const CONTAINER_MARKERS = ["/.dockerenv", "/run/.containerenv"];
const CONTAINER_CGROUP = /\b(docker|kubepods|containerd|libpod|lxc)\b/;

/** Docker / Podman marker files, or PID 1 in a container cgroup (cgroup v1). */
export function detectContainer(read: (file: string) => string | undefined, exists: (path: string) => boolean = existsSync): boolean {
  if (CONTAINER_MARKERS.some((marker) => exists(marker))) return true;
  return CONTAINER_CGROUP.test(read("/proc/1/cgroup") ?? "");
}

function osReleaseFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    fields.set(match[1]!, match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  return fields;
}

/** `/etc/os-release` → "NAME VERSION_ID" (else PRETTY_NAME, else NAME). */
export function parseOsRelease(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const fields = osReleaseFields(text);
  const name = fields.get("NAME");
  const version = fields.get("VERSION_ID");
  const candidate = name && version ? `${name} ${version}` : (fields.get("PRETTY_NAME") ?? name);
  return normalizeOsRelease(candidate) ?? undefined;
}

/**
 * macOS `SystemVersion.plist` (world-readable XML) → "macOS 14.5": the
 * `ProductName` and `ProductVersion` string values. Unknown → undefined.
 */
export function parseMacSystemVersion(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const value = (key: string) => text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1]?.trim();
  const version = value("ProductVersion");
  if (!version || !/^\d+(\.\d+){0,2}$/.test(version)) return undefined;
  return normalizeOsRelease(`${value("ProductName") || "macOS"} ${version}`) ?? undefined;
}

/** `/etc/os-release` → machine-readable `ID` and `ID_LIKE` (spec-valid ids only). */
export function parseOsIds(text: string | undefined): { osId?: string; osIdLike?: string[] } {
  if (!text) return {};
  const fields = osReleaseFields(text);
  const osId = normalizeOsId(fields.get("ID"));
  const osIdLike = (fields.get("ID_LIKE") ?? "").split(/\s+/).filter((id) => normalizeOsId(id) !== null).slice(0, OS_ID_LIKE_MAX);
  return { ...(osId ? { osId } : {}), ...(osIdLike.length > 0 ? { osIdLike } : {}) };
}

export async function detectHostFacts(
  platform: NodeJS.Platform = process.platform,
  io: {
    macHardware?: () => Promise<string | undefined>;
    readFile?: (file: string) => string | undefined;
    exists?: (path: string) => boolean;
  } = {},
): Promise<HostFacts> {
  const facts: HostFacts = {};
  const deviceClass = await detectDeviceClass(platform, io);
  if (deviceClass) facts.deviceClass = deviceClass;
  if (platform === "darwin") {
    try {
      const read = io.readFile ?? readOptional;
      const osRelease = parseMacSystemVersion(read("/System/Library/CoreServices/SystemVersion.plist"));
      if (osRelease) facts.osRelease = osRelease;
    } catch {
      // Unknown stays unknown.
    }
    return facts;
  }
  if (platform !== "linux") return facts;
  try {
    const read = io.readFile ?? readOptional;
    const exists = io.exists ?? existsSync;
    const osReleaseText = read("/etc/os-release") ?? read("/usr/lib/os-release");
    const osRelease = parseOsRelease(osReleaseText);
    if (osRelease) facts.osRelease = osRelease;
    Object.assign(facts, parseOsIds(osReleaseText));
    const kernelRelease = read("/proc/sys/kernel/osrelease");
    // WSL sees no host firmware; the Server already has os_variant for it.
    if (/microsoft/i.test(kernelRelease ?? "")) return facts;
    const hostProvider = classifyHostProvider({
      sysVendor: read("/sys/class/dmi/id/sys_vendor"),
      productName: read("/sys/class/dmi/id/product_name"),
      kernelRelease,
    }, exists);
    if (hostProvider) facts.hostProvider = hostProvider;
    if (detectContainer(read, exists)) facts.deviceClass = "container";
    // A recognized platform runs its machines as VMs, whatever the chassis says.
    else if (hostProvider) facts.deviceClass = "vm";
  } catch {
    // Any failure leaves the rest unknown.
  }
  return facts;
}

let cached: Promise<HostFacts> | undefined;
let known: HostFacts = {};

/** Start (once per daemon process) detecting this host's facts. */
export function hostFacts(): Promise<HostFacts> {
  cached ??= detectHostFacts().then((value) => {
    known = value;
    return value;
  });
  return cached;
}

/** The facts if detection has finished, without waiting; empty until then. */
export function knownHostFacts(): HostFacts {
  return known;
}
