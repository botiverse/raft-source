let optimisticMessageSequence = 0;

export interface OptimisticMessageDraftOptions {
  nowMs?: number;
  randomToken?: string;
}

export interface OptimisticMessageDraft {
  id: string;
  randomId: string;
  createdAt: string;
}

function nextOptimisticSequence(): number {
  optimisticMessageSequence = (optimisticMessageSequence + 1) % Number.MAX_SAFE_INTEGER;
  if (optimisticMessageSequence === 0) optimisticMessageSequence = 1;
  return optimisticMessageSequence;
}

export function buildOptimisticMessageId(nowMs: number, sequence: number, randomToken: string): string {
  return `optimistic-${nowMs}-${String(sequence).padStart(6, "0")}-${randomToken}`;
}

export function createOptimisticMessageDraft(options: OptimisticMessageDraftOptions = {}): OptimisticMessageDraft {
  const nowMs = options.nowMs ?? Date.now();
  const randomToken = options.randomToken ?? Math.random().toString(36).slice(2);
  const sequence = nextOptimisticSequence();
  return {
    id: buildOptimisticMessageId(nowMs, sequence, randomToken),
    randomId: `msg-${nowMs}-${String(sequence).padStart(6, "0")}-${randomToken}`,
    createdAt: new Date(nowMs).toISOString(),
  };
}
