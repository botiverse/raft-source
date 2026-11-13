import assert from "node:assert/strict";
import { type PublicRequesterClass, classifyPublicRequester, classifyRequesterUserAgent } from "./publicRequester";
import { userAgentClassAttrs } from "./requestObservability";

// Published User-Agents (vendor docs) and ordinary ones, each to its class.
const CASES: ReadonlyArray<readonly [string | undefined, PublicRequesterClass]> = [
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", "chatgpt_user"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)", "claude_user"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot", "openai_crawler"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", "openai_crawler"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "anthropic_crawler"],
  ["Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)", "anthropic_crawler"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "perplexity"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)", "perplexity"],
  ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "other_bot"],
  ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "other_bot"],
  ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "other_bot"],
  ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36", "other_bot"],
  ["curl/8.4.0", "other_bot"],
  ["python-requests/2.31.0", "other_bot"],
  ["node-fetch/1.0 (+https://github.com/bitinn/node-fetch)", "other_bot"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15", "browser"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", "browser"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "browser"],
  ["Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36", "browser"],
  ["Mozilla/5.0 (Linux; Android 9; CUBOT_X19) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36", "browser"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)", "other_bot"],
  ["Slackbot 1.0 (+https://api.slack.com/robots)", "other_bot"],
  ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-Web/1.0; +claude-web@anthropic.com)", "anthropic_crawler"],
  ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "other_bot"],
  ["Mozilla/5.0 (compatible; DuckDuckBot/1.1; +http://duckduckgo.com/duckduckbot.html)", "other_bot"],
  ["SomethingElse/1.0", "unknown"],
  ["", "unknown"],
  ["   ", "unknown"],
  [undefined, "unknown"],
];

test("each User-Agent falls in its one class; the AI fetchers before the generic bot rule", () => {
  for (const [userAgent, expected] of CASES) {
    assert.equal(classifyPublicRequester(userAgent), expected, String(userAgent));
  }
});

test("every caller gets a user_agent_class: Raft Apps and HTTP libraries first, then the public classes", () => {
  assert.equal(classifyRequesterUserAgent("Raft/1.15.5+42 (Android 14; release) Mobile"), "raft_app");
  assert.equal(classifyRequesterUserAgent("okhttp/4.12.0"), "okhttp");
  assert.equal(classifyRequesterUserAgent("Raft%20Dev/1 CFNetwork/1568 Darwin/24.0.0"), "cfnetwork");
  assert.equal(classifyRequesterUserAgent("Dart/3.5 (dart:io)"), "dart");
  assert.equal(classifyRequesterUserAgent("node"), "node");
  assert.equal(classifyRequesterUserAgent("undici"), "node");
  assert.equal(classifyRequesterUserAgent("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0"), "browser");
  assert.equal(classifyRequesterUserAgent("Mozilla/5.0 (compatible; Claude-User/1.0)"), "claude_user");
  assert.equal(classifyRequesterUserAgent("curl/8.5.0"), "other_bot");
  assert.equal(classifyRequesterUserAgent(undefined), "unknown");
  assert.equal(classifyRequesterUserAgent(""), "unknown");
});

test("user_agent_class is on every request span, never the raw User-Agent", () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 secret-tracking-token";
  const attrs = userAgentClassAttrs({ header: ((name: string) => (name.toLowerCase() === "user-agent" ? ua : undefined)) as never });
  assert.deepEqual(attrs, { user_agent_class: "browser" });
  assert.ok(!JSON.stringify(attrs).includes("secret-tracking-token"));
});
