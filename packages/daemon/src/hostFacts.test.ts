import { describe, expect, it } from "vitest";

import { HOST_PROVIDER_LABELS, OS_RELEASE_MAX_LENGTH } from "@botiverse/raft-shared";
import { classifyHostProvider, detectContainer, detectHostFacts, parseMacSystemVersion, parseOsIds, parseOsRelease } from "./hostFacts";

const noDirs = () => false;

describe("classifyHostProvider", () => {
  it.each([
    [{ sysVendor: "Amazon EC2\n", productName: "m6i.large\n" }, "aws"],
    [{ sysVendor: "Google\n", productName: "Google Compute Engine\n" }, "gcp"],
    [{ sysVendor: "Hetzner\n", productName: "vServer\n" }, "hetzner"],
    [{ sysVendor: "DigitalOcean\n", productName: "Droplet\n" }, "digitalocean"],
    [{ sysVendor: "Vultr\n", productName: "VC2\n" }, "vultr"],
    [{ sysVendor: "Linode\n", productName: "Compute Instance\n" }, "linode"],
    [{ sysVendor: "Akamai\n", productName: "Compute Instance\n" }, "linode"],
    [{ sysVendor: "Scaleway\n", productName: "SCW-DEV1-S\n" }, "scaleway"],
    [{ sysVendor: "Alibaba Cloud\n", productName: "Alibaba Cloud ECS\n" }, "alibaba"],
    [{ sysVendor: "UpCloud\n", productName: "Cloud Server\n" }, "upcloud"],
    [{ sysVendor: "QEMU\n", productName: "Exoscale Compute Platform\n" }, "exoscale"],
    [{ sysVendor: "OpenStack Foundation\n", productName: "OpenStack Nova\n" }, "openstack"],
  ])("DMI %j → %s", (files, expected) => {
    expect(classifyHostProvider(files, noDirs)).toBe(expected);
  });

  it("platform folders and the Fly.io kernel suffix need no firmware name", () => {
    expect(classifyHostProvider({}, (dir) => dir === "/exe.dev")).toBe("exe_dev");
    expect(classifyHostProvider({}, (dir) => dir === "/.sprite")).toBe("sprites");
    expect(classifyHostProvider({ kernelRelease: "6.1.98-fly\n" }, noDirs)).toBe("fly");
  });

  it("personal machines, unverified clouds and plain hypervisors are not recognized", () => {
    expect(classifyHostProvider({ sysVendor: "Dell Inc.\n", productName: "XPS 13 9310\n" }, noDirs)).toBeUndefined();
    expect(classifyHostProvider({ sysVendor: "LENOVO\n", productName: "21CB\n" }, noDirs)).toBeUndefined();
    // Oracle Cloud is identified by its chassis asset tag, Tencent Cloud has no source: both stay a plain VM.
    expect(classifyHostProvider({ sysVendor: "QEMU\n", productName: "Standard PC (i440FX + PIIX, 1996)\n" }, noDirs)).toBeUndefined();
    expect(classifyHostProvider({ sysVendor: "Tencent Cloud\n", productName: "CVM\n" }, noDirs)).toBeUndefined();
    expect(classifyHostProvider({ sysVendor: "Microsoft Corporation\n", productName: "Virtual Machine\n" }, noDirs)).toBeUndefined();
    expect(classifyHostProvider({}, noDirs)).toBeUndefined();
  });

  it("every id it can return has a display name", () => {
    for (const id of ["aws", "gcp", "hetzner", "digitalocean", "vultr", "linode", "scaleway", "alibaba", "upcloud", "exoscale", "openstack", "exe_dev", "sprites", "fly"]) {
      expect(HOST_PROVIDER_LABELS).toHaveProperty(id);
    }
  });
});

describe("detectContainer", () => {
  it("Docker and Podman marker files, or a container cgroup on PID 1", () => {
    expect(detectContainer(() => undefined, (file) => file === "/.dockerenv")).toBe(true);
    expect(detectContainer(() => undefined, (file) => file === "/run/.containerenv")).toBe(true);
    expect(detectContainer(() => "12:pids:/kubepods/burstable/pod1234/abcd\n", noDirs)).toBe(true);
    expect(detectContainer(() => "0::/init.scope\n", noDirs)).toBe(false);
    expect(detectContainer(() => undefined, noDirs)).toBe(false);
  });
});

describe("parseOsRelease", () => {
  it("NAME + VERSION_ID, else PRETTY_NAME, else NAME", () => {
    expect(parseOsRelease('PRETTY_NAME="Ubuntu 26.04 LTS"\nNAME="Ubuntu"\nVERSION_ID="26.04"\nID=ubuntu\n')).toBe("Ubuntu 26.04");
    expect(parseOsRelease('NAME="Debian GNU/Linux"\nVERSION_ID="12"\n')).toBe("Debian GNU/Linux 12");
    expect(parseOsRelease('PRETTY_NAME="Arch Linux"\nNAME="Arch Linux"\nID=arch\n')).toBe("Arch Linux");
    expect(parseOsRelease("NAME=Alpine\n")).toBe("Alpine");
  });

  it("missing, empty, oversize or control characters are unknown", () => {
    expect(parseOsRelease(undefined)).toBeUndefined();
    expect(parseOsRelease("ID=thing\n")).toBeUndefined();
    expect(parseOsRelease(`NAME="${"x".repeat(OS_RELEASE_MAX_LENGTH + 1)}"\n`)).toBeUndefined();
    expect(parseOsRelease('NAME="Bad\u0007Name"\n')).toBeUndefined();
  });
});

