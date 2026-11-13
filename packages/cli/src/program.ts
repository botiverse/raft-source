// Raft CLI program construction. Building the commander tree here (instead of
// at main.ts module top level) keeps it free of import-time side effects, so
// tests can build the exact program the binary runs, with injected runtime
// options (io/env/agent context/API client). main.ts is the process entry.
//
//
// Resource-based command surface (singular nouns per v0 spec
// thread #slock-cli:75b30164):
//   raft auth whoami
//   raft version
//   raft server info
//   raft channel members "#name"
//   raft channel create --name <name>
//   raft channel update --target "#name" --name <new-name>
//   raft channel archive --target "#name"
//   raft channel unarchive --target "#name"
//   raft channel add-member --target "#name" --user @name
//   raft channel remove-member --target "#name" --user @name
//   raft channel join --target "#name"
//   raft channel leave --target "#name"
//   raft channel mute --target "#name"
//   raft channel unmute --target "#name"
//   raft thread list
//   raft thread unfollow --target "#name:shortid"
//   raft manual get <topic>
//   raft manual search <keywords>
//   raft inbox check/read/dismiss
//   raft message send/check/read/search/resolve/react
//   raft attachment upload/view
//   raft task list/create/claim/unclaim/assign/unassign/update/amend/history/convert/delete
//   raft mention pending/notify/invite
//   raft profile show/update
//   raft integration list/marketplace/login/env/invoke/app prepare|rotate-secret|update|transfer-owner
//   raft reminder schedule/list/cancel/snooze/update/log
//   raft action prepare/withdraw
//   raft migration retry

import { Command, CommanderError } from "commander";

