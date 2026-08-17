// Evidence capture via native Playwright/CDP APIs. Deliberately not a port of
// any browser-extension capture approach (MAIN-world script injection,
// html2canvas) — those exist only to work around an extension's lack of CDP
// access to its own tab. A real Playwright session has direct, better access:
// page.on('console'/'request'/'response'), page.screenshot(),
// page.accessibility.snapshot().

import type { Page } from 'playwright';

export interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  timestamp: number;
}

export interface StepEvidence {
  stepIndex: number;
  action: string;
  screenshotPng: Buffer;
  accessibilitySnapshot: string;
  consoleDeltas: ConsoleEntry[];
  networkDeltas: NetworkEntry[];
  blocked?: { reason: string };
}

export const DEFAULT_RING_BUFFER_CAP = 500;

export class EvidenceCapture {
  private console: ConsoleEntry[] = [];
  private network: NetworkEntry[] = [];
  private steps: StepEvidence[] = [];
  private consoleCursor = 0;
  private networkCursor = 0;

  constructor(
    private readonly page: Page,
    private readonly ringBufferCap: number = DEFAULT_RING_BUFFER_CAP,
  ) {
    page.on('console', (msg) => {
      this.push(this.console, { type: msg.type(), text: msg.text(), timestamp: Date.now() });
    });
    page.on('requestfinished', async (req) => {
      const response = await req.response();
      this.push(this.network, {
        method: req.method(),
        url: req.url(),
        status: response?.status(),
        timestamp: Date.now(),
      });
    });
    page.on('requestfailed', (req) => {
      this.push(this.network, { method: req.method(), url: req.url(), timestamp: Date.now() });
    });
  }

  private push<T>(arr: T[], entry: T): void {
    arr.push(entry);
    if (arr.length > this.ringBufferCap) arr.shift();
  }

  /** Captures a step's evidence bundle: screenshot + a11y snapshot + deltas since the last step. */
  async captureStep(stepIndex: number, action: string, blocked?: { reason: string }): Promise<StepEvidence> {
    const screenshotPng = await this.page.screenshot({ type: 'png' });
    const accessibilitySnapshot = await this.page.ariaSnapshot({ mode: 'ai' });

    const consoleDeltas = this.console.slice(this.consoleCursor);
    const networkDeltas = this.network.slice(this.networkCursor);
    this.consoleCursor = this.console.length;
    this.networkCursor = this.network.length;

    const entry: StepEvidence = { stepIndex, action, screenshotPng, accessibilitySnapshot, consoleDeltas, networkDeltas, blocked };
    this.steps.push(entry);
    return entry;
  }

  async captureFinal(): Promise<Buffer> {
    return this.page.screenshot({ type: 'png' });
  }

  getSteps(): StepEvidence[] {
    return this.steps;
  }
}
