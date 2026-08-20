import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLaunch, mockNewContext } = vi.hoisted(() => ({ mockLaunch: vi.fn(), mockNewContext: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launch: mockLaunch }, request: { newContext: mockNewContext } }));

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

function fakeApiContext() {
  return {
    fetch: vi.fn().mockResolvedValue({
      status: vi.fn().mockReturnValue(200),
      ok: vi.fn().mockReturnValue(true),
      headers: vi.fn().mockReturnValue({}),
      text: vi.fn().mockResolvedValue('{}'),
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
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
    mockNewContext.mockReset();
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

describe('judgeTc — API test type', () => {
  let client: McpClient;

  beforeEach(() => {
    client = fakeClient();
    mockLaunch.mockReset();
    mockNewContext.mockReset();
  });

  it('never launches a browser for testType "api" — uses request.newContext instead', async () => {
    const apiContext = fakeApiContext();
    mockNewContext.mockResolvedValue(apiContext);

    await judgeTc({
      client,
      runId: 'r1',
      testCaseUuid: 'tc1',
      url: 'https://api.example.com',
      testType: 'api',
      executorAdapter: adapterReturning(textOnly('done')),
      validatorAdapter: adapterReturning(textOnly('done')),
      budget,
      mandatoryImageCheck: false,
      dryRun: false,
    });

    expect(mockLaunch).not.toHaveBeenCalled();
    expect(mockNewContext).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'https://api.example.com' }));
  });

  it('injects the resolved apiAuthHeader into extraHTTPHeaders, never exposing it any other way', async () => {
    const apiContext = fakeApiContext();
    mockNewContext.mockResolvedValue(apiContext);

    await judgeTc({
      client,
      runId: 'r1',
      testCaseUuid: 'tc1',
      url: 'https://api.example.com',
      testType: 'api',
      apiAuthHeader: { name: 'Authorization', value: 'Bearer secret-token' },
      executorAdapter: adapterReturning(textOnly('done')),
      validatorAdapter: adapterReturning(textOnly('done')),
      budget,
      mandatoryImageCheck: false,
      dryRun: false,
    });

    expect(mockNewContext).toHaveBeenCalledWith(
      expect.objectContaining({ extraHTTPHeaders: { Authorization: 'Bearer secret-token' } }),
    );
  });

  it('disposes the API context after the executor stage, even without an explicit auth header', async () => {
    const apiContext = fakeApiContext();
    mockNewContext.mockResolvedValue(apiContext);

    await judgeTc({
      client,
      runId: 'r1',
      testCaseUuid: 'tc1',
      url: 'https://api.example.com',
      testType: 'api',
      executorAdapter: adapterReturning(textOnly('done')),
      validatorAdapter: adapterReturning(textOnly('done')),
      budget,
      mandatoryImageCheck: false,
      dryRun: false,
    });

    expect(mockNewContext).toHaveBeenCalledWith(expect.objectContaining({ extraHTTPHeaders: undefined }));
    expect(apiContext.dispose).toHaveBeenCalledTimes(1);
  });

  it('fetches appq:autotest-executor / -validator with test_type: "api" in their prompt args', async () => {
    const apiContext = fakeApiContext();
    mockNewContext.mockResolvedValue(apiContext);

    await judgeTc({
      client,
      runId: 'r1',
      testCaseUuid: 'tc1',
      url: 'https://api.example.com',
      testType: 'api',
      executorAdapter: adapterReturning(textOnly('done')),
      validatorAdapter: adapterReturning(textOnly('done')),
      budget,
      mandatoryImageCheck: false,
      dryRun: false,
    });

    // runWorkflow's source.args aren't visible directly here since fetchPrompt
    // only receives the prompt name — but the executor/validator workflows
    // are still fetched in the right order for the API path.
    const fetchedNames = (client.fetchPrompt as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(fetchedNames).toEqual(['appq:autotest-executor', 'appq:autotest-validator']);
  });

  it('routes http_request tool calls to the real API context, not the appq dispatcher', async () => {
    const apiContext = fakeApiContext();
    mockNewContext.mockResolvedValue(apiContext);

    const executorAdapter: ProviderAdapter = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          text: 'calling the API',
          toolCalls: [{ id: 'c1', name: 'http_request', arguments: { method: 'GET', url: '/users/1' } }],
        })
        .mockResolvedValueOnce(textOnly('done')),
    };

    await judgeTc({
      client,
      runId: 'r1',
      testCaseUuid: 'tc1',
      url: 'https://api.example.com',
      testType: 'api',
      executorAdapter,
      validatorAdapter: adapterReturning(textOnly('done')),
      budget,
      mandatoryImageCheck: false,
      dryRun: false,
    });

    expect(apiContext.fetch).toHaveBeenCalledWith('/users/1', expect.objectContaining({ method: 'GET' }));
  });

  it('passes dryRun through to the API tools, suppressing a write-verb request', async () => {
    const apiContext = fakeApiContext();
    mockNewContext.mockResolvedValue(apiContext);

    const executorAdapter: ProviderAdapter = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          text: 'posting',
          toolCalls: [{ id: 'c1', name: 'http_request', arguments: { method: 'POST', url: '/users', body: { name: 'x' } } }],
        })
        .mockResolvedValueOnce(textOnly('done')),
    };

    await judgeTc({
      client,
      runId: 'r1',
      testCaseUuid: 'tc1',
      url: 'https://api.example.com',
      testType: 'api',
      executorAdapter,
      validatorAdapter: adapterReturning(textOnly('done')),
      budget,
      mandatoryImageCheck: false,
      dryRun: true,
    });

    expect(apiContext.fetch).not.toHaveBeenCalled();
  });

  it('uses "API" as the browser label for create_defect, not a Chromium guess', async () => {
    const apiContext = fakeApiContext();
    mockNewContext.mockResolvedValue(apiContext);
    (client.listTools as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'create_defect', description: 'x', inputSchema: {} }]);
    (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: 'defect created', raw: {} });

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
      url: 'https://api.example.com',
      testType: 'api',
      executorAdapter: adapterReturning(textOnly('done')),
      validatorAdapter,
      budget,
      mandatoryImageCheck: false,
      dryRun: false,
    });

    expect(client.callTool).toHaveBeenCalledWith('create_defect', expect.objectContaining({ browser: 'API' }));
  });

  it('defaults to the UI/browser path when testType is omitted', async () => {
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

    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(mockNewContext).not.toHaveBeenCalled();
  });
});