import { CliError, CliExit } from "./core/errors";
import type { CommandRuntimeOptions } from "./core/context";
import { defaultCliIo, type CliIo } from "./core/io";
import { renderError } from "./core/renderer";
import { readCliVersion } from "./version";
import { registerWhoamiCommand } from "./commands/auth/whoami";
import { registerVersionCommand } from "./commands/version";
import { registerAgentListCommand } from "./commands/agent/list";
import { registerAgentLoginCommand } from "./commands/agent/login";
import { registerAgentLogoutCommand } from "./commands/agent/logout";
import { registerAgentBridgeCommand } from "./commands/agent/bridge";
import { registerActionPrepareCommand } from "./commands/action/prepare";
import { registerActionWithdrawCommand } from "./commands/action/withdraw";
import { registerChannelMembersCommand } from "./commands/channel/members";
import { registerChannelInfoCommand } from "./commands/channel/info";
import { registerChannelCreateCommand } from "./commands/channel/create";
import { registerChannelUpdateCommand } from "./commands/channel/update";
import { registerChannelArchiveCommand, registerChannelUnarchiveCommand } from "./commands/channel/lifecycle";
import { registerChannelAddMemberCommand } from "./commands/channel/add-member";
import { registerChannelRemoveMemberCommand } from "./commands/channel/remove-member";
import { registerChannelJoinCommand } from "./commands/channel/join";
import { registerChannelMuteCommand, registerChannelUnmuteCommand } from "./commands/channel/mute";
import { registerServerInfoCommand } from "./commands/server/info";
import { registerServerUpdateCommand } from "./commands/server/update";
import { registerUserInfoCommand } from "./commands/user/info";
import { registerKnowledgeGetCommand } from "./commands/knowledge/get";
import { registerKnowledgeSearchCommand } from "./commands/knowledge/search";
import { registerInboxCheckCommand } from "./commands/inbox/check";
import { registerInboxDismissCommand } from "./commands/inbox/dismiss";
import { registerInboxReadCommand } from "./commands/inbox/read";
import { registerChannelLeaveCommand } from "./commands/channel/leave";
import { registerThreadListCommand } from "./commands/thread/list";
import { registerProcStartCommand } from "./commands/proc/start";
import { registerProcListCommand } from "./commands/proc/list";
import { registerProcLogsCommand } from "./commands/proc/logs";
import { registerProcStopCommand } from "./commands/proc/stop";
import { registerThreadFollowCommand } from "./commands/thread/follow";
import { registerThreadUnfollowCommand } from "./commands/thread/unfollow";
import { registerContextSearchCommand } from "./commands/context/search";
import { registerContextReadCommand } from "./commands/context/read";
import { registerSendCommand } from "./commands/message/send";
import { registerCheckCommand } from "./commands/message/check";
import { registerReadCommand } from "./commands/message/read";
import { registerSearchCommand } from "./commands/message/search";
import { registerResolveCommand } from "./commands/message/resolve";
import { registerReactCommand } from "./commands/message/react";
import { registerUpdateCardCommand } from "./commands/message/updateCard";
import { registerAttachmentUploadCommand } from "./commands/attachment/upload";
import { registerAttachmentViewCommand } from "./commands/attachment/view";
import { registerAttachmentCommentsCommand } from "./commands/attachment/comments";
import { registerMigrationRetryCommand } from "./commands/migration/retry";
import { registerArtifactsCommands } from "./apps/artifacts";
import { registerTaskListCommand } from "./commands/task/list";
import { registerTaskCreateCommand } from "./commands/task/create";
import { registerTaskClaimCommand } from "./commands/task/claim";
import { registerTaskAssignCommand } from "./commands/task/assign";
import { registerTaskUnassignCommand } from "./commands/task/unassign";
import { registerTaskUnclaimCommand } from "./commands/task/unclaim";
import { registerTaskUpdateCommand } from "./commands/task/update";
import { registerTaskReceiptCommand } from "./commands/task/receipt";
import { registerTaskDeleteCommand } from "./commands/task/delete";
import { registerTaskConvertCommand } from "./commands/task/convert";
import { registerTaskAmendCommand } from "./commands/task/amend";
import { registerTaskHistoryCommand } from "./commands/task/history";
import { registerTaskShowCommand } from "./commands/task/show";
import { registerTaskViewCommand } from "./commands/task/view";
import { registerTaskReplyCommand } from "./commands/task/reply";
import { registerTaskReadCommand } from "./commands/task/read";
import { registerTaskFollowCommands } from "./commands/task/follow";
import { registerMentionCommands } from "./commands/mention/index";
import { registerProfileShowCommand } from "./commands/profile/show";
import { registerProfileUpdateCommand } from "./commands/profile/update";
import { registerIntegrationListCommand } from "./commands/integration/list";
import { registerIntegrationMarketplaceCommand } from "./commands/integration/marketplace";
import { registerIntegrationTokenCommand } from "./commands/integration/token";
import { registerIntegrationLoginCommand } from "./commands/integration/login";
import { registerIntegrationEnvCommand } from "./commands/integration/env";
import { registerIntegrationInvokeCommand } from "./commands/integration/invoke";
import { registerIntegrationAppCommands } from "./commands/integration/app";
import { registerReminderScheduleCommand } from "./commands/reminder/schedule";
import { registerReminderListCommand } from "./commands/reminder/list";
import { registerReminderCancelCommand } from "./commands/reminder/cancel";
import { registerReminderSnoozeCommand } from "./commands/reminder/snooze";
import { registerReminderUpdateCommand } from "./commands/reminder/update";
import { registerReminderLogCommand } from "./commands/reminder/log";
import { registerReminderTriggerCommand } from "./commands/reminder/trigger";
import { registerAppConfigCommand } from "./commands/app/config";
import { registerContinueCommand } from "./commands/continuation/continue";

export interface RaftProgramOptions extends CommandRuntimeOptions {
  /** Fixed help wrap width (tests); default: Commander's terminal detection. */
  helpWidth?: number;
}

function stripCommanderPrefix(message: string): string {
  return message.replace(/^error:\s*/i, "");
}

