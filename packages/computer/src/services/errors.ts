// Computer domain service error envelope (Hao msg=51a17400 + liuliu msg=7a1a2c3d).
// `code` is the §6/§11 closed-set token; `message` is the user-actionable text;
// `cause` is the underlying transport/IO error retained for in-process diagnosis
// only and MUST NOT be forwarded across IPC or CLI fail() — both adapters strip
// it by reading `code` + `message` only.
export class ComputerServiceError extends Error {
  readonly code: string;
  readonly cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "ComputerServiceError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
