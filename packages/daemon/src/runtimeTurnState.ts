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
  /**
   * Post-tool window where the app-server may not yet accept stdin steering.
   * Gate busy-mode delivery until turn/completed or next progress.
   */
  private steeringGateActive = false;

  reset() {
    this.currentTurnId = null;
    this.pendingTurnId = null;
    this.turnInProgress = false;
    this.currentTurnHadRuntimeActivity = false;
    this.currentTurnHadTokenUsage = false;
    this.currentTurnHadNonEmptyInput = false;
    this.pendingNonEmptyInputTurnIds.clear();
    this.completedTurnIds.clear();
    this.steeringGateActive = false;
  }

  get activeTurnId(): string | null {
    return this.currentTurnId;
  }

  get canSteerBusy(): boolean {
    return Boolean(this.currentTurnId && !this.pendingTurnId && !this.steeringGateActive);
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
    this.steeringGateActive = false;
  }

  noteTurnAccepted(turnId: string) {
    this.pendingTurnId = turnId;
  }

  markProgress() {
    this.currentTurnHadRuntimeActivity = true;
    this.steeringGateActive = false;
  }

  markToolBoundary() {
    this.currentTurnHadRuntimeActivity = true;
    this.steeringGateActive = true;
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
    this.steeringGateActive = false;
  }
}