function userCommandArgs(argv: string[]): string[] {
  const args = argv.slice(2);
  const commandArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      commandArgs.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-p" || arg === "--profile") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) continue;
    commandArgs.push(arg);
  }
  return commandArgs;
}

function commandHelpTarget(program: Command, userArgs: string[]): string {
  const path: string[] = [];
  let cursor: Command = program;
  for (const arg of userArgs) {
    if (arg.startsWith("-")) break;
    const child = cursor.commands.find((candidate) => candidate.name() === arg || candidate.aliases().includes(arg));
    if (!child) break;
    path.push(child.name());
    cursor = child;
  }
  return ["raft", ...path].join(" ");
}

function visibleSubcommandList(program: Command, userArgs: string[]): string {
  let cursor: Command = program;
  for (const arg of userArgs) {
    if (arg.startsWith("-")) break;
    const child = cursor.commands.find((candidate) => candidate.name() === arg || candidate.aliases().includes(arg));
    if (!child) break;
    cursor = child;
  }
  return cursor.createHelp()
    .visibleCommands(cursor)
    .filter((candidate) => candidate.name() !== "help")
    .map((candidate) => candidate.name())
    .join(", ");
}

function parseStageErrorToCliError(err: CommanderError, program: Command, argv: string[]): CliError {
  const userArgs = userCommandArgs(argv);
  const helpTarget = commandHelpTarget(program, userArgs);
  const subcommands = visibleSubcommandList(program, userArgs);
  const message = stripCommanderPrefix(err.message);
  switch (err.code) {
    case "commander.missingArgument":
      return new CliError({
        code: "INVALID_ARG",
        message,
        suggestedNextAction:
          helpTarget === "raft manual get"
            ? "Run `raft manual get index` for the topic index, or `raft manual get --help` for syntax."
            : `Run \`${helpTarget} --help\` for syntax.`,
      });
    case "commander.unknownCommand":
      return new CliError({
        code: "INVALID_ARG",
        message,
        suggestedNextAction: subcommands
          ? `Run \`${helpTarget} --help\` to list valid subcommands: ${subcommands}.`
          : `Run \`${helpTarget} --help\` to list available subcommands.`,
      });
    case "commander.unknownOption":
      return new CliError({
        code: "INVALID_ARG",
        message,
        suggestedNextAction: `Run \`${helpTarget} --help\` to list supported flags.`,
      });
    default:
      return new CliError({
        code: "INVALID_ARG",
        message,
        suggestedNextAction: `Run \`${helpTarget} --help\` for syntax.`,
      });
  }
}

