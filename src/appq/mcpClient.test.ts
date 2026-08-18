import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/env.js', () => ({
  config: {
    appqOrigin: 'https://appq.test',
    appqApiKey: () => 'test-api-key',
  },
}));

import { fetchPrompt, startWorkflow, callTool, listTools, uploadScreenshot } from './mcpClient.js';

function jsonRpcOk(result: unknown, id = 1) {
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result }) } as Response;
}

function jsonRpcError(code: number, message: string, id = 1) {
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id, error: { code, message } }) } as Response;
}

function httpError(status: number, body = 'server error') {
  return { ok: false, status, text: async () => body, json: async () => ({}) } as Response;
}

describe('callTool', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('posts a well-formed tools/call JSON-RPC request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRpcOk({ content: [{ type: 'text', text: 'ok' }] }));
    vi.stubGlobal('fetch', fetchMock);

    await callTool('get_scenario', { scenario_id: 1 });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://appq.test/api/appq/mcp',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_scenario', arguments: { scenario_id: 1 } } });
  });

  it('joins multiple text content blocks with a newline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonRpcOk({ content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] })),
    );
    const result = await callTool('get_scenario', {});
    expect(result.text).toBe('line one\nline two');
  });

  it('ok is true when isError is absent, false when isError is true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcOk({ content: [{ type: 'text', text: 'x' }] })));
    expect((await callTool('t', {})).ok).toBe(true);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcOk({ content: [{ type: 'text', text: 'boom' }], isError: true })));
    expect((await callTool('t', {})).ok).toBe(false);
  });

  it('throws on a non-ok HTTP response, including the status and body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpError(500, 'internal error')));
    await expect(callTool('t', {})).rejects.toThrow(/HTTP 500.*internal error/s);
  });

  it('throws on a JSON-RPC error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcError(-32601, 'Method not found')));
    await expect(callTool('t', {})).rejects.toThrow(/-32601.*Method not found/s);
  });

  it('increments the request id across successive calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRpcOk({ content: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await callTool('t1', {});
    await callTool('t2', {});
    const id1 = JSON.parse(fetchMock.mock.calls[0][1].body).id;
    const id2 = JSON.parse(fetchMock.mock.calls[1][1].body).id;
    expect(id2).toBe(id1 + 1);
  });
});

describe('fetchPrompt', () => {
  it('joins multiple message texts with a blank line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRpcOk({
          messages: [
            { role: 'user', content: { type: 'text', text: 'Phase 0' } },
            { role: 'user', content: { type: 'text', text: 'Phase 1' } },
          ],
        }),
      ),
    );
    const text = await fetchPrompt('appq:runman', { project_id: 1 });
    expect(text).toBe('Phase 0\n\nPhase 1');
  });

  it('sends the prompt name and args via prompts/get', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRpcOk({ messages: [{ role: 'user', content: { type: 'text', text: 'x' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchPrompt('appq:runman', { project_id: 1 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ method: 'prompts/get', params: { name: 'appq:runman', arguments: { project_id: 1 } } });
  });

  it('throws when the prompt has no text content at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcOk({ messages: [] })));
    await expect(fetchPrompt('appq:runman')).rejects.toThrow(/returned no text content/);
  });
});

describe('startWorkflow', () => {
  it('delegates to the start_workflow tool and returns its text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcOk({ content: [{ type: 'text', text: 'workflow prose' }] })));
    const text = await startWorkflow('autotest', { run_id: 'r1' });
    expect(text).toBe('workflow prose');
  });

  it('throws with the tool\'s own error text when start_workflow fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcOk({ content: [{ type: 'text', text: 'unknown workflow' }], isError: true })));
    await expect(startWorkflow('bogus')).rejects.toThrow(/unknown workflow/);
  });
});

describe('listTools', () => {
  it('returns the tools array from tools/list', async () => {
    const tools = [{ name: 'get_scenario', description: 'x', inputSchema: {} }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRpcOk({ tools })));
    expect(await listTools()).toEqual(tools);
  });
});

describe('uploadScreenshot', () => {
  it('posts the PNG bytes with the correct whitelisted content type and label header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ upload_id: 'abc-123' }) });
    vi.stubGlobal('fetch', fetchMock);

    const uploadId = await uploadScreenshot(Buffer.from([1, 2, 3]), 'autotest-step');

    expect(uploadId).toBe('abc-123');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://appq.test/api/appq/mcp/upload-screenshot');
    expect(init.headers).toMatchObject({
      'X-API-Key': 'test-api-key',
      'Content-Type': 'image/png', // never application/octet-stream — appq's endpoint 415s on that
      'X-Screenshot-Label': 'autotest-step',
    });
  });

  it('throws on a failed upload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 415 }));
    await expect(uploadScreenshot(Buffer.from([1]), 'label')).rejects.toThrow(/HTTP 415/);
  });
});
