import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUploadScreenshot } = vi.hoisted(() => ({ mockUploadScreenshot: vi.fn() }));
vi.mock('../appq/mcpClient.js', () => ({
  uploadScreenshot: (...args: unknown[]) => mockUploadScreenshot(...args),
}));

import { PlaywrightBrowserTools } from './browserTools.js';
import type { Page } from 'playwright';

function fakeLocator() {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
  };
}

function fakePage() {
  const locator = fakeLocator();
  const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
  const page = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      (handlers[event] ??= []).push(handler);
    }),
    goto: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    ariaSnapshot: vi.fn().mockResolvedValue('- generic [ref=e1]:\n  - textbox [ref=e2]'),
    locator: vi.fn().mockReturnValue(locator),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    screenshot: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3, 4])),
    getByText: vi.fn().mockReturnValue({ waitFor: vi.fn().mockResolvedValue(undefined) }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };
  return { page: page as unknown as Page, locator, handlers };
}

function fireConsole(handlers: ReturnType<typeof fakePage>['handlers'], type: string, text: string) {
  for (const h of handlers.console ?? []) h({ type: () => type, text: () => text });
}

function fireRequestFailed(handlers: ReturnType<typeof fakePage>['handlers'], method: string, url: string) {
  for (const h of handlers.requestfailed ?? []) h({ method: () => method, url: () => url });
}

describe('PlaywrightBrowserTools', () => {
  beforeEach(() => {
    mockUploadScreenshot.mockReset();
    mockUploadScreenshot.mockResolvedValue('upload-id-123');
  });

  it('browser_navigate calls page.goto and waits for domcontentloaded', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_navigate', { url: 'https://example.com' });
    expect(page.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'domcontentloaded' });
    expect(result.text).toBe('Navigated to https://example.com');
  });

  it('browser_navigate_back calls page.goBack', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_navigate_back', {});
    expect(page.goBack).toHaveBeenCalledWith({ waitUntil: 'domcontentloaded' });
  });

  it('browser_snapshot returns the raw text and tracks refs for later use', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_snapshot', {});
    expect(result.text).toContain('[ref=e1]');
    // Refs are only usable after this — implicitly proven by the click test below.
  });

  it('browser_snapshot reports "(empty page)" for a blank accessibility tree', async () => {
    const { page } = fakePage();
    (page.ariaSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue('');
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_snapshot', {});
    expect(result.text).toBe('(empty page)');
  });

  it('browser_click throws for a ref that was never seen in a snapshot', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await expect(tools.dispatch('browser_click', { ref: 'e99', label: 'Save' })).rejects.toThrow(/Unknown ref "e99"/);
  });

  it('browser_click succeeds for a ref that was seen in the last snapshot', async () => {
    const { page, locator } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {});
    const result = await tools.dispatch('browser_click', { ref: 'e2', label: 'Continue' });
    expect(locator.click).toHaveBeenCalled();
    expect(result.text).toBe('Clicked "Continue"');
  });

  it('browser_click is blocked by the destructive-action gate before ever touching the page', async () => {
    const { page, locator } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {});
    const result = await tools.dispatch('browser_click', { ref: 'e2', label: 'Delete account' });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/Blocked/);
    expect(locator.click).not.toHaveBeenCalled();
  });

  it('refs from an older snapshot are invalidated by a newer one', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {}); // sees e1, e2
    (page.ariaSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue('- generic [ref=f1]:');
    await tools.dispatch('browser_snapshot', {}); // sees only f1 now
    await expect(tools.dispatch('browser_click', { ref: 'e2', label: 'Continue' })).rejects.toThrow(/Unknown ref "e2"/);
  });

  it('browser_type fills the element and does not press Enter unless submit is set', async () => {
    const { page, locator } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {});
    await tools.dispatch('browser_type', { ref: 'e2', text: 'hello@example.com' });
    expect(locator.fill).toHaveBeenCalledWith('hello@example.com');
    expect(locator.press).not.toHaveBeenCalled();
  });

  it('browser_type presses Enter when submit is true', async () => {
    const { page, locator } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {});
    await tools.dispatch('browser_type', { ref: 'e2', text: 'search term', submit: true });
    expect(locator.press).toHaveBeenCalledWith('Enter');
  });

  it('browser_select_option selects the given value', async () => {
    const { page, locator } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {});
    const result = await tools.dispatch('browser_select_option', { ref: 'e2', value: 'Daily' });
    expect(locator.selectOption).toHaveBeenCalledWith('Daily');
    expect(result.text).toBe('Selected "Daily" in e2');
  });

  it('browser_press_key presses the given key on the keyboard, not a specific element', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_press_key', { key: 'Escape' });
    expect(page.keyboard.press).toHaveBeenCalledWith('Escape');
  });

  it('browser_take_screenshot uploads the PNG and returns the upload_id for pass-through', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_take_screenshot', {});
    expect(mockUploadScreenshot).toHaveBeenCalledWith(Buffer.from([1, 2, 3, 4]), 'autotest-step');
    expect(result.ok).toBe(true);
    expect(result.text).toContain('upload-id-123');
    expect(result.data).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('browser_take_screenshot degrades gracefully (still ok) when the upload fails', async () => {
    mockUploadScreenshot.mockRejectedValue(new Error('network down'));
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_take_screenshot', {});
    expect(result.ok).toBe(true); // non-fatal by design
    expect(result.text).toMatch(/staging it failed/);
    expect(result.text).not.toContain('screenshot_upload_id:');
  });

  it('browser_wait_for waits for text when given', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_wait_for', { text: 'Welcome' });
    expect(page.getByText).toHaveBeenCalledWith('Welcome');
    expect(result.text).toBe('Text "Welcome" appeared');
  });

  it('browser_wait_for waits a fixed duration when no text is given', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_wait_for', { millis: 2000 });
    expect(page.waitForTimeout).toHaveBeenCalledWith(2000);
  });

  it('browser_wait_for defaults to 1000ms when neither text nor millis is given', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_wait_for', {});
    expect(page.waitForTimeout).toHaveBeenCalledWith(1000);
  });

  it('returns an explicit error for an unrecognized tool name', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_teleport', {});
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/Unknown browser tool/);
  });

  it('browser_console_messages returns real console entries, not always []', async () => {
    const { page, handlers } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    fireConsole(handlers, 'error', 'a real page error');
    const result = await tools.dispatch('browser_console_messages', {});
    expect(JSON.parse(result.text)).toEqual([{ type: 'error', text: 'a real page error', timestamp: expect.any(Number) }]);
  });

  it('browser_console_messages returns [] when nothing was logged since the last check', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_console_messages', {});
    expect(result.text).toBe('[]');
  });

  it('browser_network_requests returns real network entries, not always []', async () => {
    const { page, handlers } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    fireRequestFailed(handlers, 'POST', 'https://example.com/checkout');
    const result = await tools.dispatch('browser_network_requests', {});
    expect(JSON.parse(result.text)).toEqual([
      { method: 'POST', url: 'https://example.com/checkout', status: undefined, timestamp: expect.any(Number) },
    ]);
  });

  it('browser_console_messages only returns entries since the previous call, not the full history', async () => {
    const { page, handlers } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    fireConsole(handlers, 'log', 'first');
    await tools.dispatch('browser_console_messages', {});
    fireConsole(handlers, 'log', 'second');
    const result = await tools.dispatch('browser_console_messages', {});
    expect(JSON.parse(result.text)).toEqual([{ type: 'log', text: 'second', timestamp: expect.any(Number) }]);
  });
});
