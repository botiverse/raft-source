const MAX_STDOUT_LINES = 8;
const MAX_STDOUT_LINE_LENGTH = 240;
const MAX_STDERR_LINES = 8;
const MAX_STDERR_LINE_LENGTH = 240;

function pushRecentLines(
  lines: string[],
  chunk: string,
  maxLines: number,
  maxLineLength: number,
): string[] {
  const next = [...lines];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const text = rawLine.trim();
    if (!text) continue;
    next.push(
      text.length > maxLineLength
        ? `${text.slice(0, maxLineLength)}...`
        : text,
    );
  }
  return next.slice(-maxLines);
}

export function pushRecentStderr(lines: string[], chunk: string): string[] {
  return pushRecentLines(lines, chunk, MAX_STDERR_LINES, MAX_STDERR_LINE_LENGTH);
}

export function pushRecentStdout(lines: string[], chunk: string): string[] {
  return pushRecentLines(lines, chunk, MAX_STDOUT_LINES, MAX_STDOUT_LINE_LENGTH);
}

export class DecisionErrorWindow {
  private progressEpoch = 0;
  private stderrEpoch = 0;
  private stderrLines: string[] = [];
  private runtimeError: { epoch: number; message: string } | null = null;

  noteRuntimeProgress(): void {
    this.progressEpoch += 1;
  }

  recordStderr(text: string): void {
    const base = this.stderrEpoch === this.progressEpoch ? this.stderrLines : [];
    this.stderrLines = pushRecentStderr(base, text);
    this.stderrEpoch = this.progressEpoch;
  }

  recordRuntimeError(message: string): void {
    this.runtimeError = { epoch: this.progressEpoch, message };
  }

  currentStderrLines(): string[] {
    return this.stderrEpoch === this.progressEpoch ? this.stderrLines : [];
  }

  currentRuntimeError(): string | null {
    if (!this.runtimeError || this.runtimeError.epoch !== this.progressEpoch) return null;
    return this.runtimeError.message;
  }

  currentErrorCandidates(): string[] {
    return [
      this.currentRuntimeError(),
      ...this.currentStderrLines(),
    ].filter((value): value is string => !!value);
  }
}
