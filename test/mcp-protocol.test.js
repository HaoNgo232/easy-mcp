'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const TEST_PORT = 9898;
const TEST_TOKEN = 'test-token-mcp-qa-secret-123456';
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const projectRoot = path.resolve(__dirname, '..');
const testPngPath = path.join(projectRoot, '__test_sample_image__.png');
const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let serverProc = null;

// Helper: send HTTP request using node:http to allow full header control (including Host)
function request(method, pathname, options = {}) {
  const { headers = {}, body, token = TEST_TOKEN } = options;
  const reqHeaders = { ...headers };
  if (token && !reqHeaders['authorization'] && !reqHeaders['Authorization']) {
    reqHeaders['Authorization'] = `Bearer ${token}`;
  }
  const payload = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
  if (payload !== undefined && !reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
    reqHeaders['Content-Type'] = 'application/json';
  }
  if (payload !== undefined && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) {
    reqHeaders['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: pathname,
      method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({
          status: res.statusCode,
          headers: {
            get: (name) => res.headers[name.toLowerCase()] || null
          },
          rawHeaders: res.headers,
          text: data,
          json
        });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// Helper: SSE client
function openSse(pathname, headers = {}) {
  let req;
  const events = [];
  const listeners = [];
  let buffer = '';

  const connected = new Promise((resolve, reject) => {
    req = http.request(`${BASE_URL}${pathname}`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${TEST_TOKEN}`,
        ...headers
      }
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        buffer = buffer.replace(/\r\n/g, '\n');
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          if (!part.trim() || part.startsWith(':')) continue;
          let eventType = 'message';
          let eventData = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6);
            }
          }
          const ev = { type: eventType, data: eventData };
          events.push(ev);
          if (listeners.length > 0) {
            listeners.shift()(ev);
          }
        }
      });
      resolve({ statusCode: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.end();
  });

  async function nextEvent(timeoutMs = 4000) {
    if (events.length > 0) return events.shift();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = listeners.indexOf(onEv);
        if (idx >= 0) listeners.splice(idx, 1);
        reject(new Error(`Timeout after ${timeoutMs}ms waiting for SSE event`));
      }, timeoutMs);
      function onEv(ev) {
        clearTimeout(timer);
        resolve(ev);
      }
      listeners.push(onEv);
    });
  }

  function close() {
    if (req) {
      try { req.destroy(); } catch {}
    }
  }

  return { connected, nextEvent, close, events };
}

describe('Easy MCP Protocol & Streaming QA Test Suite', () => {
  before(async () => {
    // Create test 1x1 PNG for image testing
    fs.writeFileSync(testPngPath, Buffer.from(PNG_1X1_BASE64, 'base64'));

    // Start server process
    const serverPath = path.join(projectRoot, 'server.js');
    serverProc = spawn(process.execPath, [serverPath, projectRoot, '--port', String(TEST_PORT), '--token', TEST_TOKEN], {
      cwd: projectRoot,
      env: {
        ...process.env,
        EASY_MCP_PORT: String(TEST_PORT),
        EASY_MCP_TOKEN: TEST_TOKEN,
        EASY_MCP_TUNNEL: 'none',
        EASY_MCP_PROJECT: projectRoot
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProc.stderr.on('data', (d) => {
      const s = d.toString();
      if (!s.includes('ExperimentalWarning')) {
        // ignore benign warnings
      }
    });

    // Wait for server to start listening
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`${BASE_URL}/api/status`, {
          headers: { 'x-easy-mcp-token': TEST_TOKEN }
        });
        if (res.status === 200 || res.status === 401 || res.status === 404) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error('Easy MCP test server failed to start within 4 seconds');
  });

  after(() => {
    try { fs.unlinkSync(testPngPath); } catch {}
    if (serverProc) {
      try { serverProc.kill(); } catch {}
      serverProc = null;
    }
  });

  // =========================================================================
  // 1. Endpoint /mcp (JSON-RPC 2.0 Streamable HTTP Transport)
  // =========================================================================
  describe('1. Endpoint /mcp — JSON-RPC 2.0 Handling', () => {
    it('GET /mcp (without text/event-stream) returns online status JSON probe', async () => {
      const res = await request('GET', '/mcp');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.status, 'online');
      assert.strictEqual(res.json.service, 'Easy MCP');
      assert.ok(Array.isArray(res.json.tools));
    });

    it('POST /mcp — initialize negotiates protocolVersion and returns Mcp-Session-Id', async () => {
      const initReq = {
        jsonrpc: '2.0',
        id: 'init-1',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'qa-client', version: '1.0' }
        }
      };
      const res = await request('POST', '/mcp', { body: initReq });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.jsonrpc, '2.0');
      assert.strictEqual(res.json.id, 'init-1');
      assert.strictEqual(res.json.result.protocolVersion, '2024-11-05');
      assert.deepStrictEqual(res.json.result.capabilities, { tools: {} });
      assert.strictEqual(res.json.result.serverInfo.name, 'Easy MCP');
      assert.ok(res.headers.get('mcp-session-id'), 'Must provide Mcp-Session-Id header');
    });

    it('POST /mcp — notifications/initialized returns HTTP 202 Accepted without body', async () => {
      const notifReq = {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      };
      const res = await request('POST', '/mcp', { body: notifReq });
      assert.strictEqual(res.status, 202);
      assert.strictEqual(res.text, '');
    });

    it('POST /mcp — ping returns empty result object with matching id', async () => {
      const pingReq = { jsonrpc: '2.0', id: 42, method: 'ping' };
      const res = await request('POST', '/mcp', { body: pingReq });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.id, 42);
      assert.deepStrictEqual(res.json.result, {});
    });

    it('POST /mcp — tools/list returns available tools with inputSchema and annotations', async () => {
      const listReq = { jsonrpc: '2.0', id: 'tools-1', method: 'tools/list' };
      const res = await request('POST', '/mcp', { body: listReq });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.id, 'tools-1');
      assert.ok(Array.isArray(res.json.result.tools));
      const toolNames = res.json.result.tools.map((t) => t.name);
      assert.ok(toolNames.includes('read_file'));
      assert.ok(toolNames.includes('get_current_project'));
      const readFileTool = res.json.result.tools.find((t) => t.name === 'read_file');
      assert.ok(readFileTool.inputSchema);
      assert.ok(readFileTool.annotations);
      assert.strictEqual(readFileTool.annotations.readOnlyHint, true);
    });

    it('POST /mcp — tools/call executes tool successfully and returns text content', async () => {
      const callReq = {
        jsonrpc: '2.0',
        id: 'call-1',
        method: 'tools/call',
        params: { name: 'get_current_project', arguments: {} }
      };
      const res = await request('POST', '/mcp', { body: callReq });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.id, 'call-1');
      assert.strictEqual(res.json.result.isError, false);
      assert.ok(Array.isArray(res.json.result.content));
      assert.strictEqual(res.json.result.content[0].type, 'text');
      assert.strictEqual(res.json.result.content[0].text, projectRoot);
    });

    it('POST /mcp — tools/call returns native image content when reading an image file', async () => {
      const callReq = {
        jsonrpc: '2.0',
        id: 'call-img',
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '__test_sample_image__.png' } }
      };
      const res = await request('POST', '/mcp', { body: callReq });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.result.isError, false);
      assert.strictEqual(res.json.result.content[0].type, 'image');
      assert.strictEqual(res.json.result.content[0].mimeType, 'image/png');
      assert.strictEqual(res.json.result.content[0].data, PNG_1X1_BASE64);
    });

    it('POST /mcp — tools/call returns isError: true when a tool fails (no crash)', async () => {
      const callReq = {
        jsonrpc: '2.0',
        id: 'call-fail',
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: 'non_existent_file_12345.xyz' } }
      };
      const res = await request('POST', '/mcp', { body: callReq });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.result.isError, true);
      assert.ok(res.json.result.content[0].text.includes('Error'));
    });

    it('POST /mcp — resources/list returns -32601 Method not found (capabilities not advertised)', async () => {
      const reqMsg = { jsonrpc: '2.0', id: 'res-1', method: 'resources/list' };
      const res = await request('POST', '/mcp', { body: reqMsg });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.id, 'res-1');
      assert.strictEqual(res.json.error?.code, -32601);
      assert.ok(res.json.error?.message?.includes('resources/list'));
    });

    it('POST /mcp — prompts/list returns -32601 Method not found (capabilities not advertised)', async () => {
      const reqMsg = { jsonrpc: '2.0', id: 'prm-1', method: 'prompts/list' };
      const res = await request('POST', '/mcp', { body: reqMsg });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.id, 'prm-1');
      assert.strictEqual(res.json.error?.code, -32601);
      assert.ok(res.json.error?.message?.includes('prompts/list'));
    });

    it('DELETE /mcp terminates session with Mcp-Session-Id header', async () => {
      // 1. Initialize to create session
      const initRes = await request('POST', '/mcp', {
        body: { jsonrpc: '2.0', id: 1, method: 'initialize' }
      });
      const sessionId = initRes.headers.get('mcp-session-id');
      assert.ok(sessionId);

      // 2. DELETE /mcp with Mcp-Session-Id
      const delRes = await request('DELETE', '/mcp', {
        headers: { 'Mcp-Session-Id': sessionId }
      });
      assert.strictEqual(delRes.status, 200);
    });
  });

  // =========================================================================
  // 2. Authentication & Security
  // =========================================================================
  describe('2. Authentication & Token Verification', () => {
    it('Rejects unauthenticated request with 401 and WWW-Authenticate header on /mcp', async () => {
      const res = await request('POST', '/mcp', {
        body: { jsonrpc: '2.0', id: 1, method: 'ping' },
        token: ''
      });
      assert.strictEqual(res.status, 401);
      const authHeader = res.headers.get('www-authenticate');
      assert.ok(authHeader && authHeader.includes('Bearer'));
    });

    it('Rejects unauthenticated GET /sse with 401', async () => {
      const res = await request('GET', '/sse', { token: '' });
      assert.strictEqual(res.status, 401);
    });

    it('Rejects unauthenticated POST /messages with 401', async () => {
      const res = await request('POST', '/messages', {
        body: { jsonrpc: '2.0', id: 1, method: 'ping' },
        token: ''
      });
      assert.strictEqual(res.status, 401);
    });

    it('Accepts token via x-easy-mcp-token header', async () => {
      const res = await request('POST', '/mcp', {
        headers: { 'x-easy-mcp-token': TEST_TOKEN },
        body: { jsonrpc: '2.0', id: 10, method: 'ping' },
        token: ''
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.id, 10);
    });

    it('Accepts token via ?token= query parameter', async () => {
      const res = await request('POST', `/mcp?token=${TEST_TOKEN}`, {
        body: { jsonrpc: '2.0', id: 11, method: 'ping' },
        token: ''
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.id, 11);
    });

    it('Accepts token via path /mcp/<token>', async () => {
      const res = await request('POST', `/mcp/${TEST_TOKEN}`, {
        body: { jsonrpc: '2.0', id: 12, method: 'ping' },
        token: ''
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.id, 12);
    });
  });

  // =========================================================================
  // 3. CORS Headers and Security Policies
  // =========================================================================
  describe('3. CORS Headers & Preflight', () => {
    it('OPTIONS /mcp returns 204 with full CORS headers', async () => {
      const res = await request('OPTIONS', '/mcp', { token: '' });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
      assert.ok(res.headers.get('access-control-allow-methods').includes('POST'));
      assert.ok(res.headers.get('access-control-allow-methods').includes('DELETE'));
      assert.ok(res.headers.get('access-control-allow-headers').includes('Mcp-Session-Id'));
      assert.ok(res.headers.get('access-control-expose-headers').includes('Mcp-Session-Id'));
      assert.strictEqual(res.headers.get('access-control-max-age'), '86400');
    });

    it('OPTIONS /sse and OPTIONS /messages return 204 with CORS headers', async () => {
      const resSse = await request('OPTIONS', '/sse', { token: '' });
      assert.strictEqual(resSse.status, 204);
      assert.strictEqual(resSse.headers.get('access-control-allow-origin'), '*');

      const resMsg = await request('OPTIONS', '/messages', { token: '' });
      assert.strictEqual(resMsg.status, 204);
      assert.strictEqual(resMsg.headers.get('access-control-allow-origin'), '*');
    });

    it('GET /sse response carries Access-Control-Allow-Origin: *', async () => {
      const client = openSse('/sse');
      const conn = await client.connected;
      assert.strictEqual(conn.headers['access-control-allow-origin'], '*');
      client.close();
    });

    it('Blocks Private Network Access (PNA) preflights with 403 Forbidden', async () => {
      const res = await request('OPTIONS', '/mcp', {
        headers: { 'access-control-request-private-network': 'true' },
        token: ''
      });
      assert.strictEqual(res.status, 403);
    });

    it('Blocks unauthorized Host headers with 403 Forbidden', async () => {
      const res = await request('POST', '/mcp', {
        headers: { Host: 'evil-attacker-domain.com' },
        body: { jsonrpc: '2.0', id: 1, method: 'ping' }
      });
      assert.strictEqual(res.status, 403);
    });
  });

  // =========================================================================
  // 4. Batch Requests & Malformed JSON-RPC Handling (Compliant Behaviors)
  // =========================================================================
  describe('4. Batch Requests & Malformed JSON-RPC (Compliant Behaviors)', () => {
    it('POST /mcp with malformed JSON returns 400 Bad Request with code -32700', async () => {
      const res = await request('POST', '/mcp', { body: '{ malformed json syntax here' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.json.jsonrpc, '2.0');
      assert.strictEqual(res.json.id, null);
      assert.strictEqual(res.json.error?.code, -32700);
      assert.strictEqual(res.json.error?.message, 'Parse error');
    });

    it('POST /mcp with invalid method returns code -32601 with matching id', async () => {
      const res = await request('POST', '/mcp', {
        body: { jsonrpc: '2.0', id: 'inv-1', method: 'unknown/method' }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.id, 'inv-1');
      assert.strictEqual(res.json.error?.code, -32601);
      assert.ok(res.json.error?.message?.includes('unknown/method'));
    });

    it('POST /mcp preserves and echoes id: null in response', async () => {
      const res = await request('POST', '/mcp', {
        body: { jsonrpc: '2.0', id: null, method: 'ping' }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.id, null);
      assert.deepStrictEqual(res.json.result, {});
    });

    it('POST /mcp preserves and echoes id: null on error response', async () => {
      const res = await request('POST', '/mcp', {
        body: { jsonrpc: '2.0', id: null, method: 'bad_method' }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.id, null);
      assert.strictEqual(res.json.error?.code, -32601);
    });

    it('POST /mcp handles batch array of requests and returns matching array of responses', async () => {
      const batch = [
        { jsonrpc: '2.0', id: 'b1', method: 'ping' },
        { jsonrpc: '2.0', id: 'b2', method: 'ping' },
        { jsonrpc: '2.0', id: 'b3', method: 'bad_method' }
      ];
      const res = await request('POST', '/mcp', { body: batch });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.json));
      assert.strictEqual(res.json.length, 3);
      assert.strictEqual(res.json[0].id, 'b1');
      assert.deepStrictEqual(res.json[0].result, {});
      assert.strictEqual(res.json[1].id, 'b2');
      assert.deepStrictEqual(res.json[1].result, {});
      assert.strictEqual(res.json[2].id, 'b3');
      assert.strictEqual(res.json[2].error?.code, -32601);
    });

    it('POST /mcp handles batch with mixed notifications and requests (omits notifications)', async () => {
      const batch = [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 'mixed-1', method: 'ping' }
      ];
      const res = await request('POST', '/mcp', { body: batch });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.json));
      assert.strictEqual(res.json.length, 1);
      assert.strictEqual(res.json[0].id, 'mixed-1');
    });
  });

  // =========================================================================
  // 5. Server-Sent Events (SSE) & /messages Protocol Flow
  // =========================================================================
  describe('5. SSE Transport Flow (/sse and /messages)', () => {
    it('GET /sse establishes stream and emits event: endpoint with sessionId and sseToken', async () => {
      const client = openSse('/sse');
      await client.connected;
      const ev = await client.nextEvent();
      assert.strictEqual(ev.type, 'endpoint');
      assert.ok(ev.data.startsWith('/messages?'));
      const q = new URLSearchParams(ev.data.split('?')[1]);
      assert.ok(q.get('sessionId'), 'Endpoint must contain sessionId');
      assert.ok(q.get('token'), 'Endpoint must contain per-session sseToken');
      client.close();
    });

    it('POST /messages relays JSON-RPC response to the open SSE connection', async () => {
      const client = openSse('/sse');
      await client.connected;
      const endpointEv = await client.nextEvent();
      const endpointUri = endpointEv.data;

      // Post message using the endpoint URI with sseToken
      const postRes = await request('POST', endpointUri, {
        body: { jsonrpc: '2.0', id: 'sse-rpc-1', method: 'ping' },
        token: '' // auth is passed via sseToken in query param
      });
      assert.strictEqual(postRes.status, 202);

      // Await message event on SSE
      const msgEv = await client.nextEvent();
      assert.strictEqual(msgEv.type, 'message');
      const rpcResponse = JSON.parse(msgEv.data);
      assert.strictEqual(rpcResponse.id, 'sse-rpc-1');
      assert.deepStrictEqual(rpcResponse.result, {});

      client.close();
    });

    it('Disconnecting SSE client destroys session and invalidates sseToken', async () => {
      const client = openSse('/sse');
      await client.connected;
      const endpointEv = await client.nextEvent();
      const endpointUri = endpointEv.data;

      // Close the SSE stream
      client.close();

      // Give server a moment to fire req.on('close')
      await new Promise((r) => setTimeout(r, 100));

      // Attempt to send message with the old session token
      const postRes = await request('POST', endpointUri, {
        body: { jsonrpc: '2.0', id: 'after-close', method: 'ping' },
        token: ''
      });
      // Server must reject with 401 because sseToken was pruned on disconnect
      assert.strictEqual(postRes.status, 401);
    });
  });

  // =========================================================================
  // 6. RED TESTS — Identified Bugs & Spec Violations
  // =========================================================================
  describe('6. Edge Cases & Protocol Bug Demonstrations (RED Tests)', () => {
    /**
     * RED TEST 1: Empty Batch on /mcp
     * Spec: JSON-RPC 2.0 §4.2:
     *   "--> []"
     *   "<-- {"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid Request"}, "id": null}"
     * Bug in server.js:
     *   Line 2206: `if (!outs.length) { res.writeHead(202); return res.end(); }`
     *   Returns HTTP 202 with empty body instead of JSON-RPC -32600 Invalid Request!
     */
    it('[RED] POST /mcp with empty array [] should return JSON-RPC -32600 Invalid Request', async () => {
      const res = await request('POST', '/mcp', { body: '[]' });
      assert.notStrictEqual(res.status, 202, 'Empty batch must not return HTTP 202 Accepted');
      assert.strictEqual(res.json?.error?.code, -32600, 'Empty batch MUST return error code -32600 (Invalid Request)');
      assert.strictEqual(res.json?.id, null);
    });

    /**
     * RED TEST 2: Malformed JSON on POST /messages causes server crash (HTTP 500)
     * Bug in server.js:
     *   Line 2268: `const msg = JSON.parse(await readBody(req) || '{}');`
     *   No try/catch! Throws unhandled SyntaxError, caught by outer handler -> returns HTTP 500.
     * Expected:
     *   Should return HTTP 400 Bad Request (or JSON-RPC parse error -32700), never HTTP 500.
     */
    it('[RED] POST /messages with malformed JSON body should return 400 Bad Request, not 500 Internal Error', async () => {
      const client = openSse('/sse');
      await client.connected;
      const endpointEv = await client.nextEvent();
      const endpointUri = endpointEv.data;

      const res = await request('POST', endpointUri, {
        body: '{ malformed json syntax here',
        token: ''
      });
      client.close();

      assert.strictEqual(
        res.status,
        400,
        `Expected HTTP 400 for malformed JSON on /messages, but received HTTP ${res.status}: ${res.text}`
      );
    });

    /**
     * RED TEST 3: Batch requests on POST /messages are silently dropped
     * Spec / Expected:
     *   MCP clients communicating over SSE can send batch requests [ { ... }, { ... } ] to the message endpoint.
     * Bug in server.js:
     *   Line 2269: `const out = await handleRpc(msg);`
     *   When msg is an Array, handleRpc tries `const { id, method } = msg || {}`, resulting in
     *   id=undefined, method=undefined. handleRpc returns null!
     *   Nothing is written to the SSE stream. The batch is silently swallowed!
     */
    it('[RED] POST /messages with JSON-RPC batch array should process all items and emit responses on SSE', async () => {
      const client = openSse('/sse');
      await client.connected;
      const endpointEv = await client.nextEvent();
      const endpointUri = endpointEv.data;

      const batchReq = [
        { jsonrpc: '2.0', id: 'batch-sse-1', method: 'ping' },
        { jsonrpc: '2.0', id: 'batch-sse-2', method: 'ping' }
      ];

      const postRes = await request('POST', endpointUri, {
        body: batchReq,
        token: ''
      });
      assert.strictEqual(postRes.status, 202);

      // We should receive response event(s) for the batch
      const ev = await client.nextEvent(2000);
      client.close();

      assert.strictEqual(ev.type, 'message');
      const parsedData = JSON.parse(ev.data);
      if (Array.isArray(parsedData)) {
        assert.strictEqual(parsedData.length, 2);
        assert.strictEqual(parsedData[0].id, 'batch-sse-1');
        assert.strictEqual(parsedData[1].id, 'batch-sse-2');
      } else {
        assert.strictEqual(parsedData.id, 'batch-sse-1');
      }
    });

    /**
     * RED TEST 4: DELETE /messages or DELETE /sse returns 404 instead of closing session
     * Spec / Requirement:
     *   "Endpoint /sse và /messages: ... hủy session khi disconnect hoặc DELETE"
     * Bug in server.js:
     *   Line 2247 only supports `url.pathname === '/mcp' && req.method === 'DELETE'`.
     *   There is no route for DELETE /messages or DELETE /sse.
     *   Calling DELETE /messages?sessionId=... or DELETE /sse?sessionId=... returns HTTP 404 Not Found.
     */
    it('[RED] DELETE /messages?sessionId=... should terminate the SSE session', async () => {
      const client = openSse('/sse');
      await client.connected;
      const endpointEv = await client.nextEvent();
      const endpointUri = endpointEv.data; // e.g. /messages?token=...&sessionId=...

      const delRes = await request('DELETE', endpointUri, { token: '' });
      client.close();

      assert.strictEqual(
        delRes.status,
        200,
        `Expected HTTP 200 on DELETE ${endpointUri}, but received HTTP ${delRes.status}: ${delRes.text}`
      );
    });

    /**
     * RED TEST 5: POST /messages with invalid / non-existent sessionId returns 202 Accepted instead of error
     * Bug in server.js:
     *   Line 2266-2273:
     *     const sse = sseSessions.get(sessionId);
     *     const out = await handleRpc(msg);
     *     if (out && sse) sse.write(...);
     *     res.writeHead(202);
     *     return res.end();
     *   If sessionId is bogus or already expired, server still returns 202 Accepted,
     *   pretending to accept the message, while silently discarding it!
     * Expected:
     *   Should return HTTP 404 (Session not found) or 400 (Bad request).
     */
    it('[RED] POST /messages with unknown sessionId should return 404/400 instead of 202 Accepted', async () => {
      const res = await request('POST', '/messages?sessionId=non_existent_session_12345', {
        body: { jsonrpc: '2.0', id: 'orphan-1', method: 'ping' },
        token: TEST_TOKEN
      });
      assert.notStrictEqual(
        res.status,
        202,
        'Server must not return 202 Accepted for unknown/expired session on /messages'
      );
      assert.ok(
        res.status === 404 || res.status === 400,
        `Expected HTTP 404 or 400, got ${res.status}`
      );
    });
  });
});
