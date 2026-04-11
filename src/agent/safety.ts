/**
 * Base approval infrastructure for adaria-ai.
 *
 * M1 ships the pilot-ai ApprovalManager skeleton: a taskId → pending-promise
 * registry with a timeout fallback. The growth-agent domain gates
 * (`blog_publish`, `metadata_change`, `review_reply`, `sdk_request`) are
 * merged on top in M5 once the skills that produce them land.
 *
 * Pilot-ai's shell-oriented `classifySafety` / DANGEROUS_PATTERNS classifier
 * is intentionally dropped — adaria-ai has no shell tool, and its
 * approvals are always domain-tagged, never inferred from regex.
 */

export type ApprovalGate =
  | "blog_publish"
  | "metadata_change"
  | "review_reply"
  | "sdk_request";

export interface PendingApproval {
  taskId: string;
  action: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalManager {
  private pending = new Map<string, PendingApproval>();
  private shuttingDown = false;

  /**
   * Registers a pending approval and returns a Promise that resolves once
   * `handleResponse` is called with the same taskId, or resolves to `false`
   * when the timeout fires.
   *
   * Fails fast if a request for the same `taskId` is already pending — the
   * old behavior silently overwrote the Map entry, stranding the original
   * promise's resolver forever and leaving the first timer to evict the
   * new entry when it fired (M1 safety review HIGH).
   *
   * Also fails fast once `shutdown()` has been called, so M5 write-path
   * skills observe a clean rejection during daemon teardown rather than
   * hanging until their timeout.
   */
  requestApproval(
    taskId: string,
    action: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.shuttingDown) {
      return Promise.reject(
        new Error(
          `ApprovalManager is shutting down; refusing approval request for "${taskId}"`,
        ),
      );
    }
    if (this.pending.has(taskId)) {
      return Promise.reject(
        new Error(
          `Duplicate approval request for taskId "${taskId}"; a prior request is still pending`,
        ),
      );
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(taskId);
        resolve(false);
      }, timeoutMs);

      this.pending.set(taskId, { taskId, action, resolve, timer });
    });
  }

  /** Resolves the pending approval for `taskId`. Returns false if unknown. */
  handleResponse(taskId: string, approved: boolean): boolean {
    const entry = this.pending.get(taskId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(taskId);
    entry.resolve(approved);
    return true;
  }

  hasPending(taskId: string): boolean {
    return this.pending.has(taskId);
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  /** Cancels every pending approval (for clean daemon shutdown). */
  shutdown(): void {
    this.shuttingDown = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.pending.clear();
  }
}
