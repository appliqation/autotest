import { describe, it, expect, vi } from 'vitest';
import { formatBrowserLabel, createBrowserLabelDispatcher } from './browserLabel.js';

describe('formatBrowserLabel', () => {
  it('extracts the major version from a full Chromium version string', () => {
    expect(formatBrowserLabel('133.0.6943.16')).toBe('Chromium 133');
  });

  it('handles a single-segment version string', () => {
    expect(formatBrowserLabel('133')).toBe('Chromium 133');
  });

  it('handles a two-digit major version', () => {
    expect(formatBrowserLabel('99.0.1234.5')).toBe('Chromium 99');
  });
});

describe('createBrowserLabelDispatcher', () => {
  it('overrides the browser field on create_defect calls with the real label', async () => {
    const inner = vi.fn().mockResolvedValue({ ok: true, text: 'ok' });
    const dispatch = createBrowserLabelDispatcher(inner, 'Chromium 133');
    await dispatch('create_defect', { browser: 'Chromium', text: 'a bug' });
    expect(inner).toHaveBeenCalledWith('create_defect', { browser: 'Chromium 133', text: 'a bug' });
  });

  it('overrides even when the model omitted the browser field entirely', async () => {
    const inner = vi.fn().mockResolvedValue({ ok: true, text: 'ok' });
    const dispatch = createBrowserLabelDispatcher(inner, 'Chromium 133');
    await dispatch('create_defect', { text: 'a bug' });
    expect(inner).toHaveBeenCalledWith('create_defect', { text: 'a bug', browser: 'Chromium 133' });
  });

  it('leaves other tool calls untouched', async () => {
    const inner = vi.fn().mockResolvedValue({ ok: true, text: 'ok' });
    const dispatch = createBrowserLabelDispatcher(inner, 'Chromium 133');
    await dispatch('update_run_results', { browser: 'Chromium', action: 'submit_results' });
    expect(inner).toHaveBeenCalledWith('update_run_results', { browser: 'Chromium', action: 'submit_results' });
  });
});
