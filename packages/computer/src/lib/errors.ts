// Typed error for the ComputerApi (CLI-over-lib convergence).
//
// The lib API methods are PURE: they return a structured result OR throw a
// `ComputerError` carrying a closed-set `code` + actionable `message` (+ the
// process exit code the CLI should use). They do NOT write to stdout/stderr or
// call process.exit — that is the CLI presenter's job. This is what lets the
// CLI be a thin presentation layer over the lib (single source of truth):
//
//   - lib method:  pure logic → result | throw ComputerError
//   - CLI presenter: parse args → call api.method() → format result to stdout,
//                    or catch ComputerError → emit the human error contract
//                    to stderr + exit(code) (see output.ts)
//   - GUI/SDK:    consume the same api methods + catch ComputerError directly
//
// Migration note: existing handlers that call `fail(code, message)` inline are
// being converted to throw `ComputerError(code, message)` so their logic moves
// into pure api methods. The typed error source is unchanged; only WHERE
// presentation happens moves (lib throws; presenter emits).
export class ComputerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "ComputerError";
  }
}

export function isComputerError(err: unknown): err is ComputerError {
  return err instanceof ComputerError;
}
