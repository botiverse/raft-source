/**
 * AI training crawlers that Raft's robots.txt files turn away from every
 * path (huxijin, #proj-seo:ba1b65bd): public Artifacts are users' content,
 * readable by anyone with the link but not collected for training. Fetchers a
 * person triggers (ChatGPT-User, Claude-User, Perplexity-User) are not listed:
 * they follow the `*` rules, which let them read public Artifact pages.
 * Served by the API host (packages/server app.ts) and the web's static
 * packages/web/public/robots.txt (a web test checks it lists exactly these).
 */
export const AI_TRAINING_CRAWLERS: readonly string[] = [
  "GPTBot",
  "ClaudeBot",
  "anthropic-ai",
  "Claude-Web",
  "Google-Extended",
  "CCBot",
  "Applebot-Extended",
  "meta-externalagent",
  "Bytespider",
  "cohere-ai",
  "Amazonbot",
  "MistralAI-Training",
];

/** One `User-agent` / `Disallow: /` group per training crawler, each followed by a blank line. */
export function aiTrainingCrawlerRobotsLines(): string[] {
  return AI_TRAINING_CRAWLERS.flatMap((agent) => [`User-agent: ${agent}`, "Disallow: /", ""]);
}
