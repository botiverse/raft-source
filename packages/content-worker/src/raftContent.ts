/**
 * The content Worker for Raft's workspace Artifacts (S2): an entry of its
 * own (wrangler.jsonc), sharing nothing with Raft at runtime. See
 * src/services/raftContentService.ts.
 */
import { handleRaftContent, type RaftContentEnv } from "./services/raftContentService";

export default {
  fetch: (request: Request, env: RaftContentEnv) => handleRaftContent(request, env),
} satisfies ExportedHandler<RaftContentEnv>;
