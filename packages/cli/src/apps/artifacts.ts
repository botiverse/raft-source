// The Workspace Artifacts app's part of the CLI: the `raft artifact` command
// group (program.ts registers it where it stands in the help). The commands
// themselves are in commands/artifact/; their text and operations are shared
// with the SDK (@botiverse/raft-shared agentOps/artifacts.ts).
import type { Command } from "commander";
import { artifactPageManualHint } from "@botiverse/raft-shared/src/agentCliSurface";
import { registerArtifactCheckCommand } from "../commands/artifact/check";
import { registerArtifactCommentCommand } from "../commands/artifact/comment";
import { registerArtifactCommentsCommand } from "../commands/artifact/comments";
import { registerArtifactDownloadCommand } from "../commands/artifact/download";
import { registerArtifactFollowCommands } from "../commands/artifact/follow";
import { registerArtifactListCommand } from "../commands/artifact/list";
import { registerArtifactManageCommands } from "../commands/artifact/manage";
import { registerArtifactPublishCommand } from "../commands/artifact/publish";
import { registerArtifactPullCommand } from "../commands/artifact/pull";
import { registerArtifactReadCommand } from "../commands/artifact/read";
import { registerArtifactResolveCommands } from "../commands/artifact/resolve";
import { registerArtifactReviewCommand } from "../commands/artifact/review";
import { registerArtifactSaveCommand } from "../commands/artifact/save";
import type { CommandRuntimeOptions } from "../core/context";

export function registerArtifactsCommands(program: Command, runtimeOptions?: CommandRuntimeOptions): void {
  const artifactCmd = program
    .command("artifact")
    .description("Artifacts: versioned pages and files with comments")
    // The full guide is the Manual's `artifact` topic (task #263 in proj-workspace), by a command that runs as printed.
    .addHelpText(
      "after",
      "\nThe full guide (making pages that show well, what a page can call in Raft such as comment buttons, copy and links, comments and versions) is in the Manual:\n"
        + `  ${artifactPageManualHint()}\n`,
    );
  registerArtifactReadCommand(artifactCmd, runtimeOptions);
  registerArtifactListCommand(artifactCmd, runtimeOptions);
  registerArtifactCommentsCommand(artifactCmd, runtimeOptions);
  registerArtifactDownloadCommand(artifactCmd, runtimeOptions);
  registerArtifactPullCommand(artifactCmd, runtimeOptions);
  registerArtifactPublishCommand(artifactCmd, runtimeOptions);
  registerArtifactCheckCommand(artifactCmd, runtimeOptions);
  registerArtifactCommentCommand(artifactCmd, runtimeOptions);
  registerArtifactReviewCommand(artifactCmd, runtimeOptions);
  registerArtifactResolveCommands(artifactCmd, runtimeOptions);
  registerArtifactFollowCommands(artifactCmd, runtimeOptions);
  registerArtifactManageCommands(artifactCmd, runtimeOptions);
  registerArtifactSaveCommand(artifactCmd, runtimeOptions);
}
