import { EventBuffer, type EventBufferDrainReceipt } from "./core.js";

type DrainSignal = "SIGTERM" | "SIGINT";

export interface EventBufferSignalProcess {
  once(signal: DrainSignal, listener: () => void): unknown;
  removeListener(signal: DrainSignal, listener: () => void): unknown;
  exit(code: number): never | void;
}

export interface EventBufferSignalDrainOptions {
  process?: EventBufferSignalProcess;
  timeoutMs: number;
  onReceipt?: (receipt: EventBufferDrainReceipt & { signal: DrainSignal }) => void;
}

export function installEventBufferSignalDrain(
  buffer: EventBuffer,
  options: EventBufferSignalDrainOptions,
): () => void {
  const processLike = options.process ?? process;
  let draining = false;
  const handlers = new Map<DrainSignal, () => void>();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const handler = () => {
      if (draining) return;
      draining = true;
      void buffer.drain(options.timeoutMs).then((receipt) => {
        options.onReceipt?.({ ...receipt, signal });
        processLike.exit(receipt.state === "drained" ? 0 : 1);
      });
    };
    handlers.set(signal, handler);
    processLike.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) processLike.removeListener(signal, handler);
  };
}
