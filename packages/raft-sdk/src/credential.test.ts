import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  bootstrapRaftCredential,
  createFileCredentialStore,
  createRaftClientFromStore,
  RaftCredentialError,
  RaftSdkConfigurationError,
  type RaftCredentialStore,
  type StoredRaftCredential,
} from "./index.js";

const identity = {
  agentId: "agent-rss",
  agentName: "rss-notifier",
  agentDisplayName: "RSS Notifier",
  serverId: "server-1",
  credentialId: "credential-1",
  scopes: ["send"],
};

function storedCredential(credential = "sk_agent_stored_secret"): StoredRaftCredential {
  return {
    schemaVersion: 1,
    serverUrl: "https://raft.example",
    credential,
    storedAt: "2026-08-28T08:00:00.000Z",
    ...identity,
  };
}

test("bootstrapRaftCredential validates identity, saves once, and returns no secret", async () => {
  const credential = "sk_agent_bootstrap_secret";
  const saved: StoredRaftCredential[] = [];
  const store: RaftCredentialStore = {
    load: async () => null,
    save: async (record) => {
      saved.push(record);
    },
  };
  const calls: Array<{ url: string; authorization: string | null }> = [];

  const result = await bootstrapRaftCredential({
    serverUrl: "https://raft.example/",
    credential,
    store,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), authorization: headers.get("authorization") });
      return new Response(JSON.stringify(identity), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(calls, [{
    url: "https://raft.example/internal/agent-api/",
    authorization: `Bearer ${credential}`,
  }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.credential, credential);
  assert.equal(saved[0]?.serverUrl, "https://raft.example");
  assert.equal(saved[0]?.schemaVersion, 1);
  assert.deepEqual(result, { serverUrl: "https://raft.example", ...identity });
  assert.doesNotMatch(JSON.stringify(result), /sk_agent_|bootstrap_secret/);
});

test("bootstrapRaftCredential rejects non-Agent credential families before fetch or store access", async () => {
  for (const credential of ["sk_machine_wrong_family", "user_session_wrong_family", "arbitrary-bearer"] as const) {
    let fetched = false;
    let loaded = false;
    await assert.rejects(
      bootstrapRaftCredential({
        serverUrl: "https://raft.example",
        credential,
        store: {
          load: async () => {
            loaded = true;
            return null;
          },
          save: async () => undefined,
        },
        fetch: async () => {
          fetched = true;
          return new Response(JSON.stringify(identity), { status: 200 });
        },
      }),
      (error: unknown) => error instanceof RaftSdkConfigurationError
        && error.code === "INVALID_AGENT_CREDENTIAL"
        && !error.message.includes(credential),
    );
    assert.equal(fetched, false);
    assert.equal(loaded, false);
  }
});

test("bootstrapRaftCredential rejects auth, malformed identity, and store failures without leaking secrets", async () => {
  const credential = "sk_agent_must_not_render";
  const cases: Array<{
    fetch: typeof fetch;
    store: RaftCredentialStore;
    code: string;
  }> = [
    {
      fetch: async () => new Response(JSON.stringify({ error: credential }), { status: 401 }),
      store: { load: async () => null, save: async () => undefined },
      code: "CREDENTIAL_REJECTED",
    },
    {
      fetch: async () => new Response(JSON.stringify({ ...identity, credentialId: null }), { status: 200 }),
      store: { load: async () => null, save: async () => undefined },
      code: "CREDENTIAL_RESPONSE_INVALID",
    },
    {
      fetch: async () => new Response(JSON.stringify(identity), { status: 200 }),
      store: {
        load: async () => {
          throw new Error(credential);
        },
        save: async () => undefined,
      },
      code: "CREDENTIAL_STORE_READ_FAILED",
    },
    {
      fetch: async () => new Response(JSON.stringify(identity), { status: 200 }),
      store: {
        load: async () => null,
        save: async () => {
          throw new Error(credential);
        },
      },
      code: "CREDENTIAL_STORE_WRITE_FAILED",
    },
  ];

  for (const entry of cases) {
    await assert.rejects(
      bootstrapRaftCredential({
        serverUrl: "https://raft.example",
        credential,
        store: entry.store,
        fetch: entry.fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RaftCredentialError);
        assert.equal(error.code, entry.code);
        assert.doesNotMatch(error.message, /sk_agent_|must_not_render/);
        return true;
      },
    );
  }
});

test("bootstrapRaftCredential requires the send capability before saving", async () => {
  let saved = false;
  await assert.rejects(
    bootstrapRaftCredential({
      serverUrl: "https://raft.example",
      credential: "sk_agent_read_only",
      store: {
        load: async () => null,
        save: async () => {
          saved = true;
        },
      },
      fetch: async () => new Response(JSON.stringify({ ...identity, scopes: ["read"] }), { status: 200 }),
    }),
    (error: unknown) => error instanceof RaftCredentialError
      && error.code === "CREDENTIAL_SCOPE_MISSING",
  );
  assert.equal(saved, false);
});

test("bootstrapRaftCredential is idempotent for the stored token and rejects every different token", async () => {
  const credential = "sk_agent_existing";
  let current = storedCredential(credential);
  let saves = 0;
  let fetches = 0;
  const store: RaftCredentialStore = {
    load: async () => current,
    save: async (record) => {
      saves += 1;
      current = record;
    },
  };
  const fetchIdentity = async () => {
    fetches += 1;
    return new Response(JSON.stringify(identity), { status: 200 });
  };

  await bootstrapRaftCredential({
    serverUrl: "https://raft.example",
    credential,
    store,
    fetch: fetchIdentity,
  });
  assert.equal(current.credential, credential);
  assert.equal(saves, 0);
  assert.equal(fetches, 1);

  await assert.rejects(
    bootstrapRaftCredential({
      serverUrl: "https://raft.example",
      credential: "sk_agent_different_same_identity",
      store,
      fetch: fetchIdentity,
    }),
    (error: unknown) => error instanceof RaftCredentialError
      && error.code === "CREDENTIAL_STORE_CONFLICT"
      && !error.message.includes("sk_agent_"),
  );
  assert.equal(current.credential, credential);
  assert.equal(saves, 0);
  assert.equal(fetches, 1);

  current = { ...current, agentId: "different-agent" };
  await assert.rejects(
    bootstrapRaftCredential({
      serverUrl: "https://raft.example",
      credential,
      store,
      fetch: fetchIdentity,
    }),
    (error: unknown) => error instanceof RaftCredentialError
      && error.code === "CREDENTIAL_STORE_CONFLICT"
      && !error.message.includes("sk_agent_"),
  );
  assert.equal(current.agentId, "different-agent");
  assert.equal(saves, 0);
  assert.equal(fetches, 2);
});

test("createRaftClientFromStore loads the saved identity without CLI or environment state", async () => {
  const credential = "sk_agent_loaded_secret";
  const store: RaftCredentialStore = {
    load: async () => storedCredential(credential),
    save: async () => undefined,
  };
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const client = await createRaftClientFromStore({
    store,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), authorization: headers.get("authorization") });
      return new Response(JSON.stringify({ ok: true, state: "sent", messageId: "message-1" }));
    },
  });

  const result = await client.messages.send({ target: "#rss", content: "hello" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    url: "https://raft.example/internal/agent-api/send",
    authorization: `Bearer ${credential}`,
  }]);
});

