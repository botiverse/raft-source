import type { Request, Response } from "express";

export interface RequestAbortSignalBinding {
  signal: AbortSignal;
  cleanup(): void;
}

export function bindRequestAbortSignal(req: Request, res: Response): RequestAbortSignalBinding {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  const abortOnResponseClose = () => {
    if (!res.writableEnded) abort();
  };

  if (req.aborted || res.destroyed) {
    abort();
  }

  req.once("aborted", abort);
  res.once("close", abortOnResponseClose);

  return {
    signal: controller.signal,
    cleanup() {
      req.off("aborted", abort);
      res.off("close", abortOnResponseClose);
    },
  };
}
