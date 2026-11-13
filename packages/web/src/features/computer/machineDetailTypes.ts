export type CommandCopyTarget =
  | "computer-install"
  | "computer-setup"
  | "computer-install-restart"
  | "terminal-status"
  | "terminal-doctor"
  | "terminal-restart";

export type BulkAgentAction = "start" | "stop" | "restart" | "session" | "full";
export type BulkResetMode = "restart" | "session" | "full";

export interface BulkResetOption {
  mode: BulkResetMode;
  label: string;
  desc: string;
  selectedClass: string;
}
