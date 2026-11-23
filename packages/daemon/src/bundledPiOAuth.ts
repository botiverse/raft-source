import type { AddressInfo } from "node:net";
import type { Credential, CredentialStore, Model } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { registerLazyBedrockProvider } from "@earendil-works/pi-ai/lazy-bedrock-provider";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

// Despite its SDK name, this is platform-neutral static registration: no Bun
// runtime is used. Pi's default lazy imports deliberately evade bundlers, so a
// Computer SEA cannot resolve them from its nonexistent SDK directory. Register
// the complete SDK flow set for both the Built-in and Pi runtime entry paths.
// The registry is module state: it only reaches pi-coding-agent when the daemon
// and pi-coding-agent resolve the same pi-ai copy (OAR #386).
registerBunOAuthFlows();
// Amazon Bedrock the same way: pi-ai imports its Bedrock stream (and the AWS
// SDK under it) through a variable specifier, which a SEA cannot resolve, so
// without this an agent's first Bedrock request fails unless a web pi sign-in
// already ran OAR's registration in this process. The loader is a literal
// dynamic import that runs on the first Bedrock request: registering it loads
// nothing, and the SEA ships the AWS SDK as its own asset (computer native
// build, bedrock.cjs).
registerLazyBedrockProvider();

/** Offline artifact check: exercise the same lazy OAuth derivation as a stored login. */
export async function verifyBundledPiOAuth(): Promise<void> {
  const oauth = openaiCodexProvider().auth?.oauth;
  if (!oauth) throw new Error("Bundled OpenAI Codex provider has no OAuth flow");
  const access = "raft-bundle-check-not-a-credential";
  const auth = await oauth.toAuth({
    type: "oauth",
    access,
    refresh: "unused",
    expires: Number.MAX_SAFE_INTEGER,
  });
  if (auth.apiKey !== access) throw new Error("Bundled OAuth derivation returned an unexpected result");

  // Agent sessions derive OAuth through pi-coding-agent's own pi-ai import. A
  // second pi-ai copy there misses the registration above and looks for
  // github-copilot.js beside the bundle.
  const copilot: Credential = { type: "oauth", access, refresh: "unused", expires: Number.MAX_SAFE_INTEGER };
  const credentials: CredentialStore = {
    read: async (providerId) => (providerId === "github-copilot" ? copilot : undefined),
    list: async () => [{ providerId: "github-copilot", type: "oauth" }],
    modify: async (providerId) => (providerId === "github-copilot" ? copilot : undefined),
    delete: async () => {},
  };
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const sessionAuth = await new ModelRegistry(runtime).getProviderAuth("github-copilot");
  if (sessionAuth?.auth.apiKey !== access) {
    throw new Error("Bundled pi-coding-agent OAuth derivation returned an unexpected result");
  }
}

/**
 * Offline artifact check: one Bedrock request the way an agent's goes, to a
 * loopback server that refuses it. Getting that refusal back means pi-ai's
 * Bedrock stream, the AWS SDK and its HTTP/1.1 handler all loaded and sent the
 * request (a SEA loads the SDK from its own asset on this first request).
 */
export async function verifyBundledPiBedrock(): Promise<void> {
  const { createServer } = await import("node:http");
  const { complete } = await import("@earendil-works/pi-ai/compat");
  const refusal = "raft-bundle-check-bedrock-refused";
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    request.on("end", () => {
      response.writeHead(400, { "content-type": "application/json", "x-amzn-errortype": "ValidationException" });
      response.end(JSON.stringify({ message: refusal }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = server.address() as AddressInfo;
    const model: Model<"bedrock-converse-stream"> = {
      id: "raft-bundle-check",
      name: "raft-bundle-check",
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      baseUrl: `http://127.0.0.1:${port}`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 16,
    };
    const result = await complete(
      model,
      { messages: [{ role: "user", content: "raft bundle check", timestamp: Date.now() }] },
      {
        maxRetries: 0,
        // Dummy credentials, a fixed region and HTTP/1.1 (the stream's own
        // NodeHttpHandler), straight to the loopback server.
        env: { AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1", AWS_BEDROCK_FORCE_HTTP1: "1", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
      },
    );
    if (requests === 0 || !result.errorMessage?.includes(refusal)) {
      throw new Error(`Bundled Bedrock request did not reach the check server (${requests} requests): ${result.errorMessage ?? result.stopReason}`);
    }
  } finally {
    server.close();
  }
}
