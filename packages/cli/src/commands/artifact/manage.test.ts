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
import { RAFT_HINTS } from "@botiverse/raft-shared/src/agentCliSurface";

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
/** A refusal as the Server words it: its sentence, its structured next step, its details. */
const refusalSaying = (status: number, code: string, error: string, more: { next?: object; details?: Record<string, unknown> } = {}) => () => ({
  ok: false, status, data: null, error, errorCode: code, errorBody: { error, code, ...more },
}) as unknown as ApiResponse<unknown>;
const NOT_VISIBLE_SENTENCE = "No artifact you can see has that id, link or title: it may not exist, may have been deleted, or may not be shared with you.";

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

test("move: the Server's refusals in its own words, with their codes", async () => {
  const mayNotMove = "Only the artifact's author, the person who manages an agent author, and the server's owners and admins (none of them guests) can move it: ask one of them to.";
  const forbidden = await run(["artifact", "move", "pt_abc", "--to", "server"], refusalSaying(403, "FORBIDDEN", mayNotMove, { details: { title: "Workspace prototype", author: { type: "user", name: "xxchan" } } }));
  assert.ok(forbidden.stderr.startsWith(`Error: ${mayNotMove}\nCode: FORBIDDEN\n`), forbidden.stderr);
  const cannotSee = "The person who manages this agent can't see the artifact where it is, and moving it would show its pages and comments to the whole server: ask a server owner or admin who can see it to make it visible to the whole server on the web.";
  const unseen = await run(["artifact", "move", "pt_abc", "--to", "server"], refusalSaying(403, "FORBIDDEN", cannotSee, { details: { title: "Workspace prototype", reason: "manager_cannot_see", manager: { type: "user", name: "xxchan" }, target: "#secret" } }));
  assert.ok(unseen.stderr.startsWith(`Error: ${cannotSee}\nCode: FORBIDDEN\n`), unseen.stderr);
  const already = "Nothing changed: the whole server can already see this artifact.";
  const wide = await run(["artifact", "move", "pt_abc", "--to", "server"], refusalSaying(409, "HOME_NOT_WIDER", already, { next: RAFT_HINTS.artifactRead({ artifact: "pt_abc" }), details: { title: "Workspace prototype", home: "server", to: "server" } }));
  assert.equal(wide.stderr, `Error: ${already}\nCode: HOME_NOT_WIDER\nNext action: raft artifact read pt_abc\n`);
  const nameTaken = "Another artifact visible to the whole server already has this artifact's name, so it can't move there: ask the other one's author or a server admin whether it can be deleted, then move this one again.";
  const taken = await run(["artifact", "move", "pt_abc", "--to", "server"], refusalSaying(409, "NAME_TAKEN", nameTaken, { details: { name: "workspace-prototype" } }));
  assert.ok(taken.stderr.startsWith(`Error: ${nameTaken}\nCode: NAME_TAKEN\n`), taken.stderr);
  const hidden = await run(["artifact", "move", "pt_zzz", "--to", "server"], refusalSaying(404, "NOT_VISIBLE", NOT_VISIBLE_SENTENCE, { next: RAFT_HINTS.artifactList({}) }));
  assert.equal(hidden.stderr, `Error: ${NOT_VISIBLE_SENTENCE}\nCode: NOT_VISIBLE\nNext action: raft artifact list\n`);
});

test("delete: DELETE …/:artifact, then what went and that it can't be undone; a refusal keeps its code", async () => {
  const r = await run(["artifact", "delete", "pt_abc"], () => ({
    ok: true, status: 200, data: { artifact: { id: "pt_abc", name: "workspace-prototype", title: "Workspace prototype", currentVersion: 12 }, deleted: true }, error: null,
  }));
  assert.equal(r.error, null, r.stderr);
  assert.deepEqual(r.requests, [{ method: "DELETE", path: `${BASE}/pt_abc`, body: undefined }]);
  assert.equal(r.stdout, `Deleted "Workspace prototype" (pt_abc): no one can open it or any of its versions any more, and links to it say it can't be opened. This can't be undone.\n`);

  const onlyAuthor = "Only the artifact's author, the person who manages an agent author, and the server's owners and admins can delete it: ask one of them to.";
  const forbidden = await run(["artifact", "delete", "--artifact", "workspace-prototype"], refusalSaying(403, "FORBIDDEN", onlyAuthor, { details: { title: "Workspace prototype", author: { type: "agent", name: "Remy" } } }));
  assert.deepEqual(forbidden.requests.map((q) => `${q.method} ${q.path}`), [`DELETE ${BASE}/workspace-prototype`]);
  assert.ok(forbidden.stderr.startsWith(`Error: ${onlyAuthor}\nCode: FORBIDDEN\n`), forbidden.stderr);

  // Not found on a delete: the Server's sentence says it may have been deleted (a delete that went through, its answer lost).
  const gone = await run(["artifact", "delete", "pt_abc"], refusalSaying(404, "NOT_VISIBLE", NOT_VISIBLE_SENTENCE, { next: RAFT_HINTS.artifactList({}) }));
  assert.ok(gone.stderr.startsWith(`Error: ${NOT_VISIBLE_SENTENCE}\nCode: NOT_VISIBLE\n`), gone.stderr);

  const none = await run(["artifact", "delete"], noRequest);
  assert.equal(none.requests.length, 0);
  assert.ok(none.stderr.includes("which artifact?"), none.stderr);
});
