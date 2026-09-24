import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { createComputerApi } from "./api.js";
import { ComputerError } from "./errors.js";
import { ServiceClientError, type ServiceClient } from "./types.js";

const TARGET_VERSION = "1.0.25";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-api-upgrade-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function serviceClient(
  request: (method: string, params: unknown) => Promise<unknown>,
): ServiceClient {
  return {
    async request(method, params) {
      return request(method, params) as never;
    },
    events: {
      async *[Symbol.asyncIterator]() {
        // Upgrade routing tests need only the request receipt.
      },
    },
    async close() {},
  };
}

test("a live local service with zero managed Servers receives exactly one local upgrade-start", async () => {
  await withHome(async (home) => {
    const methods: string[] = [];
    const starts: unknown[] = [];
    const client = serviceClient(async (method, params) => {
      methods.push(method);
      assert.equal(method, "upgrade-start", "local upgrade must not perform machine attestation");
      starts.push(params);
      return {
        status: "started",
        upgradeId: (params as { requestId: string }).requestId,
        targetVersion: TARGET_VERSION,
      };
    });

    assert.deepEqual(await createComputerApi(home, {
      upgradeRoutingDeps: {
        connectServiceFn: async () => client,
      },
    }).tryUpgradeViaService(TARGET_VERSION, undefined, { trigger: "cli" }), {
      routed: true,
    });

    assert.deepEqual(methods, ["upgrade-start"]);
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0], {
      scope: "local",
      requestId: (starts[0] as { requestId: string }).requestId,
      targetVersion: TARGET_VERSION,
      trigger: "cli",
    });
    assert.match((starts[0] as { requestId: string }).requestId, /^[0-9a-f-]{36}$/u);
    assert.equal("originServerId" in (starts[0] as object), false);
  });
});

test("an unusable local Server session is irrelevant and performs zero Server HTTP", async () => {
  await withHome(async (home) => {
    const starts: unknown[] = [];
    const client = serviceClient(async (method, params) => {
      assert.equal(method, "upgrade-start");
      starts.push(params);
      return {
        status: "started",
        upgradeId: (params as { requestId: string }).requestId,
        targetVersion: TARGET_VERSION,
      };
    });

    assert.deepEqual(await createComputerApi(home, {
      upgradeRoutingDeps: {
        connectServiceFn: async () => client,
      },
    }).tryUpgradeViaService(TARGET_VERSION, undefined, { trigger: "tray" }), {
      routed: true,
    });

    assert.equal(starts.length, 1);
    assert.equal((starts[0] as { scope?: string }).scope, "local");
    assert.equal((starts[0] as { trigger?: string }).trigger, "tray");
  });
});

test("live pid plus broken IPC stays typed unreachable and never reaches a local start", async () => {
  await withHome(async (home) => {
    const result = await createComputerApi(home, {
      upgradeRoutingDeps: {
        connectServiceFn: async () => {
          throw new ServiceClientError("IPC_CLIENT_CLOSED", "socket unavailable");
        },
        findLiveServicePidReadOnlyFn: async () => ({
          pid: 4321,
          pidfilePath: "/run/service.pid",
          firstStalePidfile: null,
          firstStalePid: null,
        }),
      },
    }).tryUpgradeViaService(TARGET_VERSION);

    assert.deepEqual(result, { routed: false, reason: "unreachable" });
  });
});

test("a definitive K rejection stays typed and does not claim a Server cleanup path", async () => {
  await withHome(async (home) => {
    const client = serviceClient(async (method) => {
      assert.equal(method, "upgrade-start");
      throw new ServiceClientError(
        "UPGRADE_START_REJECTED",
        "K_UPGRADE_COORDINATOR_REJECTED: The upgrade coordinator exited before accepting the request; nothing was swapped.",
      );
    });

    await assert.rejects(
      createComputerApi(home, {
        upgradeRoutingDeps: {
          connectServiceFn: async () => client,
        },
      }).tryUpgradeViaService(TARGET_VERSION),
      (error: unknown) => {
        assert.ok(error instanceof ComputerError);
        assert.equal(error.code, "UPGRADE_START_REJECTED");
        assert.match(error.message, /^K_UPGRADE_COORDINATOR_REJECTED:/u);
        return true;
      },
    );
  });
});
