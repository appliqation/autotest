// Playwright-backed implementations of the browser_* tool palette. Tool names
// mirror Playwright MCP's own naming convention so any workflow prose written
// against that vocabulary (as appq's existing `runman` workflow is) transfers
// unchanged to this engine.

import type { Page } from 'playwright';
import type { LlmToolDef, ToolResult } from '../types.js';
import { EvidenceCapture } from '../evidence/capture.js';
import { classifyClick } from './safety.js';

export const BROWSER_TOOL_DEFS: LlmToolDef[] = [
  {
    name: 'browser_navigate',
    description: 'Navigate the page to a URL.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'browser_navigate_back',
    description: 'Go back to the previous page.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_snapshot',
    description:
      'Take an accessibility-tree snapshot of the current page. Returns a text tree with element refs ' +
      '(e1, e2, ...) to use with browser_click/browser_type/etc.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description:
      'Click an element by its ref from the last browser_snapshot. `label` must describe the control\'s ' +
      'visible text/purpose (e.g. "Delete account", "Pay now") — it is checked against a destructive-action ' +
      'gate before the click happens.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, label: { type: 'string' } },
      required: ['ref', 'label'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an element by its ref from the last browser_snapshot.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_select_option',
    description: 'Select an option in a <select> element by its ref.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, value: { type: 'string' } },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a keyboard key (e.g. "Enter", "Escape").',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'browser_take_screenshot',
    description: 'Take a screenshot of the current viewport.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_console_messages',
    description: 'Return console messages logged since the last check.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_network_requests',
    description: 'Return network requests observed since the last check.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for a duration in milliseconds, or for text to appear on the page.',
    inputSchema: {
      type: 'object',
      properties: { millis: { type: 'number' }, text: { type: 'string' } },
    },
  },
];

/** Wraps a live Playwright Page as a browser_* tool dispatcher, tracking evidence as it goes. */
export class PlaywrightBrowserTools {
  // Refs come from page.ariaSnapshot({mode:'ai'}), which embeds [ref=eN]
  // markers directly in its output — no manual tree-walking needed. A ref
  // resolves back to a live element via the 'aria-ref=' selector engine.
  private knownRefs = new Set<string>();
  readonly evidence: EvidenceCapture;

  constructor(private readonly page: Page) {
    this.evidence = new EvidenceCapture(page);
  }

  private locatorFor(ref: string) {
    if (!this.knownRefs.has(ref)) throw new Error(`Unknown ref "${ref}" — call browser_snapshot first`);
    return this.page.locator(`aria-ref=${ref}`);
  }

  async dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'browser_navigate': {
        await this.page.goto(String(args.url), { waitUntil: 'domcontentloaded' });
        return { ok: true, text: `Navigated to ${args.url}` };
      }
      case 'browser_navigate_back': {
        await this.page.goBack({ waitUntil: 'domcontentloaded' });
        return { ok: true, text: 'Navigated back' };
      }
      case 'browser_snapshot': {
        const text = await this.page.ariaSnapshot({ mode: 'ai' });
        this.knownRefs = new Set([...text.matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]));
        return { ok: true, text: text || '(empty page)' };
      }
      case 'browser_click': {
        const ref = String(args.ref);
        // label is required (not derived from the ref) so the destructive-action
        // gate has something to check before the click ever dispatches.
        const label = String(args.label ?? '');
        const blocked = classifyClick({ label, tag: 'button' });
        if (blocked) return blocked;
        await this.locatorFor(ref).click();
        return { ok: true, text: `Clicked "${label || ref}"` };
      }
      case 'browser_type': {
        const ref = String(args.ref);
        await this.locatorFor(ref).fill(String(args.text));
        if (args.submit) await this.locatorFor(ref).press('Enter');
        return { ok: true, text: `Typed into ${ref}` };
      }
      case 'browser_select_option': {
        const ref = String(args.ref);
        await this.locatorFor(ref).selectOption(String(args.value));
        return { ok: true, text: `Selected "${args.value}" in ${ref}` };
      }
      case 'browser_press_key': {
        await this.page.keyboard.press(String(args.key));
        return { ok: true, text: `Pressed ${args.key}` };
      }
      case 'browser_take_screenshot': {
        const png = await this.page.screenshot({ type: 'png' });
        return { ok: true, text: `Captured screenshot (${png.length} bytes)`, data: png };
      }
      case 'browser_console_messages': {
        const steps = this.evidence.getSteps();
        const last = steps[steps.length - 1];
        return { ok: true, text: JSON.stringify(last?.consoleDeltas ?? []) };
      }
      case 'browser_network_requests': {
        const steps = this.evidence.getSteps();
        const last = steps[steps.length - 1];
        return { ok: true, text: JSON.stringify(last?.networkDeltas ?? []) };
      }
      case 'browser_wait_for': {
        if (args.text) {
          await this.page.getByText(String(args.text)).waitFor({ timeout: 15000 });
          return { ok: true, text: `Text "${args.text}" appeared` };
        }
        await this.page.waitForTimeout(Number(args.millis ?? 1000));
        return { ok: true, text: 'Waited' };
      }
      default:
        return { ok: false, text: `Unknown browser tool "${name}"` };
    }
  }
}
