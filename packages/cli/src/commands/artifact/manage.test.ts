// `raft artifact move <artifact> --to server` and `raft artifact delete <artifact>`
// through the real parser: the request each sends (a link as its id), the
// shared text of the answer, and what is refused before any request (`--to
// anyone-with-link`, a person's step, with the move an agent can make; any
// other `--to`, `public` included, or none); the Server's refusals keep their
// codes.
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { buildRaftProgram } from "../../program";

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "https://raft.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};
const BASE = "/internal/agent-api/artifacts";
const summary = {
  id: "pt_abc", url: "https://app.raft.build/artifacts/pt_abc", name: "workspace-prototype", title: "Workspace prototype", description: null, kind: "html",
  home: { kind: "server" }, currentVersion: 12,
  author: { type: "agent", name: "Remy" }, createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z",
};
const noRequest = (): ApiResponse<unknown> => {
  throw new Error("no request expected");
};
const refusal = (status: number, code: string, details: Record<string, unknown>) => () => ({
  ok: false, status, data: null, error: code, errorCode: code, errorBody: { error: code, code, details },
}) as unknown as ApiResponse<unknown>;

async function run(argv: string[], reply: (method: string, path: string, body?: unknown) => ApiResponse<unknown>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const program = buildRaftProgram({
    io: {
      stdout: { write: (c: string | Uint8Array) => { stdout.push(String(c)); return true; } },
      stderr: { write: (c: string | Uint8Array) => { stderr.push(String(c)); return true; } },
      stdin: Object.assign(Readable.from([]), { isTTY: true }),
    },
    env: {},
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async <T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> => {
        requests.push({ method, path, body });
        return reply(method, path, body) as ApiResponse<T>;
      },
    }) as any,
  });
  let error: unknown = null;
  await program.parseAsync(argv, { from: "user" }).catch((caught) => { error = caught; });
  return { stdout: stdout.join(""), stderr: stderr.join(""), requests, error };
}

test("move: POST …/home { to: server } with a link sent as its id; the answer says who sees it now, who can move it back, and its link", async () => {
  const r = await run(["artifact", "move", "https://app.raft.build/artifacts/pt_abc", "--to", "server"], () => ({
    ok: true, status: 200, data: { artifact: summary, from: { kind: "conversation", conversation: { id: "c-1", type: "channel", target: "#proj-workspace" } } }, error: null,
  }));
  assert.equal(r.error, null, r.stderr);
  assert.deepEqual(r.requests, [{ method: "POST", path: `${BASE}/pt_abc/home`, body: { to: "server" } }]);
  assert.equal(
    r.stdout,
    `Moved "Workspace prototype" (pt_abc) to the whole server: every member and agent of this server can now see it (guests can't), with its comments and all its versions. An agent can't move it back; a person can, from the web, to #proj-workspace, unless that conversation is shared with another server or has guests.\n`
    + "Open: https://app.raft.build/artifacts/pt_abc\n",
  );
});

test("move: --to anyone-with-link is a person's step and any other --to (public included, or none) is refused, all before any request", async () => {
  const toLink = await run(["artifact", "move", "pt_abc", "--to", "anyone-with-link"], noRequest);
  assert.equal(toLink.requests.length, 0);
  assert.ok(toLink.stderr.includes("Only a person can turn on link sharing (anyone with the link can then open it)."), toLink.stderr);
  assert.ok(toLink.stderr.includes(`Ask a person who manages it to choose "Anyone with the link" under "Who can see" in its ⋯ menu on the web. To let the whole server see it: raft artifact move pt_abc --to server`), toLink.stderr);
  assert.ok(toLink.stderr.includes("Code: FORBIDDEN"), toLink.stderr);

  // `public`, that home's name on the wire, is no value of --to: refused as any other.
  const homes = "server (the whole server), anyone-with-link (only a person can turn on link sharing)";
  for (const to of ["everyone", "public"]) {
    const elsewhere = await run(["artifact", "move", "pt_abc", "--to", to], noRequest);
    assert.equal(elsewhere.requests.length, 0);
    assert.ok(elsewhere.stderr.includes(`--to must be one of: ${homes}; got "${to}"`) && elsewhere.stderr.includes("raft artifact move pt_abc --to server"), elsewhere.stderr);
    assert.ok(elsewhere.stderr.includes("Code: INVALID_ARG"), elsewhere.stderr);
  }

  const missing = await run(["artifact", "move", "pt_abc"], noRequest);
  assert.equal(missing.requests.length, 0);
  assert.ok(missing.stderr.includes(`--to is required; it must be one of: ${homes}`) && missing.stderr.includes("raft artifact move pt_abc --to server"), missing.stderr);
});

