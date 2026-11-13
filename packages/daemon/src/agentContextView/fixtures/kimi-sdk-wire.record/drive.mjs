// Drives the real @botiverse/kimi-code-sdk against a scripted local
// OpenAI-chat-completions server (the "kimi" provider wire) to produce a real
// wire.jsonl. Mirrors the daemon's createKimiAgentSessionForContext launch:
// harness with identity + roleAdditional + baseEnv (PATH with the raft
// wrapper dir), createSession({ workDir, model, thinking }), setModel,
// session-scoped auto-approval, prompt per turn.
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const [sdkPath, kimiHome, workDir, binDir, logPath] = process.argv.slice(2);
const { createKimiHarness } = await import(sdkPath);

const requests = [];
const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: "kimi-for-coding", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usageChunk = (prompt, completion, cached) => `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: "kimi-for-coding", choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cached_tokens: cached } })}\n\n`;
const SEND = `raft message send --target "#general" <<'X'\nHello from the fixture agent.\nX`;

function text(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p.text ?? "").join("");
  return "";
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  requests.push({ url: req.url, body });
  const msgs = body.messages ?? [];
  const last = msgs[msgs.length - 1] ?? {};
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  let out;
  if (!body.tools || body.tools.length === 0) {
    out = chunk({ role: "assistant", content: "Fixture session" }) + chunk({}, "stop");
  } else if (last.role === "tool") {
    out = chunk({ role: "assistant", reasoning_content: "The send succeeded." }) + chunk({ content: "Posted the greeting to #general." }) + chunk({}, "stop") + usageChunk(1300, 12, 1200);
  } else if (text(last.content).includes("#general")) {
    out =
      chunk({ role: "assistant", reasoning_content: "I should post the greeting with the raft CLI." }) +
      chunk({ content: "Posting it now." }) +
      chunk({ tool_calls: [{ index: 0, id: "call_send_1", type: "function", function: { name: "Bash", arguments: "" } }] }) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: SEND }) } }] }) +
      chunk({}, "tool_calls") +
      usageChunk(1250, 40, 1100);
  } else {
    out = chunk({ role: "assistant", reasoning_content: "A simple greeting; reply briefly." }) + chunk({ content: "Hi! How can I help?" }) + chunk({}, "stop") + usageChunk(1200, 9, 0);
  }
  res.end(out + "data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

mkdirSync(kimiHome, { recursive: true });
writeFileSync(path.join(kimiHome, "config.toml"), `default_model = "kimi-code/kimi-for-coding"
auto_session_title = false

[providers.local]
type = "kimi"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "local-test-only"

[models."kimi-code/kimi-for-coding"]
provider = "local"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = ["thinking", "image_in"]
display_name = "Kimi fixture"
`);

const harness = createKimiHarness({
  homeDir: kimiHome,
  identity: { productName: "kimi-code-cli", version: "2.3.1-botiverse.1", platform: "kimi_code_cli", userAgentSuffix: "slock-daemon/0.0.0" },
  roleAdditional: "You are \"fixture-agent\", an agent in a Raft workspace. Talk to people only with the `raft` CLI: `raft message send --target \"#channel\"` with the message on stdin.",
  baseEnv: { PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`, HOME: process.env.HOME, NO_COLOR: "1", LANG: "C.UTF-8" },
});

let exitCode = 0;
try {
  const session = await harness.createSession({ workDir, model: "kimi-code/kimi-for-coding", thinking: "high" });
  await session.setModel("kimi-code/kimi-for-coding");
  session.setApprovalHandler(() => ({ decision: "approved", scope: "session" }));
  const turn = async (t) => {
    const done = new Promise((resolve, reject) => {
      const off = session.onEvent((event) => {
        if (event.type === "turn.ended") { off(); resolve(); }
        if (event.type === "error") { off(); reject(new Error(JSON.stringify(event))); }
      });
    });
    await session.prompt(t);
    await done;
  };
  await turn("Hello there");
  await turn("Please post a short greeting to #general.");
  console.log(JSON.stringify({ sessionId: session.id }));
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await harness.close().catch(() => undefined);
  writeFileSync(logPath, JSON.stringify(requests, null, 2));
  server.close();
  server.closeAllConnections?.();
}
process.exit(exitCode);
