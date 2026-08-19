import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLaunch } = vi.hoisted(() => ({ mockLaunch: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launch: mockLaunch } }));

import { judgeTc } from './judgeTc.js';
import type { ProviderAdapter, LlmCompleteResult, McpClient } from '@appliqation/agent-core';

function fakePage() {
  return {
    on: vi.fn(),
    goto: vi.fn().mockResolvedValue(undefined),
    ariaSnapshot: vi.fn().mockResolvedValue(''),
    screenshot: vi.fn().mockResolvedValue(Buffer.from([])),
  };
}

function fakeBrowserChain() {
  const page = fakePage();
  const context = { newPage: vi.fn().mockResolvedValue(page) };
  const browser = {
    version: vi.fn().mockReturnValue('133.0.6943.16'),
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { browser, context, page };
}

function fakeClient(): McpClient {
  return {
    fetchPrompt: vi.fn().mockResolvedValue('workflow system prompt'),
    startWorkflow: vi.fn(),
    callTool: vi.fn().mockResolvedValue({ ok: true, text: '{}' }),
    listTools: vi.fn().mockResolvedValue([]),
    uploadScreenshot: vi.fn(),
  };
}

/** An adapter whose single completion is queued up front — enough to end runLoop after one turn. */
function adapterReturning(response: LlmCompleteResult): ProviderAdapter {
  return { complete: vi.fn().mockResolvedValue(response) };
}

const textOnly = (text: string): LlmCompleteResult => ({ text, toolCalls: [] });
const budget = { maxCalls: 50, maxPages: 12, maxMillis: 900_000, maxTurns: 5 };

describe('judgeTc', () => {
  let client: McpClient;

  beforeEach(() => {
    client = fakeClient();
  });

  it('launches a browser, creates a plain context (no storageState given), and closes it after the executor stage', async () => {
    const { browser, context } = fakeBrowserChain();
    mockLaunch.mockResolvedValue(browser);

    await judgeTc({
      client,
      runId: 'r1',
      testCaseUuid: 'tc1',
      url: 'https://example.com',
      executorAdapter: adapterReturning(textOnly('executor done')),
      validatorAdapter: adapterReturning(textOnly('validator done')),
      budget,
      mandatoryImageCheck: false,
      dryRun: false,
    });

    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(browser.newContext).toHaveBeenCalledWith({});
    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('passes storageState into newContext when given', async () => {
    const { browser } = fakeBrowserChain();
    mockLaunch.mockResolvedValue(browser);
    const storageState = { cookies: [], origins: [] };

    await judgeTc({
      client,
      runId: 'r1',
      testCaseUuid: 'tc1',
      url: 'https://example.com',
      storageState,
      executorAdapter: adapterReturning(textOnly('done')),
      validatorAdapter: adapterReturning(textOnly('done')),
      budget,
      mandatoryImageCheck: false,
      dryRun: false,
    });

    expect(browser.newContext).toHaveBeenCalledWith({ storageState });
  });

  it('closes the browser even when the executor stage throws, and never runs the validator stage', async () => {
    const { browser } = fakeBrowserChain();
    mockLaunch.mockResolvedValue(browser);
    const executorAdapter: ProviderAdapter = { complete: vi.fn().mockRejectedValue(new Error('LLM API down')) };
    const validatorAdapter: ProviderAdapter = { complete: vi.fn() };

    await expect(
      judgeTc({
        client,
        runId: 'r1',
        testCaseUuid: 'tc1',
        url: 'https://example.com',
        executorAdapter,
        validatorAdapter,
        budget,
        mandatoryImageCheck: false,
        dryRun: false,
      }),
    ).rejects.toThrow('LLM API down');

    expect(browser.close).toHaveBeenCalledTimes(1); // finally block still runs
    expect(validatorAdapter.complete).not.toHaveBeenCalled(); // never reached
  });

  it('fetches only appq:autotest-executor for stage 1 and appq:autotest-validator for stage 2', async () => {
    const { browser } = fakeBrowserChain();
    mockLaunch.mockResolvedValue(browser);

    await judgeTc({
      client,
      runId: 'r1',
      testCaseUuid: 'tc1',
      url: 'https://example.com',
      executorAdapter: adapterReturning(textOnly('done')),
      validatorAdapter: adapterReturning(textOnly('done')),
      budget,
      mandatoryImageCheck: false,
      dryRun: false,
    });

    const fetchedNames = (client.fetchPrompt as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(fetchedNames).toEqual(['appq:autotest-executor', 'appq:autotest-validator']);
  });

  it('returns both stage results', async () => {
    const { browser } = fakeBrowserChain();
    mockLaunch.mockResolvedValue(browser);

    const result = await judgeTc({
      client,
      runId: 'r1',
      testCaseUuid: 'tc1',
      url: 'https://example.com',
      executorAdapter: adapterReturning(textOnly('executor report')),
      validatorAdapter: adapterReturning(textOnly('validator verdict')),
      budget,
      mandatoryImageCheck: false,
      dryRun: false,
    });

    expect(result.executorResult.report).toBe('executor report');
    expect(result.validatorResult.report).toBe('validator verdict');
  });

  it("passes the real browser.version()-derived label to create_defect when NOT in dry-run mode", async () => {
    const { browser } = fakeBrowserChain();
    mockLaunch.mockResolvedValue(browser);
    (client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'create_defect', description: 'x', inputSchema: {} }]);
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: 'defect created', raw: {} });

    // Validator's first turn calls create_defect with a (wrong) bare "Chromium" browser value.
    const validatorAdapter: ProviderAdapter = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          text: 'filing a defect',
          toolCalls: [{ id: 'c1', name: 'create_defect', arguments: { browser: 'Chromium', text: 'bug' } }],
        })
        .mockResolvedValueOnce(textOnly('done')),
    };

    await judgeTc({
      client,
      runId: 'r1',
      testCaseUuid: 'tc1',
      url: 'https://example.com',
      executorAdapter: adapterReturning(textOnly('done')),
      validatorAdapter,
      budget,
      mandatoryImageCheck: false,
      dryRun: false,
    });

    expect(client.callTool).toHaveBeenCalledWith('create_defect', expect.objectContaining({ browser: 'Chromium 133' }));
  });

  it(
    'in dry-run mode, the logged create_defect preview shows the CORRECTED browser label, matching what a ' +
      'real call would actually send — browser-label correction must be outermost, applied before dry-run\'s ' +
      "interception decides what to log, or the preview would misrepresent reality.",
    async () => {
      const { browser } = fakeBrowserChain();
      mockLaunch.mockResolvedValue(browser);
      (client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'create_defect', description: 'x', inputSchema: {} }]);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const validatorAdapter: ProviderAdapter = {
        complete: vi
          .fn()
          .mockResolvedValueOnce({
            text: 'filing a defect',
            toolCalls: [{ id: 'c1', name: 'create_defect', arguments: { browser: 'Chromium', text: 'bug' } }],
          })
          .mockResolvedValueOnce(textOnly('done')),
      };

      await judgeTc({
        client,
        runId: 'r1',
        testCaseUuid: 'tc1',
        url: 'https://example.com',
        executorAdapter: adapterReturning(textOnly('done')),
        validatorAdapter,
        budget,
        mandatoryImageCheck: false,
        dryRun: true,
      });

      // The real appq call never happens in dry-run mode at all.
      expect(client.callTool).not.toHaveBeenCalledWith('create_defect', expect.anything());
      // But the logged preview now reflects the corrected browser label.
      const loggedPreview = errSpy.mock.calls.map((c) => c[0]).find((l) => typeof l === 'string' && l.includes('create_defect'));
      expect(loggedPreview).toContain('"browser": "Chromium 133"');
    },
  );
});
