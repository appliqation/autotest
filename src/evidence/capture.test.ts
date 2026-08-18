import { describe, it, expect, vi } from 'vitest';
import { EvidenceCapture, DEFAULT_RING_BUFFER_CAP } from './capture.js';
import type { Page } from 'playwright';

function fakePage() {
  const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
  const page = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      (handlers[event] ??= []).push(handler);
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
    ariaSnapshot: vi.fn().mockResolvedValue('- generic [ref=e1]:'),
  };
  return { page: page as unknown as Page, handlers };
}

function fireConsole(handlers: ReturnType<typeof fakePage>['handlers'], type: string, text: string) {
  for (const h of handlers.console ?? []) h({ type: () => type, text: () => text });
}

function fireRequestFinished(handlers: ReturnType<typeof fakePage>['handlers'], method: string, url: string, status: number) {
  for (const h of handlers.requestfinished ?? []) {
    h({ method: () => method, url: () => url, response: async () => ({ status: () => status }) });
  }
}

function fireRequestFailed(handlers: ReturnType<typeof fakePage>['handlers'], method: string, url: string) {
  for (const h of handlers.requestfailed ?? []) h({ method: () => method, url: () => url });
}

describe('EvidenceCapture', () => {
  it('registers console/requestfinished/requestfailed listeners on construction', () => {
    const { page } = fakePage();
    new EvidenceCapture(page);
    expect((page.on as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      'console',
      'requestfinished',
      'requestfailed',
    ]);
  });

  it('captureStep bundles a screenshot, accessibility snapshot, and deltas since the last step', async () => {
    const { page, handlers } = fakePage();
    const capture = new EvidenceCapture(page);
    fireConsole(handlers, 'log', 'page loaded');
    await new Promise((r) => setTimeout(r, 0)); // let the async requestfinished handler settle if any were fired

    const step = await capture.captureStep(0, 'navigate');

    expect(step.screenshotPng).toEqual(Buffer.from([1, 2, 3]));
    expect(step.accessibilitySnapshot).toBe('- generic [ref=e1]:');
    expect(step.consoleDeltas).toEqual([{ type: 'log', text: 'page loaded', timestamp: expect.any(Number) }]);
    expect(step.stepIndex).toBe(0);
    expect(step.action).toBe('navigate');
  });

  it('a second captureStep only includes deltas since the previous one, not the full history', async () => {
    const { page, handlers } = fakePage();
    const capture = new EvidenceCapture(page);
    fireConsole(handlers, 'log', 'first message');
    await capture.captureStep(0, 'step 1');

    fireConsole(handlers, 'error', 'second message');
    const step2 = await capture.captureStep(1, 'step 2');

    expect(step2.consoleDeltas).toEqual([{ type: 'error', text: 'second message', timestamp: expect.any(Number) }]);
  });

  it('captures a successful network request with its status', async () => {
    const { page, handlers } = fakePage();
    const capture = new EvidenceCapture(page);
    fireRequestFinished(handlers, 'GET', 'https://example.com/api', 200);
    await new Promise((r) => setTimeout(r, 0));
    const step = await capture.captureStep(0, 'x');
    expect(step.networkDeltas).toEqual([{ method: 'GET', url: 'https://example.com/api', status: 200, timestamp: expect.any(Number) }]);
  });

  it('captures a failed network request with no status', async () => {
    const { page, handlers } = fakePage();
    const capture = new EvidenceCapture(page);
    fireRequestFailed(handlers, 'POST', 'https://example.com/api');
    const step = await capture.captureStep(0, 'x');
    expect(step.networkDeltas).toEqual([{ method: 'POST', url: 'https://example.com/api', status: undefined, timestamp: expect.any(Number) }]);
  });

  it('records a blocked reason on the step when given', async () => {
    const { page } = fakePage();
    const capture = new EvidenceCapture(page);
    const step = await capture.captureStep(0, 'clicked delete', { reason: 'destructive action' });
    expect(step.blocked).toEqual({ reason: 'destructive action' });
  });

  it('getSteps returns every captured step in order', async () => {
    const { page } = fakePage();
    const capture = new EvidenceCapture(page);
    await capture.captureStep(0, 'first');
    await capture.captureStep(1, 'second');
    const steps = capture.getSteps();
    expect(steps.map((s) => s.action)).toEqual(['first', 'second']);
  });

  it('captureFinal returns a plain screenshot without touching the step list', async () => {
    const { page } = fakePage();
    const capture = new EvidenceCapture(page);
    const png = await capture.captureFinal();
    expect(png).toEqual(Buffer.from([1, 2, 3]));
    expect(capture.getSteps()).toEqual([]);
  });

  describe('getConsoleDeltas / getNetworkDeltas — direct read path for browser_console_messages/network_requests', () => {
    it('getConsoleDeltas returns real entries without needing captureStep to have run', () => {
      const { page, handlers } = fakePage();
      const capture = new EvidenceCapture(page);
      fireConsole(handlers, 'error', 'a real console error');
      expect(capture.getConsoleDeltas()).toEqual([{ type: 'error', text: 'a real console error', timestamp: expect.any(Number) }]);
    });

    it('getNetworkDeltas returns real entries without needing captureStep to have run', () => {
      const { page, handlers } = fakePage();
      const capture = new EvidenceCapture(page);
      fireRequestFailed(handlers, 'POST', 'https://example.com/checkout');
      expect(capture.getNetworkDeltas()).toEqual([{ method: 'POST', url: 'https://example.com/checkout', status: undefined, timestamp: expect.any(Number) }]);
    });

    it('a second call only returns what arrived since the first call, not the full history', () => {
      const { page, handlers } = fakePage();
      const capture = new EvidenceCapture(page);
      fireConsole(handlers, 'log', 'first');
      expect(capture.getConsoleDeltas()).toHaveLength(1);
      expect(capture.getConsoleDeltas()).toEqual([]); // nothing new since the last call
      fireConsole(handlers, 'log', 'second');
      expect(capture.getConsoleDeltas()).toEqual([{ type: 'log', text: 'second', timestamp: expect.any(Number) }]);
    });

    it('shares the same cursor as captureStep — a delta consumed by one is not double-counted by the other', async () => {
      const { page, handlers } = fakePage();
      const capture = new EvidenceCapture(page);
      fireConsole(handlers, 'log', 'seen once');
      const step = await capture.captureStep(0, 'x');
      expect(step.consoleDeltas).toHaveLength(1);
      expect(capture.getConsoleDeltas()).toEqual([]); // already consumed by captureStep
    });
  });

  it('the console ring buffer drops the oldest entries once the cap is exceeded', async () => {
    const { page, handlers } = fakePage();
    const capture = new EvidenceCapture(page, 3); // small cap for a fast test
    for (let i = 0; i < 5; i++) fireConsole(handlers, 'log', `message ${i}`);
    const step = await capture.captureStep(0, 'x');
    // Only the last 3 of 5 messages survive the ring buffer.
    expect(step.consoleDeltas.map((d) => d.text)).toEqual(['message 2', 'message 3', 'message 4']);
  });

  it('defaults the ring buffer cap when not specified', () => {
    const { page } = fakePage();
    const capture = new EvidenceCapture(page);
    expect(capture).toBeInstanceOf(EvidenceCapture);
    expect(DEFAULT_RING_BUFFER_CAP).toBe(500);
  });
});
