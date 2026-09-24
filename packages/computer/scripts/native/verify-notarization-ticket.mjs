import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 15 * 1000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30 * 1000;
const REQUIREMENT_NOT_YET_SATISFIED =
  /code failed to satisfy specified code requirement\(s\)/iu;

export class NotarizationTicketError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "NotarizationTicketError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new NotarizationTicketError(code, message);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function assertAcceptedReceipt(binaryPath, receiptPath) {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch {
    fail("APPLE_NOTARY_RECEIPT_INVALID", "receipt is not valid JSON");
  }

  const binarySize = statSync(binaryPath).size;
  const binarySha256 = sha256File(binaryPath);
  if (
    receipt?.status !== "Accepted" ||
    receipt?.notary_issues !== 0 ||
    receipt?.ticket_delivery !== "online" ||
    receipt?.binary_file !== basename(binaryPath) ||
    receipt?.final_size_bytes !== binarySize ||
    receipt?.final_sha256 !== binarySha256
  ) {
    fail(
      "APPLE_NOTARY_RECEIPT_REJECTED",
      "receipt does not attest Accepted/zero-issue online delivery for the exact binary",
    );
  }
}

function diagnosticText(result) {
  return [result.stdout, result.stderr]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n")
    .trim();
}

function exitIdentity(result) {
  if (Number.isInteger(result.status)) return String(result.status);
  if (typeof result.signal === "string" && result.signal.length > 0) {
    return `signal:${result.signal}`;
  }
  if (typeof result.error?.code === "string" && result.error.code.length > 0) {
    return `error:${result.error.code}`;
  }
  return "unknown";
}

export function classifyCodesignResult(result) {
  if (result.status === 0) return "verified";
  if (result.error?.code === "ETIMEDOUT") return "retryable";
  if (REQUIREMENT_NOT_YET_SATISFIED.test(diagnosticText(result))) {
    return "retryable";
  }
  return "permanent";
}

function defaultRunCodesign(binaryPath, attemptTimeoutMs) {
  return spawnSync(
    "codesign",
    ["-vvvv", "-R=notarized", "--check-notarization", binaryPath],
    {
      encoding: "utf8",
      timeout: attemptTimeoutMs,
    },
  );
}

function defaultSleep(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

export async function verifyNotarizationTicket({
  binaryPath,
  receiptPath,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  runCodesign = defaultRunCodesign,
  now = () => performance.now(),
  sleep = defaultSleep,
  writeOut = (message) => process.stdout.write(message),
  writeErr = (message) => process.stderr.write(message),
}) {
  for (const [name, value] of [
    ["maxWaitMs", maxWaitMs],
    ["retryIntervalMs", retryIntervalMs],
    ["attemptTimeoutMs", attemptTimeoutMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail(
        "APPLE_NOTARY_VERIFIER_CONFIG_INVALID",
        `${name} must be a positive integer`,
      );
    }
  }

  assertAcceptedReceipt(binaryPath, receiptPath);
  const startedAt = now();
  let attempts = 0;

  while (true) {
    attempts += 1;
    const result = runCodesign(binaryPath, attemptTimeoutMs);
    const classification = classifyCodesignResult(result);
    const elapsedMs = Math.max(0, now() - startedAt);
    const diagnostic = diagnosticText(result);

    writeErr(
      `APPLE_NOTARY_TICKET_ATTEMPT attempt=${attempts} exit=${exitIdentity(result)} classification=${classification} elapsed_ms=${elapsedMs}\n`,
    );
    if (diagnostic.length > 0) writeErr(`${diagnostic}\n`);

    if (classification === "verified") {
      writeOut(
        `APPLE_NOTARY_TICKET_VERIFIED attempts=${attempts} elapsed_ms=${elapsedMs}\n`,
      );
      return { attempts, elapsedMs };
    }

    if (classification === "permanent") {
      fail(
        "APPLE_NOTARY_TICKET_PERMANENT_FAILURE",
        `codesign rejected the exact accepted binary on attempt ${attempts}${diagnostic.length === 0 ? " without a diagnostic" : ""}`,
      );
    }

    if (elapsedMs >= maxWaitMs) {
      fail(
        "APPLE_NOTARY_TICKET_TIMEOUT",
        `Accepted online ticket remained unavailable on this host after ${attempts} attempts and ${elapsedMs}ms`,
      );
    }

    const delayMs = Math.min(retryIntervalMs, maxWaitMs - elapsedMs);
    writeErr(
      `APPLE_NOTARY_TICKET_PENDING attempt=${attempts} elapsed_ms=${elapsedMs} retry_in_ms=${delayMs}\n`,
    );
    await sleep(delayMs);
  }
}

function parsePositiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/u.test(value ?? "")) {
    fail(
      "APPLE_NOTARY_VERIFIER_CONFIG_INVALID",
      `${name} must be a positive integer`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail(
      "APPLE_NOTARY_VERIFIER_CONFIG_INVALID",
      `${name} is outside the safe integer range`,
    );
  }
  return parsed;
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !name?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      fail("APPLE_NOTARY_VERIFIER_CONFIG_INVALID", "options require a value");
    }
    if (values.has(name)) {
      fail("APPLE_NOTARY_VERIFIER_CONFIG_INVALID", `duplicate option ${name}`);
    }
    values.set(name, value);
  }

  const allowed = new Set([
    "--binary",
    "--receipt",
    "--max-wait-ms",
    "--retry-interval-ms",
    "--attempt-timeout-ms",
  ]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) {
      fail("APPLE_NOTARY_VERIFIER_CONFIG_INVALID", `unknown option ${name}`);
    }
  }
  if (!values.get("--binary") || !values.get("--receipt")) {
    fail(
      "APPLE_NOTARY_VERIFIER_CONFIG_INVALID",
      "--binary and --receipt are required",
    );
  }

  return {
    binaryPath: resolve(values.get("--binary")),
    receiptPath: resolve(values.get("--receipt")),
    maxWaitMs: values.has("--max-wait-ms")
      ? parsePositiveInteger(values.get("--max-wait-ms"), "--max-wait-ms")
      : DEFAULT_MAX_WAIT_MS,
    retryIntervalMs: values.has("--retry-interval-ms")
      ? parsePositiveInteger(
          values.get("--retry-interval-ms"),
          "--retry-interval-ms",
        )
      : DEFAULT_RETRY_INTERVAL_MS,
    attemptTimeoutMs: values.has("--attempt-timeout-ms")
      ? parsePositiveInteger(
          values.get("--attempt-timeout-ms"),
          "--attempt-timeout-ms",
        )
      : DEFAULT_ATTEMPT_TIMEOUT_MS,
  };
}

async function main() {
  try {
    await verifyNotarizationTicket(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
