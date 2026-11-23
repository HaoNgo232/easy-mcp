'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

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

async function startServer(options = {}) {
  const port = await getFreePort();
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-home-'));
  const testProject = options.projectDir || fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-proj-'));

  if (!fs.existsSync(path.join(testProject, 'sample.txt'))) {
    fs.writeFileSync(path.join(testProject, 'sample.txt'), 'Sample Project File Content\n');
  }
  const gitDir = path.join(testProject, '.git');
  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
  }

  const token = options.token || ('test_tok_' + Math.random().toString(16).slice(2) + '0123456789abcdef');
  const serverArgs = [path.resolve(__dirname, '..', 'server.js')];
  if (options.noAuth) serverArgs.push('--no-auth');
  if (options.enableShell) serverArgs.push('--enable-shell');

  const env = {
    ...process.env,
    HOME: testHome,
    USERPROFILE: testHome,
    EASY_MCP_PORT: String(port),
    EASY_MCP_TOKEN: token,
    EASY_MCP_PROJECT: testProject,
    EASY_MCP_TUNNEL: 'none',
    EASY_MCP_REQUIRE_AUTH: options.noAuth ? '0' : '1',
    EASY_MCP_ENABLE_SHELL: options.enableShell ? '1' : '0'
  };

  const child = spawn(process.execPath, serverArgs, {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server failed to start in 7000ms')), 7000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes('Easy MCP server on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  let adminSecret = '';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const html = await res.text();
    const m = html.match(/const ADMIN = '([a-f0-9]+)';/);
    if (m) adminSecret = m[1];
  } catch {}

  return {
    port,
    token,
    adminSecret,
    projectDir: testProject,
    homeDir: testHome,
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    async cleanup() {
      await stopServer(child);
      try { fs.rmSync(testHome, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(testProject, { recursive: true, force: true }); } catch {}
    }
  };
}

// ============================================================================
// 1. Token Verification Mechanism
// ============================================================================
describe('1. Token Verification Mechanism', () => {
  let srv;

  before(async () => {
    srv = await startServer();
  });

  after(async () => {
    if (srv) await srv.cleanup();
  });

  test('1.1 Authenticates with "Authorization: Bearer <TOKEN>" header', async () => {
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'get_current_project' })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
  });

  test('1.2 Authenticates with "x-easy-mcp-token" header', async () => {
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-easy-mcp-token': srv.token
      },
      body: JSON.stringify({ name: 'get_current_project' })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
  });

  test('1.3 Authenticates with "?token=<TOKEN>" query parameter', async () => {
    const res = await fetch(`${srv.baseUrl}/call?token=${srv.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'get_current_project' })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
  });

  test('1.4 Authenticates with path token "/mcp/<TOKEN>"', async () => {
    const res = await fetch(`${srv.baseUrl}/mcp/${srv.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.result, {});
  });

  test('1.5 Precedence: Authorization header overrides query param token', async () => {
    // If Authorization header has an invalid token, it overrides a valid query param token -> 401
    const res = await fetch(`${srv.baseUrl}/call?token=${srv.token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid_token_123'
      },
      body: JSON.stringify({ name: 'get_current_project' })
    });
    assert.strictEqual(res.status, 401);
  });

  test('1.6 Rejects invalid token with 401 Unauthorized', async () => {
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong_token_xyz'
      },
      body: JSON.stringify({ name: 'get_current_project' })
    });
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.error, 'Unauthorized');
  });

  test('1.7 Rejects missing token with 401 Unauthorized', async () => {
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'get_current_project' })
    });
    assert.strictEqual(res.status, 401);
  });

  test('1.8 Rejects empty Bearer header ("Bearer ") with 401 Unauthorized', async () => {
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer '
      },
      body: JSON.stringify({ name: 'get_current_project' })
    });
    assert.strictEqual(res.status, 401);
  });

  test('1.9 Allows unauthenticated access when REQUIRE_AUTH=false (--no-auth)', async () => {
    const noAuthSrv = await startServer({ noAuth: true });
    try {
      const res = await fetch(`${noAuthSrv.baseUrl}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'get_current_project' })
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.success, true);
    } finally {
      await noAuthSrv.cleanup();
    }
  });

  test('[RED TEST] 1.10 Case-insensitive Bearer scheme compliance (RFC 6750): lowercase "bearer <token>"', async () => {
    // RFC 6750 section 2.1 specifies auth scheme is case-insensitive.
    // server.js line 831 uses `header.startsWith('Bearer ')`, so "bearer " is rejected with 401.
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'get_current_project' })
    });
    // Expected: 200 per RFC 6750. Actual in server.js: 401.
    assert.strictEqual(res.status, 200, 'Expected RFC 6750 case-insensitive auth scheme to return 200');
  });
});

