import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScreenshotViewer, VIEW_SCREENSHOT_TOOL } from './screenshotViewer.js';
import type { ToolResult } from '@appliqation/agent-core';

function fakeFetchResponse(ok: boolean, status = 200, body = new Uint8Array([1, 2, 3]).buffer) {
  return {
    ok,
    status,
    headers: new Map([['content-type', 'image/png']]),
    arrayBuffer: async () => body,
  } as unknown as Response;
}

describe('ScreenshotViewer.toolDefs', () => {
  it('offers view_screenshot in on-demand mode', () => {
    const viewer = new ScreenshotViewer(false);
    expect(viewer.toolDefs()).toEqual([VIEW_SCREENSHOT_TOOL]);
  });

  it('offers nothing in mandatory mode — there is nothing to ask for', () => {
    const viewer = new ScreenshotViewer(true);
    expect(viewer.toolDefs()).toEqual([]);
  });
});

describe('ScreenshotViewer.wrapDispatch — on-demand mode', () => {
  let viewer: ScreenshotViewer;
  const evidenceResult: ToolResult = {
    ok: true,
    text: JSON.stringify({ steps: [{ step_index: 0, screenshot_url: 'https://example.com/step0.png' }] }),
  };

  beforeEach(() => {
    viewer = new ScreenshotViewer(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeFetchResponse(true)));
  });

  it('passes through calls other than get_execution_evidence/view_screenshot unchanged', async () => {
    const inner = vi.fn().mockResolvedValue({ ok: true, text: 'scenario text' });
    const dispatch = viewer.wrapDispatch(inner);
    const result = await dispatch('get_scenario', { scenario_id: 1 });
    expect(inner).toHaveBeenCalledWith('get_scenario', { scenario_id: 1 });
    expect(result.text).toBe('scenario text');
  });

  it('does not attach images to get_execution_evidence in on-demand mode', async () => {
    const inner = vi.fn().mockResolvedValue(evidenceResult);
    const dispatch = viewer.wrapDispatch(inner);
    const result = await dispatch('get_execution_evidence', {});
    expect(result.images).toBeUndefined();
    expect(result.text).toBe(evidenceResult.text);
  });

  it('view_screenshot fails with a clear message before any evidence has been loaded', async () => {
    const inner = vi.fn();
    const dispatch = viewer.wrapDispatch(inner);
    const result = await dispatch('view_screenshot', { step_index: 0 });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/call get_execution_evidence first/);
  });

  it('view_screenshot succeeds once the step URL has been cached by a prior evidence fetch', async () => {
    const inner = vi.fn().mockResolvedValue(evidenceResult);
    const dispatch = viewer.wrapDispatch(inner);
    await dispatch('get_execution_evidence', {}); // caches step 0's URL
    const result = await dispatch('view_screenshot', { step_index: 0 });
    expect(result.ok).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(result.images![0].label).toBe('step 0 screenshot');
  });

  it('view_screenshot for an unknown step index fails even after other steps were cached', async () => {
    const inner = vi.fn().mockResolvedValue(evidenceResult);
    const dispatch = viewer.wrapDispatch(inner);
    await dispatch('get_execution_evidence', {});
    const result = await dispatch('view_screenshot', { step_index: 99 });
    expect(result.ok).toBe(false);
  });

  it('view_screenshot surfaces a non-fatal error if the image fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeFetchResponse(false, 404)));
    const inner = vi.fn().mockResolvedValue(evidenceResult);
    const dispatch = viewer.wrapDispatch(inner);
    await dispatch('get_execution_evidence', {});
    const result = await dispatch('view_screenshot', { step_index: 0 });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/Failed to load screenshot/);
  });

  it('does not attempt interception when get_execution_evidence itself failed', async () => {
    const inner = vi.fn().mockResolvedValue({ ok: false, text: 'not found' });
    const dispatch = viewer.wrapDispatch(inner);
    const result = await dispatch('get_execution_evidence', {});
    expect(result.images).toBeUndefined();
  });

  it('gracefully passes through non-JSON get_execution_evidence responses', async () => {
    const inner = vi.fn().mockResolvedValue({ ok: true, text: 'not json' });
    const dispatch = viewer.wrapDispatch(inner);
    const result = await dispatch('get_execution_evidence', {});
    expect(result.text).toBe('not json');
    expect(result.images).toBeUndefined();
  });
});

describe('ScreenshotViewer.wrapDispatch — mandatory mode', () => {
  const evidenceResult: ToolResult = {
    ok: true,
    text: JSON.stringify({
      steps: [
        { step_index: 0, screenshot_url: 'https://example.com/step0.png' },
        { step_index: 1, screenshot_url: 'https://example.com/step1.png' },
      ],
    }),
  };

  it('attaches every step\'s screenshot unconditionally, without a tool call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeFetchResponse(true)));
    const viewer = new ScreenshotViewer(true);
    const inner = vi.fn().mockResolvedValue(evidenceResult);
    const dispatch = viewer.wrapDispatch(inner);
    const result = await dispatch('get_execution_evidence', {});
    expect(result.images).toHaveLength(2);
    expect(result.images!.map((i) => i.label)).toEqual(['step 0 screenshot', 'step 1 screenshot']);
  });

  it('one failing image fetch does not fail the whole evidence response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeFetchResponse(true))
      .mockResolvedValueOnce(fakeFetchResponse(false, 500));
    vi.stubGlobal('fetch', fetchMock);
    const viewer = new ScreenshotViewer(true);
    const inner = vi.fn().mockResolvedValue(evidenceResult);
    const dispatch = viewer.wrapDispatch(inner);
    const result = await dispatch('get_execution_evidence', {});
    expect(result.ok).toBe(true);
    expect(result.images).toHaveLength(1); // only the step that fetched successfully
  });

  it('steps with no screenshot_url are skipped, not errored', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeFetchResponse(true)));
    const viewer = new ScreenshotViewer(true);
    const inner = vi.fn().mockResolvedValue({ ok: true, text: JSON.stringify({ steps: [{ step_index: 0, screenshot_url: null }] }) });
    const dispatch = viewer.wrapDispatch(inner);
    const result = await dispatch('get_execution_evidence', {});
    expect(result.images).toEqual([]);
  });
});