test("move: the Server's refusals in the shared words, with their codes", async () => {
  const forbidden = await run(["artifact", "move", "pt_abc", "--to", "server"], refusal(403, "FORBIDDEN", { title: "Workspace prototype", author: { type: "user", name: "xxchan" } }));
  assert.ok(forbidden.stderr.includes(`You can't move "Workspace prototype": only its author (@xxchan), the person who manages an agent author, and the server's owners and admins can.`), forbidden.stderr);
  assert.ok(forbidden.stderr.includes("Code: FORBIDDEN"), forbidden.stderr);
  const unseen = await run(["artifact", "move", "pt_abc", "--to", "server"], refusal(403, "FORBIDDEN", { title: "Workspace prototype", author: { type: "agent", name: "Remy" }, reason: "manager_cannot_see", manager: { type: "user", name: "xxchan" }, target: "#secret" }));
  assert.ok(unseen.stderr.includes(`You can't move "Workspace prototype" out of #secret: the person who manages you (@xxchan) can't see it there`), unseen.stderr);
  assert.ok(unseen.stderr.includes(`Ask a server owner or admin who can see it in #secret to use "Make visible to the whole server" on the web, or tell whoever asked you that you can't move it.`) && unseen.stderr.includes("Code: FORBIDDEN"), unseen.stderr);
  const wide = await run(["artifact", "move", "pt_abc", "--to", "server"], refusal(409, "HOME_NOT_WIDER", { title: "Workspace prototype", home: "server", to: "server" }));
  assert.ok(wide.stderr.includes(`"Workspace prototype" is already visible to the whole server; nothing changed.`) && wide.stderr.includes("Code: HOME_NOT_WIDER"), wide.stderr);
  const taken = await run(["artifact", "move", "pt_abc", "--to", "server"], refusal(409, "NAME_TAKEN", { name: "workspace-prototype" }));
  assert.ok(taken.stderr.includes(`Another artifact visible to the whole server is already named "workspace-prototype", so this one can't move there.`), taken.stderr);
  assert.ok(taken.stderr.includes("Ask the other one's author or a server admin whether it can be deleted, then run the move again: raft artifact move pt_abc --to server") && taken.stderr.includes("Code: NAME_TAKEN"), taken.stderr);
  const hidden = await run(["artifact", "move", "pt_zzz", "--to", "server"], refusal(404, "NOT_VISIBLE", {}));
  assert.ok(hidden.stderr.includes(`No artifact "pt_zzz" that you can see (by that id, link or exact title).`) && hidden.stderr.includes("Code: NOT_VISIBLE"), hidden.stderr);
});

test("delete: DELETE …/:artifact, then what went and that it can't be undone; a refusal keeps its code", async () => {
  const r = await run(["artifact", "delete", "pt_abc"], () => ({
    ok: true, status: 200, data: { artifact: { id: "pt_abc", name: "workspace-prototype", title: "Workspace prototype", currentVersion: 12 }, deleted: true }, error: null,
  }));
  assert.equal(r.error, null, r.stderr);
  assert.deepEqual(r.requests, [{ method: "DELETE", path: `${BASE}/pt_abc`, body: undefined }]);
  assert.equal(r.stdout, `Deleted "Workspace prototype" (pt_abc): no one can open it or any of its versions any more, and links to it say it can't be opened. This can't be undone.\n`);

  const forbidden = await run(["artifact", "delete", "--artifact", "workspace-prototype"], refusal(403, "FORBIDDEN", { title: "Workspace prototype", author: { type: "agent", name: "Remy" } }));
  assert.deepEqual(forbidden.requests.map((q) => `${q.method} ${q.path}`), [`DELETE ${BASE}/workspace-prototype`]);
  assert.ok(forbidden.stderr.includes(`You can't delete "Workspace prototype": only its author (@Remy),`) && forbidden.stderr.includes("Code: FORBIDDEN"), forbidden.stderr);

  // Not found on a delete: it may have gone through already.
  const gone = await run(["artifact", "delete", "pt_abc"], refusal(404, "NOT_VISIBLE", {}));
  assert.ok(gone.stderr.includes(`No artifact "pt_abc" that you can see: it may already be deleted, or it lives where you can't see it.`) && gone.stderr.includes("Code: NOT_VISIBLE"), gone.stderr);

  const none = await run(["artifact", "delete"], noRequest);
  assert.equal(none.requests.length, 0);
  assert.ok(none.stderr.includes("which artifact?"), none.stderr);
});
