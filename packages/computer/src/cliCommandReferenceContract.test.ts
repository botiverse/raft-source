import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "vitest";

import { program } from "./cli.js";

type CommanderCommand = typeof program;

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listSourceFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function extractReferences(src: string): string[] {
  const refs: string[] = [];
  const body = stripComments(src);
  const re = /\braft-computer\s+([^\n`"']+)/g;
  for (let match = re.exec(body); match !== null; match = re.exec(body)) {
    const raw = `raft-computer ${match[1] ?? ""}`
      .replace(/[\\),.;:]+$/g, "")
      .trim();
    refs.push(raw);
  }
  return refs;
}

function optionNames(command: CommanderCommand): Set<string> {
  const opts = new Set<string>();
  for (const option of command.options) {
    if (option.long) opts.add(option.long);
  }
  return opts;
}

function commandByName(command: CommanderCommand, name: string): CommanderCommand | undefined {
  return command.commands.find((child) => child.name() === name) as CommanderCommand | undefined;
}

function resolveReference(ref: string): { command: CommanderCommand; consumed: number; tokens: string[] } {
  const tokens = ref.split(/\s+/).slice(1).map((token) => token.replace(/[\\),.;:]+$/g, ""));
  assert.ok(tokens.length > 0, `empty raft-computer reference: ${ref}`);
  const first = tokens[0];
  assert.ok(first, `empty raft-computer command: ${ref}`);
  let command = commandByName(program, first);
  assert.ok(command, `unknown raft-computer command in "${ref}"`);
  let consumed = 1;
  while (tokens[consumed] && /^[a-z][\w-]*$/.test(tokens[consumed])) {
    const child = commandByName(command, tokens[consumed]);
    if (!child) break;
    command = child;
    consumed += 1;
  }
  return { command, consumed, tokens };
}

test("user-facing raft-computer command references point at registered commands and flags", async () => {
  const srcDir = new URL(".", import.meta.url).pathname;
  const files = await listSourceFiles(srcDir);
  const failures: string[] = [];

  for (const file of files) {
    const rel = relative(srcDir, file);
    const refs = extractReferences(await readFile(file, "utf8"));
    for (const ref of refs) {
      try {
        const { command, consumed, tokens } = resolveReference(ref);
        const allowed = optionNames(command);
        for (const token of tokens.slice(consumed)) {
          const flag = token.match(/^(--[a-z][\w-]*)/)?.[1];
          if (!flag) continue;
          assert.ok(allowed.has(flag), `unknown option ${flag} for "${ref}"`);
        }
      } catch (err) {
        failures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("status command has zero OS-supervisor inspection or mutation calls", async () => {
  const source = await readFile(new URL("./cli.ts", import.meta.url), "utf8");
  const start = source.indexOf('.command("status")');
  const end = source.indexOf('.command("doctor")', start);
  assert.ok(start >= 0 && end > start, "status command block must remain discoverable");
  const statusBlock = source.slice(start, end);
  assert.doesNotMatch(statusBlock, /inspectOsSupervisor|mutateOsSupervisor|OS supervisor/);
});
