import fs from "node:fs";
import path from "node:path";

import { cliError } from "../../core/errors.js";

export interface PreparedPrivateSecretSink {
  filePath: string;
  fd: number;
  dev: bigint;
  ino: bigint;
}

class PrivateSecretSinkPathChangedError extends Error {}

function closeIgnoringErrors(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // The caller reports the retained artifact; never risk pathname cleanup.
  }
}

function pathMatchesSink(sink: PreparedPrivateSecretSink): boolean {
  try {
    const current = fs.lstatSync(sink.filePath, { bigint: true });
    return current.dev === sink.dev && current.ino === sink.ino;
  } catch {
    return false;
  }
}

function assertSinkPathIdentity(sink: PreparedPrivateSecretSink): void {
  if (!pathMatchesSink(sink)) {
    throw new PrivateSecretSinkPathChangedError(
      `private secret sink path changed after creation: ${sink.filePath}`,
    );
  }
}

function enforcePrivateMode(fd: number, filePath: string): void {
  fs.fchmodSync(fd, 0o600);
  const mode = fs.fstatSync(fd).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`failed to enforce private mode 0600 for ${filePath}: got 0${mode.toString(8)}`);
  }
}

export function preparePrivateSecretSink(
  output: string | undefined,
  platform = process.platform,
): PreparedPrivateSecretSink {
  if (!output?.trim()) {
    throw cliError(
      "INVALID_ARG",
      "--output <new-private-path> is required; secret bytes are never written to CLI output",
    );
  }
  if (platform === "win32") {
    throw cliError(
      "LOCAL_WRITE_FAILED",
      "private app-secret file permissions are not supported on win32; use an authorized secret-store carrier",
      { faultDomain: "file_write:prepare" },
    );
  }

  const filePath = path.resolve(output);
  let fd: number | undefined;
  let sink: PreparedPrivateSecretSink | undefined;
  try {
    fd = fs.openSync(filePath, "wx", 0o600);
    const opened = fs.fstatSync(fd, { bigint: true });
    sink = { filePath, fd, dev: opened.dev, ino: opened.ino };
    enforcePrivateMode(fd, filePath);
    assertSinkPathIdentity(sink);
    return sink;
  } catch (error) {
    if (fd !== undefined) closeIgnoringErrors(fd);
    const retention = fd === undefined
      ? ""
      : "; an empty private artifact may remain, so inspect and remove it before retrying";
    throw cliError(
      "LOCAL_WRITE_FAILED",
      `could not prepare a new private secret sink at ${filePath}: ${error instanceof Error ? error.message : String(error)}${retention}`,
      { cause: error, faultDomain: "file_write:prepare" },
    );
  }
}

export function closePrivateSecretSink(sink: PreparedPrivateSecretSink): void {
  closeIgnoringErrors(sink.fd);
}

export function writePrivateSecretSink(
  sink: PreparedPrivateSecretSink,
  secret: string,
): void {
  try {
    fs.writeFileSync(sink.fd, secret, { encoding: "utf8" });
    fs.fsyncSync(sink.fd);
    enforcePrivateMode(sink.fd, sink.filePath);
    assertSinkPathIdentity(sink);
    fs.closeSync(sink.fd);
    assertSinkPathIdentity(sink);
  } catch (error) {
    const pathChanged = error instanceof PrivateSecretSinkPathChangedError;
    closeIgnoringErrors(sink.fd);
    throw cliError(
      "LOCAL_WRITE_FAILED",
      pathChanged
        ? `the app secret was rotated, but the agent-selected private sink path changed before commit; no pathname cleanup was attempted and a sensitive private artifact may remain`
        : `the app secret was rotated but the local write or commit failed; no pathname cleanup was attempted and a sensitive private artifact may remain at ${sink.filePath}`,
      { cause: error, faultDomain: "file_write:commit" },
    );
  }
}