// ============================================================================
// 2. Dashboard Control Plane (/api/*) Protection
// ============================================================================
describe('2. Dashboard Control Plane (/api/*) Protection', () => {
  let srv;

  before(async () => {
    srv = await startServer();
  });

  after(async () => {
    if (srv) await srv.cleanup();
  });

  test('2.1 Allows loopback admin request with valid x-easy-mcp-admin secret', async () => {
    const res = await fetch(`${srv.baseUrl}/api/dashboard`, {
      headers: { 'x-easy-mcp-admin': srv.adminSecret }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'online');
  });

  test('2.2 Blocks /api/* without x-easy-mcp-admin header with 401 Unauthorized', async () => {
    const res = await fetch(`${srv.baseUrl}/api/dashboard`);
    assert.strictEqual(res.status, 401);
    const data = await res.json();
    assert.strictEqual(data.error, 'Unauthorized');
  });

  test('2.3 Blocks /api/* with invalid x-easy-mcp-admin header with 401 Unauthorized', async () => {
    const res = await fetch(`${srv.baseUrl}/api/dashboard`, {
      headers: { 'x-easy-mcp-admin': 'wrong_secret_12345678901234567890' }
    });
    assert.strictEqual(res.status, 401);
  });

  test('2.4 Blocks /api/* when spoofed tunnel header "x-forwarded-for" is present (returns 404)', async () => {
    // isLocalAdminRequest must treat any request carrying tunnel headers as remote -> 404
    const res = await fetch(`${srv.baseUrl}/api/dashboard`, {
      headers: {
        'x-easy-mcp-admin': srv.adminSecret,
        'x-forwarded-for': '203.0.113.1'
      }
    });
    assert.strictEqual(res.status, 404);
  });

  test('2.5 Blocks /api/* when spoofed tunnel header "cf-connecting-ip" is present (returns 404)', async () => {
    const res = await fetch(`${srv.baseUrl}/api/dashboard`, {
      headers: {
        'x-easy-mcp-admin': srv.adminSecret,
        'cf-connecting-ip': '203.0.113.2'
      }
    });
    assert.strictEqual(res.status, 404);
  });

  test('2.6 Blocks /api/* when spoofed tunnel header "cf-ray" is present (returns 404)', async () => {
    const res = await fetch(`${srv.baseUrl}/api/dashboard`, {
      headers: {
        'x-easy-mcp-admin': srv.adminSecret,
        'cf-ray': '8d1234567890abcd'
      }
    });
    assert.strictEqual(res.status, 404);
  });

  test('2.7 Blocks /api/* when spoofed tunnel header "tailscale-user-login" is present (returns 404)', async () => {
    const res = await fetch(`${srv.baseUrl}/api/dashboard`, {
      headers: {
        'x-easy-mcp-admin': srv.adminSecret,
        'tailscale-user-login': 'user@example.com'
      }
    });
    assert.strictEqual(res.status, 404);
  });

  test('2.8 Blocks /api/* with non-loopback Host header (DNS rebinding / remote access) with 403 Forbidden', async () => {
    // WHATWG fetch() in Node strips custom Host headers, so we use http.request to preserve Host on the wire
    const statusCode = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: srv.port,
        path: '/api/dashboard',
        headers: {
          'Host': 'attacker.example.com',
          'x-easy-mcp-admin': srv.adminSecret
        }
      }, (res) => {
        resolve(res.statusCode);
      });
      req.on('error', (err) => {
        // If server forcibly closes connection on 403
        resolve(403);
      });
      req.end();
    });
    assert.strictEqual(statusCode, 403);
  });

  test('2.9 Blocks "/" and "/dashboard" when tunnel headers are present (returns 404, preventing secret leakage)', async () => {
    const res = await fetch(`${srv.baseUrl}/dashboard`, {
      headers: { 'x-forwarded-for': '198.51.100.5' }
    });
    assert.strictEqual(res.status, 404);
  });

  test('2.10 Blocks cross-site state-changing requests (sec-fetch-site: cross-site) with 403 Forbidden', async () => {
    const res = await fetch(`${srv.baseUrl}/api/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-easy-mcp-admin': srv.adminSecret,
        'sec-fetch-site': 'cross-site'
      },
      body: JSON.stringify({ readOnly: true })
    });
    assert.strictEqual(res.status, 403);
  });
});

// ============================================================================
// 3. Folder Jail and Path Traversal Protection
// ============================================================================
describe('3. Folder Jail and Path Traversal Protection', () => {
  let srv;
  let outsideDir;

  before(async () => {
    srv = await startServer({ enableShell: false });
    // Create an outside folder with sensitive file
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'OUTSIDE_SECRET_DATA');

    // Create a symlink inside project pointing to the outside folder
    try {
      fs.symlinkSync(outsideDir, path.join(srv.projectDir, 'symlink_outside'), 'junction');
    } catch {}
  });

  after(async () => {
    if (srv) await srv.cleanup();
    try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch {}
  });

  test('3.1 Allows reading legitimate files inside project folder', async () => {
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'read_file', arguments: { path: 'sample.txt' } })
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.match(body.result, /Sample Project File Content/);
  });

  test('3.2 Blocks path traversal with ".." in read_file', async () => {
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'read_file', arguments: { path: '../outside.txt' } })
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.match(body.error, /Path escapes project folder/);
  });

  test('3.3 Blocks deep path traversal "../../../../" in read_file', async () => {
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'read_file', arguments: { path: '../../../../Windows/win.ini' } })
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.match(body.error, /Path escapes project folder/);
  });

  test('3.4 Blocks Windows cross-drive absolute path in read_file', async () => {
    const outsidePath = path.join(outsideDir, 'secret.txt');
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'read_file', arguments: { path: outsidePath } })
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.match(body.error, /Path escapes project folder/);
  });

  test('3.5 Blocks Windows UNC path (\\\\localhost\\...) in read_file', async () => {
    const uncPath = '\\\\localhost\\c$\\Windows\\win.ini';
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'read_file', arguments: { path: uncPath } })
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.match(body.error, /Path escapes project folder/);
  });

  test('3.6 Blocks reading through symlink that points outside project folder', async () => {
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'read_file', arguments: { path: 'symlink_outside/secret.txt' } })
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.match(body.error, /Path escapes project folder/);
  });

  test('3.7 Blocks path traversal with ".." in write_file', async () => {
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'write_file', arguments: { path: '../escaped_write.txt', content: 'pwned' } })
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.match(body.error, /Path escapes project folder/);
  });

  test('3.8 Blocks "set_project" tool when folder jail is on (!SKIP_JAIL)', async () => {
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'set_project', arguments: { path: outsideDir } })
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.match(body.error, /set_project is disabled while the folder jail is on/);
  });

  test('3.9 Blocks writing to lowercase .git/config when shell is disabled', async () => {
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'write_file', arguments: { path: '.git/config', content: '[core]\n\thacked = true\n' } })
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.match(body.error, /Writing git internals is blocked while the shell is disabled/);
  });

  test('[RED TEST] 3.10 Blocks creating new git hook (".git/hooks/pre-commit") when shell is disabled', async () => {
    // Vulnerability in server.js assertNotGitInternal:
    // When writing a new hook that does not exist yet on disk, `realpathOrAncestor(abs)` walks up to `.git/hooks` or `.git`.
    // Then `path.relative` produces `'.git/hooks'`, but line 260 checks `rel.startsWith('.git/hooks/')` with a trailing slash!
    // Since `'.git/hooks'` does not end with '/', it does NOT match and allows writing new git hooks!
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'write_file', arguments: { path: '.git/hooks/pre-commit', content: '#!/bin/sh\ncalc.exe\n' } })
    });
    // Expected: 400 (Writing git internals is blocked). Actual: 200 (hook written successfully!).
    assert.strictEqual(res.status, 400, 'Expected write to .git/hooks/pre-commit to be blocked with 400');
  });

  test('[RED TEST] 3.11 Case-insensitive Git internals bypass on Windows/macOS: write_file to mixed-case ".Git/config"', async () => {
    // In server.js line 260: `rel === '.git/config'` is strictly case-sensitive.
    // On Windows/macOS filesystem, `.Git/config` resolves to `.git\config`.
    // An attacker writing to `.Git/config` bypasses assertNotGitInternal and smuggles config changes!
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'write_file', arguments: { path: '.Git/config', content: '[core]\n\thacked = true\n' } })
    });
    // Expected: 400 (should block git internals regardless of casing).
    // Actual in server.js: 200 (bypass vulnerability!).
    assert.strictEqual(res.status, 400, 'Expected write to .Git/config to be blocked with 400');
  });

  test('[RED TEST] 3.12 Case-insensitive Git hooks bypass on Windows/macOS: write_file to mixed-case ".git/Hooks/pre-commit"', async () => {
    // In server.js line 260: `rel.startsWith('.git/hooks/')` is strictly case-sensitive.
    // On Windows/macOS filesystem, `.git/Hooks/pre-commit` creates an executable hook!
    const res = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${srv.token}`
      },
      body: JSON.stringify({ name: 'write_file', arguments: { path: '.git/Hooks/pre-commit', content: '#!/bin/sh\ncalc.exe\n' } })
    });
    // Expected: 400 (should block git hooks regardless of casing).
    // Actual in server.js: 200 (bypass vulnerability!).
    assert.strictEqual(res.status, 400, 'Expected write to .git/Hooks/pre-commit to be blocked with 400');
  });
});

