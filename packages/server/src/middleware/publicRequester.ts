// Who asks a signed-out public route (/api/public/*), as one of a few fixed
// classes from the User-Agent (#proj-analytics:#17, Tenny 4772ad78): how often a
// public Artifact's Markdown is read by an AI on a person's behalf, by AI
// crawlers, by other bots or in a browser. Recorded on server.http.request as
// `public_requester`; the raw User-Agent is never recorded.
//
// A User-Agent is whatever the caller says: use the class for counting only,
// never to allow, refuse or limit anything. `browser` is what a browser sends,
// including an AI agent driving a real browser: not proof of a person.

import { raftVersionFromUserAgent } from "../services/productEventContext";

export const PUBLIC_REQUESTER_CLASSES = [
  "chatgpt_user",
  "claude_user",
  "openai_crawler",
  "anthropic_crawler",
  "perplexity",
  "other_bot",
  "browser",
  "unknown",
] as const;
export type PublicRequesterClass = (typeof PUBLIC_REQUESTER_CLASSES)[number];

/** First match wins: the AI fetchers before the generic bot rule (their agents say `bot` too). */
const PUBLIC_REQUESTER_RULES: ReadonlyArray<readonly [PublicRequesterClass, RegExp]> = [
  // A person's ChatGPT or Claude reading a page they asked about.
  ["chatgpt_user", /\bChatGPT-User\b/i],
  ["claude_user", /\bClaude-User\b/i],
  // The vendors' own crawlers (training and search).
  ["openai_crawler", /\b(GPTBot|OAI-SearchBot)\b/i],
  ["anthropic_crawler", /\b(ClaudeBot|Claude-SearchBot|Claude-Web|anthropic-ai)\b/i],
  ["perplexity", /\bPerplexity(Bot|-User)\b/i],
  // Search engines, other fetchers (a `+https://…` contact address, which browsers never send),
  // link previews, scripts and headless browsers. `bot` only as a product token (`Googlebot/`,
  // `Slackbot-`), so a phone model like "CUBOT X30" or "CUBOT_X19" stays a browser.
  [
    "other_bot",
    /bot[/;-]|bot$|\+https?:\/\/|crawl|spider|slurp|preview|facebookexternalhit|headless|^curl\/|^wget\/|python-requests|python-urllib|aiohttp|httpx|^axios\/|node-fetch|undici|go-http-client|^java\/|okhttp|libwww|scrapy/i,
  ],
  ["browser", /^Mozilla\/5\.0 /],
];

/**
 * Who sent any request, as one fixed class of its User-Agent: a Raft App
 * (`Raft/<version>`), an HTTP library (okhttp, CFNetwork, Dart, Node), or one
 * of the public-requester classes above. Recorded on every
 * server.http.request as `user_agent_class` so a route's failures split by
 * caller type; counting only, like `public_requester`, and the raw
 * User-Agent is never recorded. HTTP libraries go first: the public rules
 * file some of them under other_bot.
 */
export function classifyRequesterUserAgent(userAgent: string | undefined): string {
  const value = userAgent?.trim() ?? "";
  if (raftVersionFromUserAgent(value)) return "raft_app";
  if (/^okhttp\//i.test(value)) return "okhttp";
  if (/\b(CFNetwork|Darwin)\//.test(value)) return "cfnetwork";
  if (/^Dart\//.test(value)) return "dart";
  if (/^(node|undici|axios)\b/i.test(value)) return "node";
  return classifyPublicRequester(value);
}

export function classifyPublicRequester(userAgent: string | undefined): PublicRequesterClass {
  const value = userAgent?.trim() ?? "";
  if (!value) return "unknown";
  for (const [requester, pattern] of PUBLIC_REQUESTER_RULES) {
    if (pattern.test(value)) return requester;
  }
  return "unknown";
}
