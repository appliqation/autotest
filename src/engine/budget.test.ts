import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BudgetTracker } from './budget.js';
import type { RunBudget } from '../types.js';

const budget: RunBudget = { maxCalls: 3, maxPages: 2, maxMillis: 10_000, maxTurns: 5 };

describe('BudgetTracker', () => {
  it('is not exceeded when nothing has been counted', () => {
    const tracker = new BudgetTracker(budget);
    expect(tracker.exceeded()).toBeNull();
  });

  it('reports exceeded once call count reaches the cap', () => {
    const tracker = new BudgetTracker(budget);
    tracker.countCall();
    tracker.countCall();
    expect(tracker.exceeded()).toBeNull(); // 2 < 3
    tracker.countCall();
    expect(tracker.exceeded()).toMatch(/3 tool calls \(cap 3\)/);
  });

  it('reports exceeded once page count reaches the cap', () => {
    const tracker = new BudgetTracker(budget);
    tracker.countPage();
    expect(tracker.exceeded()).toBeNull();
    tracker.countPage();
    expect(tracker.exceeded()).toMatch(/2 page navigations \(cap 2\)/);
  });

  it('checks calls before pages before elapsed time — call cap reported first when multiple are exceeded', () => {
    const tracker = new BudgetTracker(budget);
    tracker.countCall();
    tracker.countCall();
    tracker.countCall();
    tracker.countPage();
    tracker.countPage();
    expect(tracker.exceeded()).toMatch(/tool calls/);
  });

  describe('elapsed time cap', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('is not exceeded before maxMillis has elapsed', () => {
      const tracker = new BudgetTracker(budget);
      vi.advanceTimersByTime(9_000);
      expect(tracker.exceeded()).toBeNull();
    });

    it('reports exceeded once maxMillis has elapsed', () => {
      const tracker = new BudgetTracker(budget);
      vi.advanceTimersByTime(10_000);
      expect(tracker.exceeded()).toMatch(/10s elapsed \(cap 10s\)/);
    });
  });

  it('state() reports the current call/page counts and elapsed time', () => {
    const tracker = new BudgetTracker(budget);
    tracker.countCall();
    tracker.countPage();
    tracker.countPage();
    const state = tracker.state();
    expect(state.calls).toBe(1);
    expect(state.pages).toBe(2);
    expect(state.elapsedMillis).toBeGreaterThanOrEqual(0);
  });
});