describe("parseOsIds", () => {
  it("ID and ID_LIKE, for picking a distribution icon", () => {
    expect(parseOsIds('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n')).toEqual({ osId: "ubuntu", osIdLike: ["debian"] });
    expect(parseOsIds('NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\n')).toEqual({ osId: "rocky", osIdLike: ["rhel", "centos", "fedora"] });
    expect(parseOsIds('ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"\n')).toEqual({ osId: "opensuse-tumbleweed", osIdLike: ["opensuse", "suse"] });
    expect(parseOsIds("ID=arch\n")).toEqual({ osId: "arch" });
  });

  it("ids outside the os-release spec are dropped; ID_LIKE keeps at most four", () => {
    expect(parseOsIds('ID="Ubuntu Linux"\nID_LIKE="Debian ok a b c d"\n')).toEqual({ osIdLike: ["ok", "a", "b", "c"] });
    expect(parseOsIds(`ID=${"x".repeat(33)}\n`)).toEqual({});
    expect(parseOsIds(undefined)).toEqual({});
  });
});

describe("detectHostFacts", () => {
  const hetznerVm: Record<string, string> = {
    "/etc/os-release": 'NAME="Ubuntu"\nVERSION_ID="26.04"\nID=ubuntu\nID_LIKE=debian\n',
    "/proc/sys/kernel/osrelease": "6.8.0-45-generic\n",
    "/sys/class/dmi/id/chassis_type": "1\n",
    "/sys/class/dmi/id/sys_vendor": "Hetzner\n",
    "/sys/class/dmi/id/product_name": "vServer\n",
  };

  it("a Hetzner VM: provider, OS release, and vm whatever the chassis says", async () => {
    await expect(detectHostFacts("linux", { readFile: (file) => hetznerVm[file], exists: noDirs }))
      .resolves.toEqual({ deviceClass: "vm", hostProvider: "hetzner", osRelease: "Ubuntu 26.04", osId: "ubuntu", osIdLike: ["debian"] });
  });

  it("a container keeps the provider and reports container", async () => {
    await expect(detectHostFacts("linux", { readFile: (file) => hetznerVm[file], exists: (file) => file === "/.dockerenv" }))
      .resolves.toEqual({ deviceClass: "container", hostProvider: "hetzner", osRelease: "Ubuntu 26.04", osId: "ubuntu", osIdLike: ["debian"] });
  });

  it("a personal Linux laptop reports no provider", async () => {
    const files: Record<string, string> = {
      "/etc/os-release": 'NAME="Fedora Linux"\nVERSION_ID=42\n',
      "/proc/sys/kernel/osrelease": "6.14.0-fc42\n",
      "/sys/class/dmi/id/chassis_type": "10\n",
      "/sys/class/dmi/id/sys_vendor": "LENOVO\n",
    };
    await expect(detectHostFacts("linux", { readFile: (file) => files[file], exists: noDirs }))
      .resolves.toEqual({ deviceClass: "laptop", osRelease: "Fedora Linux 42" });
  });

  it("WSL reports only its OS release; macOS and Windows report no provider or OS release", async () => {
    const files: Record<string, string> = {
      "/etc/os-release": 'NAME="Ubuntu"\nVERSION_ID="24.04"\n',
      "/proc/sys/kernel/osrelease": "5.15.153.1-microsoft-standard-WSL2\n",
      "/sys/class/dmi/id/sys_vendor": "Microsoft Corporation\n",
    };
    await expect(detectHostFacts("linux", { readFile: (file) => files[file], exists: () => true }))
      .resolves.toEqual({ osRelease: "Ubuntu 24.04" });
    await expect(detectHostFacts("darwin", { macHardware: async () => undefined })).resolves.toEqual({});
    await expect(detectHostFacts("win32")).resolves.toEqual({});
  });

  it("unreadable files leave everything unknown", async () => {
    await expect(detectHostFacts("linux", { readFile: () => undefined, exists: noDirs })).resolves.toEqual({});
    await expect(detectHostFacts("linux", { readFile: () => { throw new Error("EACCES"); }, exists: noDirs })).resolves.toEqual({});
  });
});

const MAC_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>BuildID</key>
	<string>3B2C1A00-0000-0000-0000-000000000000</string>
	<key>ProductBuildVersion</key>
	<string>23F79</string>
	<key>ProductName</key>
	<string>macOS</string>
	<key>ProductVersion</key>
	<string>14.5</string>
</dict>
</plist>
`;

describe("parseMacSystemVersion", () => {
  it("reads ProductName and ProductVersion", () => {
    expect(parseMacSystemVersion(MAC_PLIST)).toBe("macOS 14.5");
  });
  it("falls back to macOS when the name is missing", () => {
    expect(parseMacSystemVersion("<key>ProductVersion</key><string>12.7.6</string>")).toBe("macOS 12.7.6");
  });
  it.each([undefined, "", "<key>ProductVersion</key><string>not-a-version</string>", "<dict></dict>"])("unknown for %j", (text) => {
    expect(parseMacSystemVersion(text)).toBeUndefined();
  });
});

describe("detectHostFacts on macOS", () => {
  it("reports the macOS version from SystemVersion.plist and never reads Linux files", async () => {
    const read: string[] = [];
    const facts = await detectHostFacts("darwin", {
      macHardware: async () => undefined,
      readFile: (file) => { read.push(file); return file === "/System/Library/CoreServices/SystemVersion.plist" ? MAC_PLIST : undefined; },
      exists: noDirs,
    });
    expect(facts.osRelease).toBe("macOS 14.5");
    expect(read.filter((file) => file.startsWith("/etc") || file.startsWith("/sys") || file.startsWith("/proc"))).toEqual([]);
  });
  it("leaves osRelease unknown when the plist is unreadable", async () => {
    const facts = await detectHostFacts("darwin", { macHardware: async () => undefined, readFile: () => undefined, exists: noDirs });
    expect(facts.osRelease).toBeUndefined();
  });
});
