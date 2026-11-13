// Artifacts' agent API samples, for tests only (never imported by runtime
// code: agentApiRoute.test.ts checks): for each route of the app's fragment,
// the client call's arguments (`input`), a valid response, and the request
// the raw client sends for that input (`sent`). The shared contract, client
// and raw-client tests merge every app's samples (apps/agentApiSamples.ts)
// after core's own.
import type { AgentApiRouteSample } from "../agentApiSamples";
import type { artifactsAgentApi } from "./agentApi";

export const artifactsAgentApiSamples = {
  artifactList: {
    input: [{ target: "#proj-workspace:abcd1234", limit: "20" }],
    response: { artifacts: [{ id: "pt_abc", url: "https://app.raft.build/artifacts/ScAiFjjtiUvoyEYA6Ry12u", title: "Workspace prototype", description: null, kind: "html", home: { kind: "conversation", conversation: { id: "channel-1", type: "channel", target: "#proj-workspace" } }, currentVersion: 12, author: { type: "agent", name: "remy" }, createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z" }], nextCursor: null, target: { target: "#proj-workspace", conversationId: "channel-1", homeFromThread: "abcd1234" } },
    sent: { method: "GET", path: "/internal/agent-api/artifacts?target=%23proj-workspace%3Aabcd1234&limit=20", body: undefined },
  },
  artifactRead: {
    input: [{ artifact: "pt_abc" }, { version: "3" }],
    response: { artifact: { id: "pt_abc", url: "https://app.raft.build/artifacts/ScAiFjjtiUvoyEYA6Ry12u", title: "Workspace prototype", description: null, kind: "html", home: { kind: "conversation", conversation: { id: "channel-1", type: "channel", target: "#proj-workspace" } }, currentVersion: 12, author: { type: "agent", name: "remy" }, createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z" }, version: { number: 12, current: true, entry: "index.html", label: null, note: "card states", publisher: { type: "agent", name: "remy" }, createdAt: "2026-10-22T10:00:00.000Z", sizeBytes: 2048, files: [{ path: "index.html", sizeBytes: 2048, kind: "html", entry: true }] }, versions: { total: 12, latest: [{ number: 12, publisher: { type: "agent", name: "remy" }, createdAt: "2026-10-22T10:00:00.000Z", note: "card states", changedPaths: ["components.html"] }] }, unseen: { firstRead: false, versionCount: 1, commentCount: 1, versions: [{ number: 12, publisher: { type: "agent", name: "remy" }, createdAt: "2026-10-22T10:00:00.000Z", note: "card states", changedPaths: ["components.html"] }], comments: [{ id: "c_1", author: { type: "user", name: "xxchan" }, version: 12, path: "components.html", createdAt: "2026-10-22T11:00:00.000Z", excerpt: "three card states", truncated: false, bodyChars: 17 }], commentsCursor: null }, viewing: [] },
    sent: { method: "GET", path: "/internal/agent-api/artifacts/pt_abc?version=3", body: undefined },
  },
  artifactFile: {
    input: [{ artifact: "pt_abc", path: "assets/logo.png" }, { version: "3" }],
    response: new Uint8Array([1, 2, 3]),
    sent: { method: "GET", path: "/internal/agent-api/artifacts/pt_abc/files/assets%2Flogo.png?version=3", body: undefined },
  },
  artifactFileContent: {
    input: [{ artifact: "pt_abc", path: "assets/logo.png" }, {}],
    response: { kind: "text", path: "index.html", version: 12, size: 5, contentType: "text/html; charset=utf-8", encoding: "utf8", content: "<p/>\n", truncated: false },
    sent: { method: "GET", path: "/internal/agent-api/artifacts/pt_abc/files/assets%2Flogo.png/content", body: undefined },
  },
  artifactComments: {
    input: [{ artifact: "workspace-prototype" }, { path: "a b.html", all: "1" }],
    response: { artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 12 }, view: "unseen", path: null, comments: [{ id: "c_1", author: { type: "user", name: "xxchan" }, version: 12, path: "components.html", anchor: null, replyTo: null, body: "three card states", createdAt: "2026-10-22T11:00:00.000Z", editedAt: null }], nextCursor: null, unseenVersionCount: 0 },
    sent: { method: "GET", path: "/internal/agent-api/artifacts/workspace-prototype/comments?path=a+b.html&all=1", body: undefined },
  },
  artifactPublish: {
    input: [{ artifact: "pt_abc", base: 11, note: "card states", files: [{ path: "components.html", sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", size: 12 }, { path: "notes.md", content: "# notes" }, { path: "logo.png", content_base64: "iVBORw==" }], delete: ["old.html"] }],
    response: { artifact: { id: "pt_abc", url: "https://app.raft.build/artifacts/ScAiFjjtiUvoyEYA6Ry12u", title: "Workspace prototype", description: null, kind: "html", home: { kind: "conversation", conversation: { id: "channel-1", type: "channel", target: "#proj-workspace" } }, currentVersion: 13, author: { type: "agent", name: "remy" }, createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z" }, version: { number: 13, filesFromYou: ["components.html"], deleted: [], base: 11, previous: 12, merged: [{ path: "tech.html", setting: null, version: 12, author: { type: "agent", name: "tenny" } }] }, unseen: { otherComments: 1 }, notified: [], replayed: false, unchanged: false },
    sent: { method: "POST", path: "/internal/agent-api/artifacts/push", body: { artifact: "pt_abc", base: 11, note: "card states", files: [{ path: "components.html", sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", size: 12 }, { path: "notes.md", content: "# notes" }, { path: "logo.png", content_base64: "iVBORw==" }], delete: ["old.html"] } },
  },
  artifactImport: {
    input: [{ from: "https://raft-artifacts.com/p/raft/workspace-prototype", target: "#proj-workspace" }],
    response: { artifact: { id: "pt_abc", url: "https://app.raft.build/artifacts/ScAiFjjtiUvoyEYA6Ry12u", title: "Workspace prototype", description: null, kind: "html", home: { kind: "conversation", conversation: { id: "channel-1", type: "channel", target: "#proj-workspace" } }, currentVersion: 1, author: { type: "agent", name: "remy" }, createdAt: "2026-10-26T10:00:00.000Z", updatedAt: "2026-10-26T10:00:00.000Z" }, created: true, from: "https://raft-artifacts.com/p/raft/workspace-prototype" },
    sent: { method: "POST", path: "/internal/agent-api/artifacts/import", body: { from: "https://raft-artifacts.com/p/raft/workspace-prototype", target: "#proj-workspace" } },
  },
  artifactUpload: {
    input: [{ sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
    response: null,
    sent: { method: "PUT", path: "/internal/agent-api/artifacts/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", body: undefined },
  },
  artifactCommentImageUpload: {
    input: [{ artifact: "pt_abc" }],
    response: { fileId: "0b8f8a52-1c1e-4c1f-9d36-2f6a1b0c9e11", contentType: "image/png", sizeBytes: 48213, width: 1280, height: 720 },
    sent: { method: "POST", path: "/internal/agent-api/artifacts/pt_abc/comment-images", body: undefined },
  },
  artifactCommentImage: {
    input: [{ artifact: "pt_abc", fileId: "0b8f8a52-1c1e-4c1f-9d36-2f6a1b0c9e11" }],
    response: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    sent: { method: "GET", path: "/internal/agent-api/artifacts/pt_abc/comment-images/0b8f8a52-1c1e-4c1f-9d36-2f6a1b0c9e11", body: undefined },
  },
  artifactCheck: {
    input: [{ artifact: "pt_abc" }, { version: "13" }],
    response: { artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 13 }, version: 13, check: { id: "5f0c2d1e-7a2b-4c3d-9e8f-0a1b2c3d4e5f", status: "done", skipReason: null, errorClass: null, findings: { consoleErrors: [{ message: "Uncaught TypeError: x is undefined", source: "index.html", line: 12 }], blockedResources: [], blank: false, phoneOverflow: { contentWidth: 640, viewportWidth: 390 } }, createdAt: "2026-11-04T10:00:00.000Z", finishedAt: "2026-11-04T10:00:20.000Z", screenshots: [{ shot: "desktop" }, { shot: "phone" }] } },
    sent: { method: "GET", path: "/internal/agent-api/artifacts/pt_abc/check?version=13", body: undefined },
  },
  artifactCheckShot: {
    input: [{ artifact: "pt_abc", shot: "phone" }, {}],
    response: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    sent: { method: "GET", path: "/internal/agent-api/artifacts/pt_abc/check/phone", body: undefined },
  },
  artifactComment: {
    input: [{ artifact: "pt_abc" }, { body: "@kirby three states now", path: "components.html", replyTo: "c_1" }],
    response: { artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 12 }, comment: { id: "c_2", author: { type: "agent", name: "remy" }, version: 12, path: "components.html", anchor: null, replyTo: "c_1", body: "@kirby three states now", createdAt: "2026-10-22T11:05:00.000Z", editedAt: null }, notified: [{ actor: { type: "agent", name: "kirby" }, reason: "mentioned" }], notNotified: [{ name: "xxchan", reason: "not_agent" }], newlySubscribed: true },
    sent: { method: "POST", path: "/internal/agent-api/artifacts/pt_abc/comments", body: { body: "@kirby three states now", path: "components.html", replyTo: "c_1" } },
  },
  artifactReview: {
    input: [{ artifact: "pt_abc" }, { body: "Two things before v13", version: 12, comments: [{ path: "components.html", body: "@kirby the empty state is missing" }, { body: "Overall close" }] }],
    response: { artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 12 }, review: { id: "rv_1", author: { type: "agent", name: "remy" }, version: 12, body: "Two things before v13", createdAt: "2026-10-27T18:30:00.000Z" }, comments: [{ id: "c_3", author: { type: "agent", name: "remy" }, version: 12, path: "components.html", anchor: null, replyTo: null, body: "@kirby the empty state is missing", createdAt: "2026-10-27T18:30:00.000Z", editedAt: null, reviewId: "rv_1" }, { id: "c_4", author: { type: "agent", name: "remy" }, version: 12, path: null, anchor: null, replyTo: null, body: "Overall close", createdAt: "2026-10-27T18:30:00.000Z", editedAt: null, reviewId: "rv_1" }], notified: [{ actor: { type: "agent", name: "kirby" }, reason: "mentioned" }], notNotified: [], newlySubscribed: false },
    sent: { method: "POST", path: "/internal/agent-api/artifacts/pt_abc/reviews", body: { body: "Two things before v13", version: 12, comments: [{ path: "components.html", body: "@kirby the empty state is missing" }, { body: "Overall close" }] } },
  },
  artifactCommentResolve: {
    input: [{ artifact: "pt_abc", comment: "c_1" }, { note: "Done in v13: the three states are side by side." }],
    response: { artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 13 }, comment: { id: "c_1", author: { type: "user", name: "xxchan" }, version: 12, path: "components.html", anchor: null, replyTo: null, body: "three card states", createdAt: "2026-10-22T11:00:00.000Z", editedAt: null, resolvedAt: "2026-10-23T09:00:00.000Z", resolvedBy: { type: "agent", name: "remy" } }, note: { id: "c_9", author: { type: "agent", name: "remy" }, version: 13, path: "components.html", anchor: null, replyTo: "c_1", body: "Done in v13: the three states are side by side.", createdAt: "2026-10-23T09:00:00.000Z", editedAt: null, resolvedAt: null, resolvedBy: null }, changed: true, notified: [], notNotified: [] },
    sent: { method: "POST", path: "/internal/agent-api/artifacts/pt_abc/comments/c_1/resolve", body: { note: "Done in v13: the three states are side by side." } },
  },
  artifactCommentReopen: {
    input: [{ artifact: "pt_abc", comment: "c_1" }],
    response: { artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 13 }, comment: { id: "c_1", author: { type: "user", name: "xxchan" }, version: 12, path: "components.html", anchor: null, replyTo: null, body: "three card states", createdAt: "2026-10-22T11:00:00.000Z", editedAt: null, resolvedAt: null, resolvedBy: null }, note: null, changed: true, notified: [], notNotified: [] },
    sent: { method: "POST", path: "/internal/agent-api/artifacts/pt_abc/comments/c_1/reopen", body: undefined },
  },
  artifactSubscribe: {
    input: [{ artifact: "pt_abc" }],
    response: { artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 12 }, following: true },
    sent: { method: "PUT", path: "/internal/agent-api/artifacts/pt_abc/subscription", body: undefined },
  },
  artifactUnsubscribe: {
    input: [{ artifact: "workspace-prototype" }],
    response: { artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 12 }, following: false },
    sent: { method: "DELETE", path: "/internal/agent-api/artifacts/workspace-prototype/subscription", body: undefined },
  },
  artifactMove: {
    input: [{ artifact: "pt_abc" }, { to: "server" }],
    response: { artifact: { id: "pt_abc", url: "https://app.raft.build/artifacts/ScAiFjjtiUvoyEYA6Ry12u", title: "Workspace prototype", description: null, kind: "html", home: { kind: "server" }, currentVersion: 12, author: { type: "agent", name: "remy" }, createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-22T10:00:00.000Z" }, from: { kind: "conversation", conversation: { id: "channel-1", type: "channel", target: "#proj-workspace" } } },
    sent: { method: "POST", path: "/internal/agent-api/artifacts/pt_abc/home", body: { to: "server" } },
  },
  artifactDelete: {
    input: [{ artifact: "workspace-prototype" }],
    response: { artifact: { id: "pt_abc", title: "Workspace prototype", currentVersion: 12 }, deleted: true },
    sent: { method: "DELETE", path: "/internal/agent-api/artifacts/workspace-prototype", body: undefined },
  },
  artifactSaveAttachment: {
    input: [{ attachmentId: "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c" }],
    response: { artifact: { id: "pt_def", url: "https://app.raft.build/artifacts/8oRvuaLwXvau1ypHChfZkE", title: "Q3 report", description: null, kind: "markdown", home: { kind: "conversation", conversation: { id: "channel-1", type: "channel", target: "#proj-workspace" } }, currentVersion: 1, author: { type: "agent", name: "remy" }, createdAt: "2026-10-27T10:00:00.000Z", updatedAt: "2026-10-27T10:00:00.000Z" }, created: true, attachment: { id: "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c", filename: "Q3 report.md" } },
    sent: { method: "POST", path: "/internal/agent-api/artifacts/save-attachment", body: { attachmentId: "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c" } },
  },
} satisfies Record<keyof typeof artifactsAgentApi.routes, AgentApiRouteSample>;
