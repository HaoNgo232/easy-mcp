'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.once('exit', () => resolve());
    try {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      resolve();
    }
  });
}

describe('OAuth 2.0 Token Exchange & RFC Discovery Regression Suite', () => {
  let serverProcess;
  let baseUrl;
  let port;
  const masterToken = 'test_master_token_oauth_rfc_123456';
  let testHome;
  let testProj;

  before(async () => {
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-oauth-home-'));
    testProj = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-oauth-proj-'));

    const env = {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      EASY_MCP_PORT: String(port),
      EASY_MCP_TOKEN: masterToken,
      EASY_MCP_PROJECT: testProj,
      EASY_MCP_TUNNEL: 'none',
      EASY_MCP_REQUIRE_AUTH: '1'
    };

    const serverScript = path.resolve(__dirname, '..', 'server.js');
    serverProcess = spawn(process.execPath, [serverScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server start timed out')), 8000);
      serverProcess.stdout.on('data', (d) => {
        if (d.toString().includes('Easy MCP server on')) {
          clearTimeout(timer);
          resolve();
        }
      });
      serverProcess.stderr.on('data', (d) => {
        const str = d.toString();
        if (str.includes('EADDRINUSE')) {
          clearTimeout(timer);
          reject(new Error(`Port ${port} already in use`));
        }
      });
    });
  });

  after(async () => {
    await stopServer(serverProcess);
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(testProj, { recursive: true, force: true }); } catch {}
  });

  test('1. RFC 8414 Authorization Server Metadata (/.well-known/oauth-authorization-server)', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.issuer, baseUrl);
    assert.strictEqual(data.authorization_endpoint, `${baseUrl}/oauth/authorize`);
    assert.strictEqual(data.token_endpoint, `${baseUrl}/oauth/token`);
    assert.strictEqual(data.registration_endpoint, `${baseUrl}/oauth/register`);
    assert.ok(data.code_challenge_methods_supported.includes('S256'));
    assert.ok(data.code_challenge_methods_supported.includes('plain'));
  });

  test('2. RFC 9470 OAuth Protected Resource Metadata (/.well-known/oauth-protected-resource)', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.resource, `${baseUrl}/mcp`);
    assert.deepStrictEqual(data.authorization_servers, [baseUrl]);
    assert.ok(data.bearer_methods_supported.includes('header'));
  });

  test('3. Full PKCE S256 Authorization Code Flow & Access Token Usage', async () => {
    // 3.1 Register client
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
        token_endpoint_auth_method: 'none'
      })
    });
    assert.strictEqual(regRes.status, 201);
    const client = await regRes.json();
    const clientId = client.client_id;
    assert.ok(clientId);

    // 3.2 PKCE S256 setup
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    // 3.3 Authorize request with master token in resource
    const authUrl = `${baseUrl}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=https://chatgpt.com/connector/oauth/callback&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${baseUrl}/mcp/${masterToken}`)}`;
    const authRes = await fetch(authUrl, { redirect: 'manual' });
    assert.strictEqual(authRes.status, 302);
    const loc = new URL(authRes.headers.get('location'));
    const code = loc.searchParams.get('code');
    assert.ok(code);

    // 3.4 Token exchange (/oauth/token)
    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: 'https://chatgpt.com/connector/oauth/callback',
        code_verifier: verifier
      }).toString()
    });
    assert.strictEqual(tokenRes.status, 200);
    const tokens = await tokenRes.json();
    assert.ok(tokens.access_token.startsWith('emcp_at_'));
    assert.strictEqual(tokens.token_type, 'Bearer');
    assert.strictEqual(tokens.scope, 'mcp');

    // 3.5 Use exchanged access_token to access /mcp
    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokens.access_token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    assert.strictEqual(mcpRes.status, 200);
    const mcpData = await mcpRes.json();
    assert.ok(Array.isArray(mcpData.result.tools));
  });

  test('4. Code Replay Protection (Single-use Authorization Code)', async () => {
    // 4.1 Register client
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://chatgpt.com/callback'],
        token_endpoint_auth_method: 'none'
      })
    });
    const { client_id: clientId } = await regRes.json();

    const verifier = 'test_code_verifier_string_12345';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    // 4.2 Authorize
    const authUrl = `${baseUrl}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=https://chatgpt.com/callback&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${baseUrl}/mcp/${masterToken}`)}`;
    const authRes = await fetch(authUrl, { redirect: 'manual' });
    const code = new URL(authRes.headers.get('location')).searchParams.get('code');

    // 4.3 First exchange succeeds
    const res1 = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: 'https://chatgpt.com/callback',
        code_verifier: verifier
      }).toString()
    });
    assert.strictEqual(res1.status, 200);

    // 4.4 Second exchange MUST fail (401 invalid_grant)
    const res2 = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: 'https://chatgpt.com/callback',
        code_verifier: verifier
      }).toString()
    });
    assert.strictEqual(res2.status, 401);
    const err = await res2.json();
    assert.strictEqual(err.error, 'invalid_grant');
  });

  test('5. PKCE S256 Verifier Mismatch Protection', async () => {
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://chatgpt.com/callback'],
        token_endpoint_auth_method: 'none'
      })
    });
    const { client_id: clientId } = await regRes.json();

    const verifier = 'correct_verifier_12345';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    const authUrl = `${baseUrl}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=https://chatgpt.com/callback&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${baseUrl}/mcp/${masterToken}`)}`;
    const authRes = await fetch(authUrl, { redirect: 'manual' });
    const code = new URL(authRes.headers.get('location')).searchParams.get('code');

    // Exchange with WRONG verifier
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: 'https://chatgpt.com/callback',
        code_verifier: 'wrong_verifier_99999'
      }).toString()
    });
    assert.strictEqual(res.status, 401);
    const err = await res.json();
    assert.strictEqual(err.error, 'invalid_client');
  });

  test('6. Client ID & Redirect URI Mismatch Protection', async () => {
    const regRes = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://chatgpt.com/callback1', 'https://chatgpt.com/callback2'],
        token_endpoint_auth_method: 'none'
      })
    });
    const { client_id: clientId } = await regRes.json();

    const verifier = 'plain_verifier_abc';
    const authUrl = `${baseUrl}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=https://chatgpt.com/callback1&code_challenge=${verifier}&code_challenge_method=plain&resource=${encodeURIComponent(`${baseUrl}/mcp/${masterToken}`)}`;
    const authRes = await fetch(authUrl, { redirect: 'manual' });
    const code = new URL(authRes.headers.get('location')).searchParams.get('code');

    // Exchange with mismatched redirect_uri
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: 'https://chatgpt.com/callback2',
        code_verifier: verifier
      }).toString()
    });
    assert.strictEqual(res.status, 401);
    const err = await res.json();
    assert.strictEqual(err.error, 'invalid_grant');
    assert.strictEqual(err.error_description, 'redirect_uri mismatch');
  });
});
