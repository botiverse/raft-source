// Every first-party app's entry in the agents' command list, one line per
// app, in the server registry's order (raftCliGuide.ts renders the enabled
// ones in this order). Kept apart from apps/index.ts so the guide, which the
// daemon and web bundle, doesn't pull in the apps' agent API contracts.
import { artifactsGuideEntry } from "./artifacts/guide";
import type { FirstPartyAppGuideEntry } from "../raftCliGuide";

export const firstPartyAppGuideEntries: readonly FirstPartyAppGuideEntry[] = [artifactsGuideEntry];