test("createRaftClientFromStore fails closed when the store is empty or malformed", async () => {
  await assert.rejects(
    createRaftClientFromStore({
      store: { load: async () => null, save: async () => undefined },
    }),
    (error: unknown) => error instanceof RaftCredentialError && error.code === "CREDENTIAL_NOT_FOUND",
  );
  await assert.rejects(
    createRaftClientFromStore({
      store: {
        load: async () => ({ ...storedCredential(), credential: "" }),
        save: async () => undefined,
      },
    }),
    (error: unknown) => error instanceof RaftCredentialError && error.code === "CREDENTIAL_STORE_READ_FAILED",
  );
  for (const credential of ["sk_machine_wrong_family", "user_session_wrong_family", "arbitrary-bearer"] as const) {
    await assert.rejects(
      createRaftClientFromStore({
        store: {
          load: async () => storedCredential(credential),
          save: async () => undefined,
        },
      }),
      (error: unknown) => error instanceof RaftCredentialError
        && error.code === "CREDENTIAL_STORE_READ_FAILED"
        && !error.message.includes(credential),
    );
  }
  await assert.rejects(
    createRaftClientFromStore({
      store: {
        load: async () => ({ ...storedCredential(), scopes: ["read"] }),
        save: async () => undefined,
      },
    }),
    (error: unknown) => error instanceof RaftCredentialError && error.code === "CREDENTIAL_SCOPE_MISSING",
  );
  await assert.rejects(
    createRaftClientFromStore({
      store: {
        load: async () => {
          throw new Error("sk_agent_must_not_render");
        },
        save: async () => undefined,
      },
    }),
    (error: unknown) => error instanceof RaftCredentialError
      && error.code === "CREDENTIAL_STORE_READ_FAILED"
      && !error.message.includes("sk_agent_must_not_render"),
  );
});