// ============================================================================
// 4. Token Rotation Mechanism (/api/rotate-token)
// ============================================================================
describe('4. Token Rotation Mechanism (/api/rotate-token)', () => {
  let srv;

  before(async () => {
    srv = await startServer();
  });

  after(async () => {
    if (srv) await srv.cleanup();
  });

  test('4.1 Rejects /api/rotate-token without x-easy-mcp-admin header with 401 Unauthorized', async () => {
    const res = await fetch(`${srv.baseUrl}/api/rotate-token`, { method: 'POST' });
    assert.strictEqual(res.status, 401);
  });

  test('4.2 Rotates token successfully with valid admin secret and immediately invalidates old token', async () => {
    const oldToken = srv.token;

    // Verify old token works before rotation
    const checkBefore = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${oldToken}`
      },
      body: JSON.stringify({ name: 'get_current_project' })
    });
    assert.strictEqual(checkBefore.status, 200);

    // Call /api/rotate-token
    const rotateRes = await fetch(`${srv.baseUrl}/api/rotate-token`, {
      method: 'POST',
      headers: { 'x-easy-mcp-admin': srv.adminSecret }
    });
    assert.strictEqual(rotateRes.status, 200);
    const rotateData = await rotateRes.json();
    assert.strictEqual(rotateData.success, true);
    assert.ok(rotateData.token && rotateData.token.length >= 32);
    const newToken = rotateData.token;
    assert.notStrictEqual(newToken, oldToken);

    // Verify OLD token is immediately rejected with 401
    const checkOld = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${oldToken}`
      },
      body: JSON.stringify({ name: 'get_current_project' })
    });
    assert.strictEqual(checkOld.status, 401, 'Old token must be rejected after rotation');

    // Verify NEW token immediately succeeds with 200
    const checkNew = await fetch(`${srv.baseUrl}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${newToken}`
      },
      body: JSON.stringify({ name: 'get_current_project' })
    });
    assert.strictEqual(checkNew.status, 200, 'New token must be accepted after rotation');
  });
});

