import type { RunBudget } from '../types.js';

export class BudgetTracker {
  private calls = 0;
  private pages = 0;
  private readonly startedAt = Date.now();

  constructor(private readonly budget: RunBudget) {}

  countCall(): void {
    this.calls += 1;
  }

  countPage(): void {
    this.pages += 1;
  }

  /** Returns a human-readable reason if a cap has been exceeded, else null. */
  exceeded(): string | null {
    if (this.calls >= this.budget.maxCalls) return `${this.calls} tool calls (cap ${this.budget.maxCalls})`;
    if (this.pages >= this.budget.maxPages) return `${this.pages} page navigations (cap ${this.budget.maxPages})`;
    const elapsed = Date.now() - this.startedAt;
    if (elapsed >= this.budget.maxMillis) {
      return `${Math.round(elapsed / 1000)}s elapsed (cap ${Math.round(this.budget.maxMillis / 1000)}s)`;
    }
    return null;
  }

  state() {
    return { calls: this.calls, pages: this.pages, elapsedMillis: Date.now() - this.startedAt };
  }
}