test("file credential store is idempotent for one token and never overwrites it with another", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raft-sdk-credential-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const credentialPath = join(directory, "secrets", "raft.json");
  const store = createFileCredentialStore(credentialPath);

  assert.equal(await store.load(), null);
  await store.save(storedCredential("sk_agent_first"));
  const originalBytes = await readFile(credentialPath);
  const originalMode = (await stat(credentialPath)).mode;

  await store.save({
    ...storedCredential("sk_agent_first"),
    storedAt: "2026-08-28T09:00:00.000Z",
  });
  await assert.rejects(
    store.save(storedCredential("sk_agent_second")),
    (error: unknown) => error instanceof RaftCredentialError
      && error.code === "CREDENTIAL_STORE_CONFLICT"
      && !error.message.includes("sk_agent_"),
  );

  const loaded = await store.load();
  assert.equal(loaded?.credential, "sk_agent_first");
  assert.equal(loaded?.storedAt, "2026-08-28T08:00:00.000Z");
  assert.deepEqual(await readFile(credentialPath), originalBytes);
  const metadata = await stat(credentialPath);
  assert.equal(metadata.mode, originalMode);
  if (process.platform !== "win32") {
    assert.equal(metadata.mode & 0o777, 0o600);
  }
  assert.deepEqual(await readdir(join(directory, "secrets")), ["raft.json"]);
});

test("file credential store atomically chooses one first writer under different-token races", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raft-sdk-credential-race-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const credentialPath = join(directory, "raft.json");
  const store = createFileCredentialStore(credentialPath);
  const results = await Promise.allSettled([
    store.save(storedCredential("sk_agent_race_one")),
    store.save(storedCredential("sk_agent_race_two")),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection?.status === "rejected");
  assert.ok(rejection.reason instanceof RaftCredentialError);
  assert.equal(rejection.reason.code, "CREDENTIAL_STORE_CONFLICT");
  assert.match((await store.load())?.credential ?? "", /^sk_agent_race_(one|two)$/);
  assert.deepEqual(await readdir(directory), ["raft.json"]);
});

test("file credential store rejects relative paths, broad permissions, and malformed records", async (t) => {
  assert.throws(
    () => createFileCredentialStore("relative/raft.json"),
    (error: unknown) => error instanceof RaftSdkConfigurationError
      && error.code === "INVALID_CREDENTIAL_PATH",
  );

  const directory = await mkdtemp(join(tmpdir(), "raft-sdk-credential-invalid-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const credentialPath = join(directory, "raft.json");
  const store = createFileCredentialStore(credentialPath);
  await writeFile(credentialPath, JSON.stringify({ credential: "sk_agent_malformed" }), { mode: 0o600 });
  await assert.rejects(
    store.load(),
    (error: unknown) => error instanceof RaftCredentialError
      && error.code === "CREDENTIAL_STORE_READ_FAILED"
      && !error.message.includes("sk_agent_malformed"),
  );
  await assert.rejects(
    store.save(storedCredential()),
    (error: unknown) => error instanceof RaftCredentialError
      && error.code === "CREDENTIAL_STORE_READ_FAILED",
  );
  await rm(credentialPath);

  if (process.platform !== "win32") {
    await store.save(storedCredential());
    await chmod(credentialPath, 0o644);
    await assert.rejects(
      store.load(),
      (error: unknown) => error instanceof RaftCredentialError
        && error.code === "CREDENTIAL_STORE_READ_FAILED"
        && /0600/.test(error.message),
    );

    const symlinkPath = join(directory, "raft-link.json");
    await symlink(credentialPath, symlinkPath);
    await assert.rejects(
      createFileCredentialStore(symlinkPath).load(),
      (error: unknown) => error instanceof RaftCredentialError
        && error.code === "CREDENTIAL_STORE_READ_FAILED",
    );
  }
});
