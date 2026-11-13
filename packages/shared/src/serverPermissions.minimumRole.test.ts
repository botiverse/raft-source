import { describe, expect, it } from "vitest";
import { minimumServerRoleWithCapability } from "./serverPermissions";

describe("minimumServerRoleWithCapability", () => {
  it("returns the lowest role the matrix grants", () => {
    expect(minimumServerRoleWithCapability("createChannels")).toBe("member");
    expect(minimumServerRoleWithCapability("changeChannelVisibility")).toBe("admin");
    expect(minimumServerRoleWithCapability("manageBilling")).toBe("owner");
    expect(minimumServerRoleWithCapability("manageSso")).toBe("owner");
  });
});
