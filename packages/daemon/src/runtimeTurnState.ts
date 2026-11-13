/**
 * Tracks Codex app-server turn lifecycle state used for stdin steering.
 *
 * This is deliberately independent from event parsing. The normalizer decides
 * which raw event means "turn started", "progress", or "tool boundary"; this
 * helper owns only the derived state budget.
 */
export class RuntimeTurnState {
  private currentTurnId: string | null = null;
  private pendingTurnId: string | null = null;
  private turnInProgress = false;
  private currentTurnHadRuntimeActivity = false;
  private currentTurnHadTokenUsage = false;
  private currentTurnHadNonEmptyInput = false;
  private pendingNonEmptyInputTurnIds = new Set<string>();
  private completedTurnIds = new Set<string>();

  reset() {
    this.currentTurnId = null;
    this.pendingTurnId = null;
    this.turnInProgress = false;
    this.currentTurnHadRuntimeActivity = false;
    this.currentTurnHadTokenUsage = false;
    this.currentTurnHadNonEmptyInput = false;
    this.pendingNonEmptyInputTurnIds.clear();
    this.completedTurnIds.clear();
  }

  get activeTurnId(): string | null {
    return this.currentTurnId;
  }

  /** A turn started and has not ended. */
  get inProgress(): boolean {
    return this.turnInProgress;
  }

  /** A turn was accepted (awaiting its start) or is running. */
  get hasLiveTurn(): boolean {
    return this.turnInProgress || this.pendingTurnId !== null;
  }

  get canSteerBusy(): boolean {
    return Boolean(this.currentTurnId && !this.pendingTurnId);
  }

  markTurnStarted(turnId?: string | null) {
    const startedTurnId = turnId ?? this.pendingTurnId;
    if (startedTurnId) {
      this.currentTurnId = startedTurnId;
    }
    this.pendingTurnId = null;
    this.turnInProgress = true;
    this.currentTurnHadRuntimeActivity = false;
    this.currentTurnHadTokenUsage = false;
    this.currentTurnHadNonEmptyInput = startedTurnId ? this.pendingNonEmptyInputTurnIds.delete(startedTurnId) : false;
  }

  noteTurnAccepted(turnId: string) {
    this.pendingTurnId = turnId;
  }

  markProgress() {
    this.currentTurnHadRuntimeActivity = true;
  }

  /**
   * A tool ended. Runtime activity only: busy steering stays open. This used
   * to close steering until the next progress event (regression #238, a
   * May-2026 app-server wedge); Codex 0.155.1 took 207 steers in that window
   * without a wedge (#proj-runtime:15c1492a).
   */
  markToolBoundary() {
    this.currentTurnHadRuntimeActivity = true;
  }

  markTokenUsage() {
    this.currentTurnHadTokenUsage = true;
  }

  markNonEmptyInputForTurn(turnId: string | null | undefined) {
    if (!turnId || this.completedTurnIds.has(turnId)) return;
    if (this.turnInProgress && this.currentTurnId === turnId) {
      this.currentTurnHadNonEmptyInput = true;
    } else {
      this.pendingNonEmptyInputTurnIds.add(turnId);
    }
  }

  hasNonEmptyInputEvidence(): boolean {
    return this.currentTurnHadNonEmptyInput;
  }

  completedWithoutRuntimeActivity(): boolean {
    return this.turnInProgress && !this.currentTurnHadRuntimeActivity && !this.currentTurnHadTokenUsage;
  }

  markTurnCompleted() {
    if (this.currentTurnId) {
      this.completedTurnIds.add(this.currentTurnId);
      if (this.completedTurnIds.size > 16) {
        const oldest = this.completedTurnIds.values().next().value;
        if (oldest) this.completedTurnIds.delete(oldest);
      }
    }
    this.currentTurnId = null;
    this.pendingTurnId = null;
    this.turnInProgress = false;
    this.currentTurnHadRuntimeActivity = false;
    this.currentTurnHadTokenUsage = false;
    this.currentTurnHadNonEmptyInput = false;
  }
}
