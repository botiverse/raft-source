import assert from "node:assert/strict";
import { test } from "vitest";
import { shellCommandHeadCategory, traceCategory } from "./runtimeTraceCategories";

test("shell command head skips NAME=value assignments so a secret value is never recorded", () => {
  assert.equal(shellCommandHeadCategory("API_KEY=sk-secret123 npm test"), "npm");
  assert.equal(shellCommandHeadCategory("A=1 B=two  sleep 30"), "sleep");
  assert.equal(shellCommandHeadCategory("TOKEN=abc"), "other");
});

test("shell command head keeps only a short plain basename", () => {
  assert.equal(shellCommandHeadCategory("/usr/bin/git status"), "git");
  assert.equal(shellCommandHeadCategory("C:\\Tools\\node.exe script.js"), "node.exe");
  assert.equal(shellCommandHeadCategory("  raft message send --target x"), "raft");
  assert.equal(shellCommandHeadCategory("'quoted cmd' arg"), "other");
  assert.equal(shellCommandHeadCategory("$(curl evil) x"), "other");
  assert.equal(shellCommandHeadCategory(`${"a".repeat(33)} x`), "other");
  assert.equal(shellCommandHeadCategory(""), "other");
});

test("shell command head unwraps one known shell layer, as Codex runs every command", () => {
  // Codex app-server's commandExecution.command, as seen from the real CLI 0.155.1.
  assert.equal(shellCommandHeadCategory("/bin/bash -lc 'sleep 3'"), "sleep");
  assert.equal(shellCommandHeadCategory(["/bin/zsh", "-lc", "sleep 30"]), "sleep");
  assert.equal(shellCommandHeadCategory('bash -c "npm test -- --watch=false"'), "npm");
  assert.equal(shellCommandHeadCategory("sh -c ls"), "ls");
  assert.equal(shellCommandHeadCategory("bash -lc 'API_KEY=sk-secret123 curl https://h'"), "curl");
  assert.equal(shellCommandHeadCategory(["/bin/bash", "-lc", "TOKEN=abc npm run x"]), "npm");
  // A second layer is not unpacked.
  assert.equal(shellCommandHeadCategory("bash -lc 'bash -c \"sleep 1\"'"), "bash");
  // A shell without -c/-lc runs a script or is interactive: it is the head.
  assert.equal(shellCommandHeadCategory("bash script.sh"), "bash");
  assert.equal(shellCommandHeadCategory(["/bin/bash", "-x", "s.sh"]), "bash");
});

test("shell command head records other wrappers as they are and never unpacks them", () => {
  assert.equal(shellCommandHeadCategory("sudo systemctl restart x"), "sudo");
  assert.equal(shellCommandHeadCategory("env FOO=bar node x"), "env");
});

test("shell command head is absent for non-command input", () => {
  assert.equal(shellCommandHeadCategory(undefined), undefined);
  assert.equal(shellCommandHeadCategory({ command: "ls" }), undefined);
  assert.equal(shellCommandHeadCategory([1, 2]), undefined);
});

test("trace category keeps short tokens and replaces anything else", () => {
  assert.equal(traceCategory("commentary"), "commentary");
  assert.equal(traceCategory("final_answer"), "final_answer");
  assert.equal(traceCategory("hello world"), "other");
  assert.equal(traceCategory(""), undefined);
  assert.equal(traceCategory(3), undefined);
});
