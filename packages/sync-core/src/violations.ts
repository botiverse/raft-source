import type { SyncViolationBuffer, SyncViolationDrain, SyncViolationRecord } from "./types.js";

export interface SyncViolationBufferOptions {
  capacity?: number;
  onViolation?: (record: SyncViolationRecord) => void;
}

const DEFAULT_VIOLATION_BUFFER_CAPACITY = 128;

export function createSyncViolationBuffer(options: SyncViolationBufferOptions = {}): SyncViolationBuffer {
  const capacity = options.capacity ?? DEFAULT_VIOLATION_BUFFER_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError("SyncViolationBuffer capacity must be a positive safe integer");
  }

  const records: SyncViolationRecord[] = [];
  let nextIndex = 0;
  let onViolation = options.onViolation;

  return {
    get capacity() {
      return capacity;
    },
    get onViolation() {
      return onViolation;
    },
    set onViolation(callback) {
      onViolation = callback;
    },
    push(record) {
      const indexedRecord: SyncViolationRecord = { ...record, index: nextIndex };
      nextIndex += 1;

      records.push(indexedRecord);
      if (records.length > capacity) {
        records.shift();
      }

      onViolation?.(indexedRecord);
      return indexedRecord;
    },
    drain(sinceIndex): SyncViolationDrain {
      const oldestRetainedIndex = nextIndex - records.length;
      const requestedSinceIndex = sinceIndex ?? oldestRetainedIndex;
      if (!Number.isSafeInteger(requestedSinceIndex) || requestedSinceIndex < 0) {
        throw new RangeError("SyncViolationBuffer drain sinceIndex must be a non-negative safe integer");
      }

      const firstAvailableIndex = Math.max(requestedSinceIndex, oldestRetainedIndex);
      return {
        records: records.filter((record) => record.index >= firstAvailableIndex),
        droppedCount: Math.max(0, oldestRetainedIndex - requestedSinceIndex),
        nextIndex,
      };
    },
  };
}
