import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSupervisorCommandPlan, buildOsSupervisorSpec } from "./osSupervisor.js";
import {
  retireLegacyOsSupervisor,
  isWindowsTaskMissingExitCode,
  supervisorExitCode,
  supervisorFailureDetail,
  type SupervisorCommandRunner,
} from "./osSupervisorRuntime.js";

/**
 * Windows task absence must be decided by the typed `/HRESULT` exit code, never
 * by stderr text.
 *
 * The reported symptom: reinstalling a Windows Computer printed a mojibake
 * `legacy_os_supervisor_cleanup_incomplete` for a scheduled task that did not
 * exist. Two layers caused it — output was force-decoded as utf8, and absence
 * was recognised by an English-only phrase — so on a localized console a MISSING
 * task and a REAL failure produced the same verdict.
 *
 * The control matrix below is the one frozen with @Jianwei and @XX on task #777.
 * Only the main defect is a pre-fix product RED; the safe failures were already
 * correct before this change and must stay green, turning red only under the
 * specific bad mutation named against each. Requiring healthy old behaviour to
 * fail would mean breaking the subject to make a tooth red — a manufactured
 * oracle, not evidence.
 *
 * Measured mutation coverage — every control below was OBSERVED red under at
 * least one mutation and green again on restore. The mapping is what the runs
 * actually showed, not what was predicted: the string-code and timeout controls
 * are guarded by the TYPE gate, so "all nonzero is absent" does not reach them;
 * they redden under "classifier always says absent" and "a string code is
 * coerced to the missing code" instead. Each tooth name carries its own mutation.
 *
 * Probe evidence behind the exact code (PR #6186, closed; head 28e8e5d04, job
 * 93082368873): a grant-withdrawal A→B→A on a probe-owned task showed a
 * caller-denied read returning 0x80070005 while a missing task returns
 * 0x80070002. Universal exclusivity is NOT claimed — safety comes from the exact
 * allowlist below, which admits one code and lets everything else stay
 * `incomplete`.
 */

const MISSING = 0x80070002; // HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
const ACCESS_DENIED = 0x80070005; // HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED)

/** A localized (zh-CN) "cannot find the file" — deliberately matches no English regex. */
const LOCALIZED_MISSING = "错误: 系统找不到指定的文件。";

function windowsSpec(slockHome = "C:\\Users\\Me\\.slock") {
  return buildOsSupervisorSpec({
    platform: "win32",
    slockHome,
    binaryPath: "C:\\Users\\Me\\bin\\raft-computer.exe",
    userHome: "C:\\Users\\Me",
    uid: null,
    windowsUserId: "S-1-5-21-1",
  });
}

/**
 * A Windows host whose `/Query` fails with a chosen error once the task is gone.
 * `failure` is thrown verbatim, so each tooth controls exactly one variable.
 */
