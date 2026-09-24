/**
 * Explicit ready capability for the Computer-local fire-receipt protocol.
 * Version inference is only a temporary bridge for daemons released before
 * this receipt existed.
 */
export const REMINDER_FIRE_RECEIPT_CAPABILITY = "reminder:fire-receipt-v1" as const;

/**
 * The Computer asks the Server to authorize a due occurrence before creating
 * any user-visible Inbox item. Unlike v1 receipts, this protocol makes the
 * Server's clock and durable transition the only due authority.
 */
export const REMINDER_FIRE_REQUEST_CAPABILITY = "reminder:fire-request-v2" as const;

export type ComputerBoundDueReceiptMessage =
  | {
      type: "reminder.fire_receipt.ack";
      agentId: string;
      reminderId: string;
      version: number;
    }
  | {
      type: "reminder.fire_request.result";
      agentId: string;
      reminderId: string;
      version: number;
      requestId: string;
      outcome: "accepted";
      fired: boolean;
      catchup: boolean;
    }
  | {
      type: "reminder.fire_request.result";
      agentId: string;
      reminderId: string;
      version: number;
      requestId: string;
      outcome: "premature";
      reason: "premature_fire";
      serverNow: string;
      dueAt: string;
      retryAfterMs: number;
    }
  | {
      type: "reminder.fire_request.result";
      agentId: string;
      reminderId: string;
      version: number;
      requestId: string;
      outcome: "obsolete";
      reason: "not_scheduled" | "version_mismatch" | "owner_mismatch" | "server_mismatch_or_missing";
    };

export type ServerBoundDueReceiptMessage =
  | {
      type: "reminder.armed";
      agentId: string;
      reminderId: string;
      version: number;
      armedAtClient: string;
    }
  | {
      type: "reminder.fire_receipt";
      agentId: string;
      reminderId: string;
      version: number;
      firedAtClient: string;
      catchup: boolean;
    }
  | {
      type: "reminder.fire_request";
      agentId: string;
      reminderId: string;
      version: number;
      requestId: string;
      firedAtClient: string;
    }
  | {
      /** Transitional frame emitted by daemon 1.0.14 and 1.0.15. */
      type: "reminder.fire_attempt";
      agentId: string;
      reminderId: string;
      version: number;
      firedAtClient: string;
    }
  | {
      type: "reminder.arm_rejected";
      agentId: string;
      reminderId: string;
      version: number;
      reason: "invalid_fire_at";
    };
