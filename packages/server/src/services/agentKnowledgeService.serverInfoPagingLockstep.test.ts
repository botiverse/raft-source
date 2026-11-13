import assert from "node:assert/strict";

import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService";

// #8227 corrected a false claim on two agent-facing pages: `raft server info` was
// documented as listing every channel, when it returns counts only and
// `raft server info --channels` returns ONE PAGE (50) of what this server has 190 of.
// The corrected text quotes the CLI's own paging footer, `Showing 1-50 of N`, and
// tells the agent the `--offset` command continues it.

const QUOTED_FOOTER = /Showing 1-50 of N/;
const PAGED_TOPICS = ["channel", "raft-cli-overview"] as const;

test("[quoted-literal] both pages quote the paging footer rather than describing it", async () => {
  for (const topic of PAGED_TOPICS) {
    const resolved = await resolveAgentKnowledgeDoc(topic);
    assert.ok(resolved, `the ${topic} topic must resolve`);
    assert.match(resolved.content, QUOTED_FOOTER,
      `${topic} must quote the footer an agent actually sees, not paraphrase it`);
    assert.match(resolved.content, /--channels/,
      `${topic} must name the flag that does the listing`);
    assert.match(resolved.content, /--offset/,
      `${topic} must name the flag that continues the listing`);
  }
});
