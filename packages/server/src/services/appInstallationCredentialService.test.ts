import assert from "node:assert/strict";

import {
  AppInstallationDiscoveryInvariantError,
  discoverActiveAppInstallation,
} from "./appInstallationCredentialService";
import { getDb } from "../db/index";

describe("discoverActiveAppInstallation", () => {
  it("turns an impossible duplicate App/Server match into a platform error, not installation absence", async () => {
    const limit = vi.fn().mockResolvedValue([
      { installationId: "install-a", serverId: "server-a", serverSlug: "a", serverName: "A" },
      { installationId: "install-b", serverId: "server-a", serverSlug: "a", serverName: "A" },
    ]);
    // from(installs).innerJoin(clients).innerJoin(servers).where(...).limit(2)
    const joined: { innerJoin: unknown; where: unknown } = {
      innerJoin: vi.fn(() => joined),
      where: vi.fn(() => ({ limit })),
    };
    const fakeDb = {
      select: vi.fn(() => ({ from: vi.fn(() => joined) })),
    } as unknown as ReturnType<typeof getDb>;

    await assert.rejects(
      discoverActiveAppInstallation({ clientId: "client-a", serverId: "server-a" }, fakeDb),
      AppInstallationDiscoveryInvariantError,
    );
    assert.deepEqual(limit.mock.calls, [[2]]);
  });
});
