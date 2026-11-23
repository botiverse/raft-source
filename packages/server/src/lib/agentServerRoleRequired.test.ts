import { beforeEach, describe, expect, it, vi } from "vitest";

const getActorServerRoleInServer = vi.fn();
vi.mock("./actorPermissions", () => ({ getActorServerRoleInServer: (...args: unknown[]) => getActorServerRoleInServer(...args) }));

const { agentServerRoleRequiredBody, AGENT_SERVER_ROLE_REQUIRED_CODE } = await import("./agentServerRoleRequired");

describe("agentServerRoleRequiredBody", () => {
  beforeEach(() => getActorServerRoleInServer.mockReset());

  it("names both roles when a higher server role is needed, in the step only", async () => {
    getActorServerRoleInServer.mockResolvedValue("member");
    const body = await agentServerRoleRequiredBody({
      serverId: "s1",
      agentId: "a1",
      capabilities: ["editServerSettings"],
      action: "edit the server profile",
    });
    expect(getActorServerRoleInServer).toHaveBeenCalledWith("s1", "agent", "a1");
    expect(body).toEqual({
      error: "Agent requires editServerSettings capability to edit the server profile",
      code: AGENT_SERVER_ROLE_REQUIRED_CODE,
      suggestedNextAction:
        "To edit the server profile you need the admin role on this server; your role is member. Ask a server owner or admin to do it, or to change your role.",
    });
  });

  it("takes the lowest role across alternative capabilities", async () => {
    getActorServerRoleInServer.mockResolvedValue("guest");
    const body = await agentServerRoleRequiredBody({
      serverId: "s1",
      agentId: "a1",
      capabilities: ["editChannelMetadata", "createPublicChannels"],
      action: "update channels",
    });
    expect(body.suggestedNextAction).toBe(
      "To update channels you need the member role on this server; your role is guest. Ask a server owner or admin to do it, or to change your role.",
    );
  });

  it("does not ask for a role change when the server role is already high enough", async () => {
    // A member may add channel members, but only in channels it is already in.
    getActorServerRoleInServer.mockResolvedValue("member");
    const body = await agentServerRoleRequiredBody({
      serverId: "s1",
      agentId: "a1",
      capabilities: ["addChannelMembers"],
      action: "add channel members",
    });
    expect(body.suggestedNextAction).toBe(
      "Your role on this server or channel does not allow you to add channel members here (your role is member). Ask a server owner or admin to do it.",
    );
  });

  it("says so when the agent is not a server member", async () => {
    getActorServerRoleInServer.mockResolvedValue(null);
    const body = await agentServerRoleRequiredBody({
      serverId: "s1",
      agentId: "a1",
      capabilities: ["createPublicChannels"],
      action: "create channels",
    });
    expect(body.suggestedNextAction).toContain("you are not a member of this server");
  });

  it("on a joint channel names the host server's managers, whatever the role here", async () => {
    // No role on another server allows archive/edit/remove on a joint channel,
    // so "ask a server owner or admin" would point at the wrong server.
    for (const role of ["admin", "member"] as const) {
      getActorServerRoleInServer.mockResolvedValue(role);
      const body = await agentServerRoleRequiredBody({
        serverId: "s1",
        agentId: "a1",
        capabilities: ["archiveChannels"],
        action: "archive channels",
        jointChannel: "shared-ops",
      });
      expect(body.code).toBe(AGENT_SERVER_ROLE_REQUIRED_CODE);
      expect(body.suggestedNextAction).toBe(
        "On a joint channel only its host server's owners, admins and channel managers can archive channels; ask one of them to do it in #shared-ops.",
      );
    }
  });
});