// ============================================================================
// 5. OAuth 2.0 Authorization Boundary
// ============================================================================
describe('5. OAuth 2.0 Authorization Boundary', () => {
  let srv;

  before(async () => {
    srv = await startServer();
  });

  after(async () => {
    if (srv) await srv.cleanup();
  });

  test('[RED TEST] 5.1 /oauth/authorize must not issue authorization code without user authentication or master token', async () => {
    // Trust boundary: When REQUIRE_AUTH is true, access to MCP tools must require the master TOKEN.
    // Vulnerability in server.js:
    // 1. /oauth/register is public (no token needed).
    // 2. /oauth/authorize is public and automatically issues an authorization code without checking
    //    user authentication, session, cookie, or master token!
    // 3. /oauth/token exchanges that code for an access token.
    // 4. An attacker with NO KNOWLEDGE of master TOKEN gains full MCP tool access!

    // Step 1: Register client without authentication
    const regRes = await fetch(`${srv.baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://127.0.0.1:9999/callback'],
        token_endpoint_auth_method: 'none'
      })
    });
    assert.strictEqual(regRes.status, 201);
    const { client_id } = await regRes.json();

    // Step 2: Unauthenticated GET /oauth/authorize
    // Expected security control: Server should require login / master token / admin approval before issuing code.
    // Actual: Automatically responds with 302 redirect containing the code.
    const authRes = await fetch(
      `${srv.baseUrl}/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=http://127.0.0.1:9999/callback&code_challenge=pkce_test&code_challenge_method=plain`,
      { redirect: 'manual' }
    );

    // We assert that an unauthenticated request to /oauth/authorize must NOT issue a code (e.g. should return 401 or prompt login).
    // If it returns 302 with a code in the redirect Location, an attacker bypassed authentication completely!
    const location = authRes.headers.get('location') || '';
    const hasCode = location.includes('code=');

    assert.strictEqual(
      hasCode,
      false,
      'Vulnerability: /oauth/authorize auto-issued an authorization code to an unauthenticated request without master token or owner consent!'
    );
  });

  test('[RED TEST] 5.2 /oauth/authorize issues code when token is passed in resource indicator (ChatGPT connector flow)', async () => {
    // Register client
    const regRes = await fetch(`${srv.baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
        token_endpoint_auth_method: 'none'
      })
    });
    assert.strictEqual(regRes.status, 201);
    const { client_id } = await regRes.json();

    // GET /oauth/authorize with resource containing the valid token in /mcp/<token> path
    const resourceUrl = `${srv.baseUrl}/mcp/${srv.token}`;
    const authUrl = `${srv.baseUrl}/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=https://chatgpt.com/connector/oauth/callback&code_challenge=pkce_test&code_challenge_method=plain&resource=${encodeURIComponent(resourceUrl)}`;

    const authRes = await fetch(authUrl, { redirect: 'manual' });
    // Expected: 302 Found redirecting to callback with code
    assert.strictEqual(authRes.status, 302, 'Should authorize and redirect with 302 when valid token is in resource');
    const location = authRes.headers.get('location') || '';
    assert.ok(location.startsWith('https://chatgpt.com/connector/oauth/callback'), 'Should redirect to redirect_uri');
    assert.ok(location.includes('code='), 'Redirect URL must contain authorization code');
  });
});