export function buildRaftProgram(runtime: RaftProgramOptions = {}): Command {
  const program = new Command();
  const { helpWidth, ...runtimeOptions } = runtime;

  program
    .name("raft")
    .description(
      "Agent-facing CLI for Raft. Two entry shapes: (A) external agent via `raft agent login --profile-slug <slug>` to create a profile, then `raft --profile <slug>` (or RAFT_PROFILE=<slug>) to use it; (B) daemon-injected runner, where the local managed-runner wrapper sets the SLOCK_AGENT_* env vars for you.",
    )
    .option(
      "-p, --profile <slug>",
      "Use an existing local profile credential outside managed runtimes. Equivalent to setting RAFT_PROFILE=<slug>. To create a new profile, use `raft agent login --profile-slug <slug>`.",
    );

  const cliVersion = readCliVersion();
  if (cliVersion === "unknown") {
    program.option("-V, --version", "output the CLI version number");
    program.on("option:version", () => {
      const error = new CliError({
        code: "VERSION_UNAVAILABLE",
        message: "The invoked Raft CLI does not contain trustworthy version metadata.",
        suggestedNextAction: "Reinstall or upgrade Raft Computer; do not report a placeholder version.",
      });
      renderError(runtimeOptions.io ?? defaultCliIo(), error);
      throw new CliExit(error.exitCode);
    });
  } else {
    program.version(`Raft CLI: ${cliVersion}`);
  }

  program.exitOverride();
  // Configured before any subcommand is added: subcommands inherit the root's
  // output configuration when they are created.
  const injectedIo = runtimeOptions.io;
  program.configureOutput({
    outputError: () => {
      // Parse-stage errors are rendered through the canonical CLI error renderer
      // in runRaftArgv. Help/version output still uses Commander's normal
      // stdout/stderr writers (or the injected io).
    },
    ...(injectedIo
      ? {
          writeOut: (str: string) => { injectedIo.stdout.write(str); },
          writeErr: (str: string) => { injectedIo.stderr.write(str); },
        }
      : {}),
    ...(helpWidth !== undefined
      ? { getOutHelpWidth: () => helpWidth, getErrHelpWidth: () => helpWidth }
      : {}),
  });

  // Plumb --profile into the env var that `loadAgentContext` reads. Doing this
  // in a `preAction` hook keeps the auth bootstrap in one place (auth/env.ts)
  // instead of threading a context through every subcommand. An explicit flag
  // is a one-shot identity switch outside managed runtimes and overrides any
  // inherited RAFT_PROFILE from the shell. loadAgentContext rejects the switch
  // when managed launch markers are present, so it cannot replace the daemon's
  // bound identity.
  program.hook("preAction", () => {
    const opts = program.opts<{ profile?: string }>();
    if (opts.profile) {
      (runtimeOptions.env ?? process.env).RAFT_PROFILE = opts.profile;
    }
  });

  registerVersionCommand(program, runtimeOptions);

  const authCmd = program.command("auth").description("Auth introspection");
  registerWhoamiCommand(authCmd, runtimeOptions);

  const agentCmd = program
    .command("agent")
    .description("External agent onboarding (device-code login → sk_agent_* mint → local profile credential)");
  registerAgentLoginCommand(agentCmd, runtimeOptions);
  registerAgentLogoutCommand(agentCmd, runtimeOptions);
  registerAgentListCommand(agentCmd, runtimeOptions);
  registerAgentBridgeCommand(agentCmd, runtimeOptions);

  const channelCmd = program.command("channel").description("Channel membership and attention operations");
  registerChannelInfoCommand(channelCmd, runtimeOptions);
  registerChannelMembersCommand(channelCmd, runtimeOptions);
  registerChannelCreateCommand(channelCmd, runtimeOptions);
  registerChannelUpdateCommand(channelCmd, runtimeOptions);
  registerChannelArchiveCommand(channelCmd, runtimeOptions);
  registerChannelUnarchiveCommand(channelCmd, runtimeOptions);
  registerChannelAddMemberCommand(channelCmd, runtimeOptions);
  registerChannelRemoveMemberCommand(channelCmd, runtimeOptions);
  registerChannelJoinCommand(channelCmd, runtimeOptions);
  registerChannelLeaveCommand(channelCmd, runtimeOptions);
  registerChannelMuteCommand(channelCmd, runtimeOptions);
  registerChannelUnmuteCommand(channelCmd, runtimeOptions);

  const threadCmd = program.command("thread").description("Thread attention operations");
  registerThreadListCommand(threadCmd, runtimeOptions);
  registerThreadFollowCommand(threadCmd, runtimeOptions);
  registerThreadUnfollowCommand(threadCmd, runtimeOptions);

  const serverCmd = program.command("server").description("Server / workspace introspection");
  registerServerInfoCommand(serverCmd, runtimeOptions);
  registerServerUpdateCommand(serverCmd, runtimeOptions);

  const userCmd = program.command("user").description("User and agent introspection");
  registerUserInfoCommand(userCmd, runtimeOptions);

  const manualCmd = program
    .command("manual")
    .description("Look up Raft operating topics and agent recipes")
    .addHelpText(
      "after",
      "\nCommon agent flows:\n"
        + "  raft manual get index --intent \"Learn available Raft workflows\" --reason \"Need the topic catalog before answering\"\n"
        + "  raft manual get recipes/seeded --intent \"Choose a safe Raft workflow\" --reason \"Need the core recipe map now\"\n"
        + "  raft manual search \"preview before merge\" --scope recipes --intent \"Safely preview a change before merge\" --reason \"Need the recommended preview workflow now\"\n"
        + "\nUse `raft manual get --help` and `raft manual search --help` for options.\n",
    );
  registerKnowledgeGetCommand(manualCmd, runtimeOptions);
  registerKnowledgeSearchCommand(manualCmd, runtimeOptions);

  const knowledgeCmd = program.command("knowledge").description("Legacy alias for `raft manual`");
  registerKnowledgeGetCommand(knowledgeCmd, runtimeOptions);
  registerKnowledgeSearchCommand(knowledgeCmd, runtimeOptions);

  const contextCmd = program.command("context").description("Search and read the context behind a message: what the model was given when it wrote it");
  registerContextSearchCommand(contextCmd, runtimeOptions);
  registerContextReadCommand(contextCmd, runtimeOptions);

  const inboxCmd = program.command("inbox").description("Inbox target summary operations");
  registerInboxCheckCommand(inboxCmd, runtimeOptions);
  registerInboxReadCommand(inboxCmd, runtimeOptions);
  registerInboxDismissCommand(inboxCmd, runtimeOptions);

  const messageCmd = program.command("message").description("Message operations");
  registerSendCommand(messageCmd, runtimeOptions);
  registerCheckCommand(messageCmd, runtimeOptions);
  registerReadCommand(messageCmd, runtimeOptions);
  registerSearchCommand(messageCmd, runtimeOptions);
  registerResolveCommand(messageCmd, runtimeOptions);
  registerReactCommand(messageCmd, runtimeOptions);
  registerUpdateCardCommand(messageCmd, runtimeOptions);

  const attachmentCmd = program.command("attachment").description("Attachment operations");
  registerAttachmentUploadCommand(attachmentCmd, runtimeOptions);
  registerAttachmentViewCommand(attachmentCmd, runtimeOptions);
  registerAttachmentCommentsCommand(attachmentCmd, runtimeOptions);

  registerArtifactsCommands(program, runtimeOptions);

  const taskCmd = program.command("task").description("Task board operations");
  registerTaskListCommand(taskCmd, runtimeOptions);
  registerTaskCreateCommand(taskCmd, runtimeOptions);
  registerTaskClaimCommand(taskCmd, runtimeOptions);
  registerTaskUnclaimCommand(taskCmd, runtimeOptions);
  registerTaskAssignCommand(taskCmd, runtimeOptions);
  registerTaskUnassignCommand(taskCmd, runtimeOptions);
  registerTaskUpdateCommand(taskCmd, runtimeOptions);
  registerTaskReceiptCommand(taskCmd, runtimeOptions);
  registerTaskDeleteCommand(taskCmd, runtimeOptions);
  registerTaskConvertCommand(taskCmd, runtimeOptions);
  registerTaskAmendCommand(taskCmd, runtimeOptions);
  registerTaskHistoryCommand(taskCmd, runtimeOptions);
  registerTaskShowCommand(taskCmd, runtimeOptions);
  registerTaskViewCommand(taskCmd, runtimeOptions);
  registerTaskReplyCommand(taskCmd, runtimeOptions);
  registerTaskReadCommand(taskCmd, runtimeOptions);
  registerTaskFollowCommands(taskCmd, runtimeOptions);

  const mentionCmd = program.command("mention").description("Sender-side mention action operations");
  registerMentionCommands(mentionCmd, runtimeOptions);

  const profileCmd = program.command("profile").description("Profile operations");
  registerProfileShowCommand(profileCmd, runtimeOptions);
  registerProfileUpdateCommand(profileCmd, runtimeOptions);

  const integrationCmd = program.command("integration").description("Third-party service integration operations");
  registerIntegrationListCommand(integrationCmd, runtimeOptions);
  registerIntegrationMarketplaceCommand(integrationCmd, runtimeOptions);
  registerIntegrationLoginCommand(integrationCmd, runtimeOptions);
  registerIntegrationTokenCommand(integrationCmd, runtimeOptions);
  registerIntegrationEnvCommand(integrationCmd, runtimeOptions);
  registerIntegrationInvokeCommand(integrationCmd, runtimeOptions);
  registerIntegrationAppCommands(integrationCmd, runtimeOptions);

  const reminderCmd = program.command("reminder").description("Reminder operations");
  registerReminderScheduleCommand(reminderCmd, runtimeOptions);
  registerReminderListCommand(reminderCmd, runtimeOptions);
  registerReminderCancelCommand(reminderCmd, runtimeOptions);
  registerReminderSnoozeCommand(reminderCmd, runtimeOptions);
  registerReminderUpdateCommand(reminderCmd, runtimeOptions);
  registerReminderLogCommand(reminderCmd, runtimeOptions);
  registerReminderTriggerCommand(reminderCmd, runtimeOptions);

  const migrationCmd = program.command("migration").description("Your own moves to another Computer");
  registerMigrationRetryCommand(migrationCmd, runtimeOptions);

  const procCmd = program.command("proc").description("Background jobs the Computer runs for this agent");
  registerProcStartCommand(procCmd, runtimeOptions);
  registerProcListCommand(procCmd, runtimeOptions);
  registerProcLogsCommand(procCmd, runtimeOptions);
  registerProcStopCommand(procCmd, runtimeOptions);

  const appCmd = program.command("app").description("Built-in RAP App operations");
  registerAppConfigCommand(appCmd, runtimeOptions);

  const actionCmd = program.command("action").description("Action card operations (B-mode quick-commit shortcuts)");
  registerActionPrepareCommand(actionCmd, runtimeOptions);
  registerActionWithdrawCommand(actionCmd, runtimeOptions);

  // Hidden: `cont <id> [choice]` (the daemon's wrapper) answers a command that paused.
  registerContinueCommand(program, runtimeOptions);

  return program;
}

