import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "raft-sdk-pack-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const raw = execFileSync(
    "npm",
    [
      "pack",
      "--dry-run=false",
      "--ignore-scripts",
      "--json",
      "--loglevel=error",
      "--pack-destination",
      scratch,
    ],
    { cwd: root, encoding: "utf8" },
  );
  const pack = JSON.parse(raw)[0];
  const files = pack?.files?.map((file) => file.path) ?? [];
  const requiredFiles = [
    "README.md",
    "dist/cjs/index.cjs",
    "dist/esm/index.js",
    "dist/index.d.ts",
    "package.json",
  ];
  for (const file of requiredFiles) {
    assert(files.includes(file), `packed artifact must contain ${file}`);
  }
  assert(!files.includes("DESIGN.md"), "packed artifact must not contain the internal DESIGN.md");
  assert(
    files.every((file) => !file.startsWith("src/") && !file.startsWith("scripts/")),
    `packed artifact must not contain source or build scripts: ${files.join(", ")}`,
  );

  for (const file of ["dist/cjs/index.cjs", "dist/esm/index.js", "dist/index.d.ts"]) {
    const body = readFileSync(join(root, file), "utf8");
    assert(!body.includes("@botiverse/raft-shared"), `${file} leaked an unpublished workspace import`);
    assert(!body.includes("workspace:"), `${file} leaked a workspace protocol reference`);
  }

  const consumer = join(scratch, "consumer");
  const tarball = join(scratch, pack.filename);
  mkdirSync(consumer);
  execFileSync(
    "npm",
    [
      "install",
      "--dry-run=false",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    { cwd: consumer, encoding: "utf8", stdio: "pipe" },
  );

  const smoke = `
    const sdk = await LOAD;
    if (typeof sdk.createRaftClient !== "function") throw new Error("createRaftClient export missing");
    if (typeof sdk.bootstrapRaftCredential !== "function") throw new Error("bootstrapRaftCredential export missing");
    if (typeof sdk.createFileCredentialStore !== "function") throw new Error("createFileCredentialStore export missing");
    if (typeof sdk.createRaftClientFromStore !== "function") throw new Error("createRaftClientFromStore export missing");
    if (typeof sdk.RaftCredentialError !== "function") throw new Error("credential error export missing");
    if (typeof sdk.RaftSdkConfigurationError !== "function") throw new Error("error export missing");
    const receiver = sdk.createRaftClient({
      serverUrl: "https://raft.example", credential: "sk_agent_pack_smoke",
      fetch: async () => Response.json({ events: [{ sender_type: "human", content: "hello" }],
        last_seen_msgId: null, last_seen_seq: 1, has_more: false, reply_target: null,
        pending_notice_ids: [], wake_reason: null }),
    });
    const received = await receiver.events.receive({ limit: 1 });
    if (!received.ok || received.data.events[0].senderType !== "human" || received.data.lastSeenSeq !== 1)
      throw new Error("packed event receive failed");
    try {
      sdk.createRaftClient({ serverUrl: "", credential: "sk_agent_smoke" });
      throw new Error("invalid configuration unexpectedly passed");
    } catch (error) {
      if (!(error instanceof sdk.RaftSdkConfigurationError)) throw error;
      if (error.code !== "MISSING_SERVER_URL") throw error;
    }
  `;
  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", smoke.replace("LOAD", 'import("@botiverse/raft-sdk")')],
    { cwd: consumer, encoding: "utf8" },
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "--eval",
      `(async () => {${smoke.replace("LOAD", 'require("@botiverse/raft-sdk")')}})()`,
    ],
    { cwd: consumer, encoding: "utf8" },
  );

  writeFileSync(
    join(consumer, "consumer.ts"),
    `import {
  bootstrapRaftCredential,
  createFileCredentialStore,
  createRaftClient,
  createRaftClientFromStore,
  type RaftClientResult,
  type RaftCredentialStore,
  type RaftEvent,
  type RaftEventsReceiveRequest,
  type RaftEventsReceiveResult,
  type RaftEventsReceiveError,
} from "@botiverse/raft-sdk";

const client = createRaftClient({
  serverUrl: "https://raft.example",
  credential: "sk_agent_type_smoke",
});
const result: Promise<RaftClientResult> = client.messages.send({
  target: "#sdk-smoke",
  content: "hello",
});
void result;
const request: RaftEventsReceiveRequest = { since: "latest", limit: 100 };
const received: Promise<RaftEventsReceiveResult> = client.events.receive(request);
void received.then((batch) => {
  if (batch.ok) {
    const event: RaftEvent | undefined = batch.data.events[0];
    const cursor: number | null = batch.data.lastSeenSeq;
    if (event) {
      const sender: "human" | "agent" | "system" | "third_party_app" | "unknown" = event.senderType;
      // @ts-expect-error Public events have no passthrough index signature.
      void event.arbitraryWireField;
      void sender;
    }
    void cursor;
  } else {
    const error: RaftEventsReceiveError = batch.error;
    // @ts-expect-error Failed receives have no success data.
    void batch.data;
    void error;
  }
});
// @ts-expect-error Numeric cursors are numbers, not strings.
void client.events.receive({ since: "123" });
// @ts-expect-error This API is pull-only.
void client.events.stream();

const store: RaftCredentialStore = createFileCredentialStore("/tmp/raft-sdk-smoke.json");
const bootstrapped = bootstrapRaftCredential({
  serverUrl: "https://raft.example",
  credential: "sk_agent_type_smoke",
  store,
});
const storedClient = createRaftClientFromStore({ store });
void bootstrapped;
void storedClient;
`,
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      files: ["consumer.ts"],
    }),
  );
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"],
    { cwd: consumer, encoding: "utf8" },
  );

  console.log(
    `@botiverse/raft-sdk packed artifact is valid (${files.length} files; ESM+CJS/type smokes passed).`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