function windowsHost(failure: unknown, spec: ReturnType<typeof windowsSpec>) {
  const calls: string[] = [];
  let present = true;
  const runCommand: SupervisorCommandRunner = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "schtasks.exe" && args[0] === "/Delete") {
      present = false;
      return { stdout: "", stderr: "" };
    }
    if (command === "schtasks.exe" && args[0] === "/Query") {
      if (!present) throw failure;
      // Must be the spec's OWN definition: an unrecognized one is classified
      // foreign and left untouched, which would never reach the absence logic
      // these teeth exist to exercise.
      return { stdout: spec.definition, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { runCommand, calls };
}

async function retireWith(failure: unknown) {
  const root = await mkdtemp(join(tmpdir(), "raft-win-absence-"));
  // The spec id is derived from slockHome, so the host must answer with the
  // definition for THIS root — otherwise the task reads as foreign and the flow
  // never reaches the absence classification under test.
  const host = windowsHost(failure, windowsSpec(root));
  const result = await retireLegacyOsSupervisor(
    root,
    "C:\\Users\\Me\\bin\\raft-computer.exe",
    {
      platform: "win32",
      userHome: "C:\\Users\\Me",
      windowsUserId: "S-1-5-21-1",
      runCommand: host.runCommand,
    },
  );
  return { result, calls: host.calls };
}

const codeErr = (message: string, code: unknown) =>
  Object.assign(new Error(message), { code });

// ---------------------------------------------------------------------------
// PRE-FIX PRODUCT RED — the one tooth that failed against the old implementation
// ---------------------------------------------------------------------------

test("a localized missing task reports retired, not cleanup-incomplete", async () => {
  // The defect verbatim: exit code says the task is gone, the message is not
  // English. The old text predicate did not match, so this returned
  // `incomplete` and the user saw a mojibake failure for a task that was
  // already absent. This is the only tooth that was RED before the fix.
  const { result } = await retireWith(codeErr(LOCALIZED_MISSING, MISSING));
  assert.equal(result.status, "retired");
  assert.doesNotMatch(
    result.message,
    /incomplete/,
    "a task that does not exist is not an incomplete cleanup",
  );
});

test("the user note carries no raw child text, in any locale", async () => {
  // The mojibake reached the user because the child's message was pasted into
  // the note. A stage plus a typed code keeps a real failure diagnosable
  // without embedding bytes we cannot decode.
  const { result } = await retireWith(codeErr(LOCALIZED_MISSING, ACCESS_DENIED));
  assert.equal(result.status, "incomplete");
  assert.doesNotMatch(result.message, /错误|系统找不到/, "localized child text must not reach the user");
  assert.match(result.message, /code=0x80070005/, "the typed code must survive for diagnosis");
  assert.match(result.message, /stage=/, "the failing stage must survive for diagnosis");
});

// ---------------------------------------------------------------------------
// SAFETY NEGATIVE CONTROLS — already correct before this change; must stay green.
// Each names the mutation that must turn it red.
// ---------------------------------------------------------------------------

test("access-denied stays incomplete [red under: all-nonzero treated as absent]", async () => {
  // The failure this whole design exists to protect: a task we may not READ must
  // never be reported as a task that is not there.
  const { result } = await retireWith(codeErr("Access is denied.", ACCESS_DENIED));
  assert.equal(result.status, "incomplete");
});

test("a string code stays incomplete [red under: classifier-always-absent; string coerced to the missing code]", async () => {
  // schtasks.exe itself missing. "We could not run it" must not normalize into
  // "the task is not there".
  const { result } = await retireWith(codeErr("spawn schtasks.exe ENOENT", "ENOENT"));
  assert.equal(result.status, "incomplete");
});

test("a timeout with no code stays incomplete [red under: classifier-always-absent]", async () => {
  const { result } = await retireWith(codeErr("timed out after 5000ms", undefined));
  assert.equal(result.status, "incomplete");
});

test("an unparseable non-Error rejection stays incomplete [red under: classifier-always-absent]", async () => {
  const { result } = await retireWith("not an error object");
  assert.equal(result.status, "incomplete");
});

// ---------------------------------------------------------------------------
// TYPED CONTROLS — red under: string/NaN/Infinity also normalized
// ---------------------------------------------------------------------------

test("only a finite numeric code can mean absence", () => {
  assert.equal(isWindowsTaskMissingExitCode(codeErr("x", MISSING)), true);
  // The same 32 bits spelled signed — a real int32 exit code.
  assert.equal(isWindowsTaskMissingExitCode(codeErr("x", MISSING | 0)), true);

  for (const bad of ["0x80070002", String(MISSING), NaN, Infinity, -Infinity, null, undefined, 1.5]) {
    assert.equal(
      isWindowsTaskMissingExitCode(codeErr("x", bad)),
      false,
      `${String(bad)} must not be read as the missing code`,
    );
  }
  assert.equal(supervisorExitCode(codeErr("x", "ENOENT")), null, "a string code is not a number");
});

test("out-of-domain aliases of the missing code are rejected [red under: modulo-2**32 comparison]", () => {
  // ⚠️ The cell whose ABSENCE let a real defect ship (found by @Jianwei on task
  // #780). The gate was `(code >>> 0) === MISSING`, and ToUint32 is modulo 2**32,
  // so it admitted an entire residue class rather than one value: 0x80070002
  // plus or minus any multiple of 2**32 wrapped onto the missing code and was
  // classified absent. The 12 teeth stayed green because none of them supplied an
  // integer outside the 32-bit domain — the contract said "exactly one HRESULT"
  // while the code enforced "one residue class", and nothing could tell them apart.
  const MISSING_SIGNED = MISSING | 0; // -2147024894, the same 32 bits
  assert.equal(isWindowsTaskMissingExitCode(codeErr("x", MISSING)), true, "exact unsigned is missing");
  assert.equal(isWindowsTaskMissingExitCode(codeErr("x", MISSING_SIGNED)), true, "exact signed int32 is missing");

  for (const alias of [
    MISSING + 2 ** 32, // 6442909698  — high alias
    MISSING + 2 * 2 ** 32, // 10737876994
    MISSING - 2 * 2 ** 32, // -6441992190 — low alias, beyond the legitimate signed spelling
    MISSING_SIGNED - 2 ** 32,
  ]) {
    assert.equal(
      isWindowsTaskMissingExitCode(codeErr("x", alias)),
      false,
      `${alias} is not the missing code; only its two exact 32-bit spellings are`,
    );
    assert.ok(Number.isSafeInteger(alias), "the alias must be a safe integer, or the type gate would mask this");
  }
});

test("no neighbouring code is admitted", () => {
  for (const near of [ACCESS_DENIED, 0x80070001, 0x80070003, 1, 0, 2147942403]) {
    assert.equal(
      isWindowsTaskMissingExitCode(codeErr("x", near)),
      false,
      `0x${(near >>> 0).toString(16)} is not the missing code`,
    );
  }
});

test("failure detail names a code it could not read, rather than inventing one", () => {
  assert.match(supervisorFailureDetail(codeErr("boom", "ENOENT")), /code=ENOENT/);
  assert.match(supervisorFailureDetail(codeErr("boom", undefined)), /code=none/);
});

// ---------------------------------------------------------------------------
// PATH INVENTORY — red under: /HRESULT omitted from any exact existence query
// ---------------------------------------------------------------------------

test("every exact Windows existence query carries /HRESULT", () => {
  // There are two INDEPENDENT call paths that decide whether the task is gone:
  // readRetirementDefinition's direct query, and this status plan executed by
  // proveRetiredManagerAbsent. Fixing one and leaving the other would leave a
  // second, identically broken oracle behind — so this enumerates the plan
  // rather than trusting that both were remembered.
  const spec = windowsSpec();
  for (const action of ["status", "stop"] as const) {
    const plan = buildSupervisorCommandPlan(spec, action, { uid: null });
    for (const step of plan) {
      if (step.command !== "schtasks.exe") continue;
      if (step.args[0] !== "/Query") continue;
      assert.ok(
        step.args.includes("/HRESULT"),
        `${action} plan: an exact /Query without /HRESULT can only be classified by text: ${step.args.join(" ")}`,
      );
    }
  }
});

test("both independent existence queries ran, and each carried /HRESULT", async () => {
  // Jianwei's requirement: the inventory must hit EACH of the two queries
  // separately, so dropping the flag from either one goes red. Asserting only
  // "every query I saw had /HRESULT" would still pass if one whole path
  // vanished — the surviving path would satisfy it alone.
  //
  // The two paths issue an identical argv, so they are told apart by position
  // around the delete: readRetirementDefinition queries BEFORE it, and the
  // post-delete readback in proveRetiredManagerAbsent queries AFTER it.
  const { calls } = await retireWith(codeErr(LOCALIZED_MISSING, MISSING));
  const deleteAt = calls.findIndex((c) => c.startsWith("schtasks.exe /Delete"));
  assert.ok(deleteAt >= 0, "the flow must actually delete the task");

  const isQuery = (c: string) => c.startsWith("schtasks.exe /Query");
  const before = calls.slice(0, deleteAt).filter(isQuery);
  const after = calls.slice(deleteAt + 1).filter(isQuery);

  assert.ok(before.length > 0, "readRetirementDefinition's own query must run before the delete");
  assert.ok(after.length > 0, "the post-delete absence readback must run after the delete");
  for (const q of [...before, ...after]) {
    assert.match(q, /\/HRESULT/, `an exact existence query without /HRESULT: ${q}`);
  }
});

// ---------------------------------------------------------------------------
// CLEANUP REGRESSION — owned-task cleanup must not regress
// ---------------------------------------------------------------------------

test("owned task cleanup still disables, ends, deletes, and records removal", async () => {
  const { result, calls } = await retireWith(codeErr(LOCALIZED_MISSING, MISSING));
  assert.equal(result.status, "retired");
  assert.ok(calls.some((c) => c.includes("/Change") && c.includes("/DISABLE")));
  assert.ok(calls.some((c) => c.includes("/End")));
  assert.ok(calls.some((c) => c.includes("/Delete")));
  assert.match(await readFile(result.receiptPath, "utf8"), /"definitionRemoved": true/);
});
