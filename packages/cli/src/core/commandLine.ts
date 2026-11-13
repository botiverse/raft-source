// The command an agent ran, rebuilt from what Commander parsed, for a step
// that says to run it again: `raft`, the global --profile when given, the
// command's path, its arguments and the options given on the command line
// (not defaults), each word quoted for a POSIX shell when it needs it.
// Equivalent to what was typed, not byte for byte (`--rev=9` comes back as
// `--rev 9`).

import { Command } from "commander";

const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One word for a POSIX shell: as it is when nothing in it is special, else in single quotes. */
export function shellWord(word: string): string {
  return PLAIN_WORD.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/** The options of `command` given on the command line, as flags and quoted values. */
function givenOptions(command: Command): string[] {
  const words: string[] = [];
  for (const option of command.options) {
    const key = option.attributeName();
    const flag = option.long ?? option.short;
    if (!flag || command.getOptionValueSource(key) !== "cli") continue;
    const value: unknown = command.getOptionValue(key);
    if (typeof value === "boolean") {
      // A plain flag is given when true; a `--no-…` flag when false.
      if (value !== option.negate) words.push(flag);
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) words.push(flag, shellWord(String(item)));
  }
  return words;
}

/**
 * The command as it was run (`raft artifact comment pt_abc --path a.html`),
 * from a command handler's arguments (Commander passes the command last), or
 * null when there is none (a handler called directly).
 */
export function commandLineOf(handlerArgs: readonly unknown[]): string | null {
  let command: Command | null = null;
  for (const arg of handlerArgs) if (arg instanceof Command) command = arg;
  if (!command) return null;
  const path: Command[] = [];
  for (let at: Command | null = command; at; at = at.parent) path.unshift(at);
  const [root, ...subcommands] = path;
  // The program's own (--profile) right after `raft`, as its help writes them.
  const head = ["raft", ...givenOptions(root!), ...subcommands.map((sub) => sub.name())];
  const options = subcommands.flatMap(givenOptions);
  const operands = command.args.map(shellWord);
  // An argument that starts with `-` would read as an option: options first, then `--`.
  return command.args.some((arg) => arg.startsWith("-"))
    ? [...head, ...options, "--", ...operands].join(" ")
    : [...head, ...operands, ...options].join(" ");
}