/**
 * Map any error out of a CLI run to its rendered output and exit code: CliExit
 * (output already written), CliError (rendered), Commander parse-stage errors
 * (rendered as INVALID_ARG with a `--help` pointer), anything else
 * ("Unexpected error").
 */
export function handleRaftCliError(err: unknown, program: Command, argv: string[], io: CliIo = defaultCliIo()): number {
  if (err instanceof CliExit) {
    return err.exitCode;
  } else if (err instanceof CliError) {
    renderError(io, err);
    return err.exitCode;
  } else if (err instanceof CommanderError) {
    if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
      return err.exitCode;
    }
    const cliError = parseStageErrorToCliError(err, program, argv);
    renderError(io, cliError);
    return cliError.exitCode;
  }
  io.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

/**
 * Run node-style argv (`[execPath, scriptPath, ...args]`) through a program
 * from buildRaftProgram and return the exit code.
 *
 * Parses explicitly as `from: "node"`. The daemon-injected wrapper always
 * invokes us as `<execPath> <cliScript> <args>`, so argv is always node-style.
 * Commander's default no-arg parse auto-detects `process.versions.electron`
 * and, when set, switches to "electron" mode that strips only ONE leading arg
 * — but in the packaged Computer app the wrapper runs us via the Electron
 * binary with `ELECTRON_RUN_AS_NODE=1` (task #402), where
 * `process.versions.electron` is still defined yet argv IS node-style (script
 * path present). Auto-detection would then leave the script path as a phantom
 * command (`unknown command '.../index.js'`). Forcing `from: "node"` is
 * correct for both plain Node and Electron-as-node hosts.
 */
export async function runRaftArgv(program: Command, argv: string[], io: CliIo = defaultCliIo()): Promise<number> {
  try {
    await program.parseAsync(argv, { from: "node" });
    return 0;
  } catch (err) {
    return handleRaftCliError(err, program, argv, io);
  }
}
