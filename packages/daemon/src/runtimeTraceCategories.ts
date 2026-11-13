// Category-only trace values: a label is recorded when it is a plain, short
// token and replaced by "other" otherwise, so free text (message bodies,
// command arguments, secrets) never reaches a trace attribute.

const CATEGORY_LABEL = /^[A-Za-z0-9._-]{1,32}$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function traceCategory(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return CATEGORY_LABEL.test(value) ? value : "other";
}

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash"]);
const SHELL_COMMAND_FLAGS = new Set(["-c", "-lc"]);

/**
 * The executable a shell tool call runs, as a category: leading `NAME=value`
 * assignments are skipped (`API_KEY=… npm test` is `npm`), only the basename
 * is kept, and anything that is not a short plain token is "other".
 *
 * One known shell wrapper is unwrapped, because Codex runs every command as
 * `/bin/bash -lc '<command>'` (string) or `["/bin/zsh", "-lc", "<command>"]`:
 * when the head is sh/bash/zsh/dash and the next word is -c or -lc, the same
 * rule is applied to the command string, once. Other wrappers (sudo, env) and
 * a second shell layer are recorded as they are, never unpacked further.
 */
export function shellCommandHeadCategory(command: unknown): string | undefined {
  if (Array.isArray(command)) {
    if (!command.every((part) => typeof part === "string")) return undefined;
    const parts = command as string[];
    const head = commandHead(parts.join(" "));
    if (isShellWrapper(head) && SHELL_COMMAND_FLAGS.has(parts[1] ?? "") && typeof parts[2] === "string") {
      return commandHead(parts[2]);
    }
    return head;
  }
  if (typeof command !== "string") return undefined;
  const head = commandHead(command);
  if (isShellWrapper(head)) {
    const inner = shellWrappedCommand(command);
    if (inner !== undefined) return commandHead(inner);
  }
  return head;
}

function isShellWrapper(head: string): boolean {
  return SHELL_WRAPPERS.has(head);
}

/** `bash -lc 'cmd'` / `bash -c "cmd"` / `bash -lc cmd`: the command string, or undefined. */
function shellWrappedCommand(command: string): string | undefined {
  const match = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\S+\s+(-l?c)\s+([\s\S]*)$/.exec(command);
  if (!match || !SHELL_COMMAND_FLAGS.has(match[1]!)) return undefined;
  const rest = match[2]!.trim();
  const quote = rest[0];
  if ((quote === "'" || quote === '"') && rest.length >= 2) {
    const end = rest.indexOf(quote, 1);
    return end > 0 ? rest.slice(1, end) : rest.slice(1);
  }
  return rest;
}

function commandHead(text: string): string {
  const words = text.trim().split(/\s+/);
  let index = 0;
  while (index < words.length && ENV_ASSIGNMENT.test(words[index]!)) index += 1;
  const head = words[index];
  if (!head) return "other";
  const basename = head.split(/[\\/]/).pop() ?? "";
  return CATEGORY_LABEL.test(basename) ? basename : "other";
}
