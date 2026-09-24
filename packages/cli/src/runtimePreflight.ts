export const supportedNodeMajor = 20;
export const recommendedNodeVersion = "24.15.0";
export const supportedNodeRange = `>=${supportedNodeMajor}`;

export type RuntimePreflightExit = (code?: number) => never;
export type RuntimePreflightStderr = {
  write(chunk: string): unknown;
};

export interface RuntimePreflightOptions {
  exit?: RuntimePreflightExit;
  stderr?: RuntimePreflightStderr;
  version?: string;
}

export function parseNodeMajor(version: string): number | null {
  const match = version.match(/^v?(\d+)\./);
  if (!match) return null;
  return Number.parseInt(match[1] ?? "", 10);
}

function writeUnsupportedRuntime(stderr: RuntimePreflightStderr, version: string): void {
  stderr.write(
    `Error: Node ${version} is unsupported; raft requires Node ${supportedNodeRange} before loading CLI runtime dependencies.\n`,
  );
  stderr.write("No network requests, credentials, or local state were touched.\n");
  stderr.write(`Next action: Install/activate Node ${recommendedNodeVersion} (the repository pin), then retry.\n`);
}

export function enforceSupportedNodeRuntime(options: RuntimePreflightOptions = {}): void {
  const version = options.version ?? process.version;
  const major = parseNodeMajor(version);
  if (major !== null && major >= supportedNodeMajor) return;

  const stderr = options.stderr ?? process.stderr;
  writeUnsupportedRuntime(stderr, version || "<unknown>");
  const exit = options.exit ?? process.exit;
  exit(1);
}
