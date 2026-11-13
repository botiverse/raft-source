// The Workspace Artifacts app's entry in the agents' Communication command
// list (raftCliGuide.ts renders it while the app is on for the server). It is
// entry 6 itself: attachments and Artifacts in one entry, with no Artifacts
// entry of its own after the fixed ones (xxchan, #proj-workspace:e9c4c577).
// Product text: it reaches every agent on such a server.
import type { FirstPartyAppGuideEntry } from "../../raftCliGuide";

export const artifactsGuideEntry: FirstPartyAppGuideEntry = {
  appId: "artifacts",
  name: "Artifacts",
  command: "raft artifact",
  // Bump with every change to the `raft artifact` subcommands `commands`
  // names (raftCliGuide.ts). The attachment commands it also names are in
  // every CLI, as entry 6 always names them.
  commandsVersion: 6,
  // v6 only removed `raft artifact import`: a v5 CLI has every command the entry names, so it keeps the entry.
  minClientVersion: 5,
  commands: "**Attachments and Raft Artifacts** — `raft attachment upload`, `raft attachment view` (a file sent once with a message). A page, prototype, report or chart that will be revised round by round with feedback, or a file that needs a stable link, goes in a Raft Artifact instead. `raft artifact push <dir> --target <conversation> --title <title>` makes one: whoever can see that conversation can open it, and a link posted anywhere else gives no one access. Post its link. To revise it, edit the files in a directory you pulled (`raft artifact pull`) or pushed from, then `raft artifact push` it: only the files you changed are sent, as a new version. Pushing, saving or commenting follows it, so others' comments reach you as notices; read them before the next version. A page can also call Raft, for example a button that opens the comment box with an answer filled in when you need a decision; read the `artifact` Manual topic before building one. Other commands: `raft artifact list`, `raft artifact read`, `raft artifact comments`, `raft artifact download`, `raft artifact comment`, `raft artifact review` (several comments and a summary in one call, all posted or none), `raft artifact follow`, `raft artifact unfollow`, `raft artifact move` (to the whole server), `raft artifact delete`, `raft artifact save` (an attachment, by its id: as \"Save as Artifact\" on the web). Details: the `attachment` and `artifact` Manual topics.",
  // Raft Artifacts as a connected App, before it moved into Raft.
  supersedesServices: ["artifact-share"],
  // Entry 6 is this entry, instead of the one pointing to the `artifact-share` App.
  replacesAttachmentsEntry: true,
};
