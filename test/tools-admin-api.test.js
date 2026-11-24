'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

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

describe('Tools & Admin APIs Regression Suite', () => {
  let serverProcess;
  let baseUrl;
  let port;
  const token = 'test_token_tools_admin_12345';
  let testHome;
  let testProj;
  let adminSecret;

  before(async () => {
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-tools-home-'));
    testProj = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-tools-proj-'));

    // Initialize git repository in testProj
    try {
      execFileSync('git', ['init'], { cwd: testProj, windowsHide: true });
      execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: testProj, windowsHide: true });
      execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: testProj, windowsHide: true });
      fs.writeFileSync(path.join(testProj, 'README.md'), '# Initial README\n');
      execFileSync('git', ['add', 'README.md'], { cwd: testProj, windowsHide: true });
      execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: testProj, windowsHide: true });
    } catch {}

    const env = {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      EASY_MCP_PORT: String(port),
      EASY_MCP_TOKEN: token,
      EASY_MCP_PROJECT: testProj,
      EASY_MCP_TUNNEL: 'none',
      EASY_MCP_ENABLE_SHELL: '1',
      EASY_MCP_REQUIRE_AUTH: '1'
    };

    const serverScript = path.resolve(__dirname, '..', 'server.js');
    serverProcess = spawn(process.execPath, [serverScript, '--enable-shell'], { env, stdio: ['ignore', 'pipe', 'pipe'] });

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

    const dashRes = await fetch(`${baseUrl}/`);
    const html = await dashRes.text();
    adminSecret = html.match(/const ADMIN = ['"]([a-f0-9]+)['"];/)?.[1];
    assert.ok(adminSecret, 'Admin secret must be present in dashboard HTML');
  });

  after(async () => {
    await stopServer(serverProcess);
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(testProj, { recursive: true, force: true }); } catch {}
  });

  async function callMcpTool(name, toolArgs) {
    const res = await fetch(`${baseUrl}/mcp?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name, arguments: toolArgs }
      })
    });
    const data = await res.json();
    return data.result;
  }

  test('1. git_status: reports untracked/modified files in git repository', async () => {
    fs.writeFileSync(path.join(testProj, 'new_untracked.txt'), 'hello untracked\n');
    const result = await callMcpTool('git_status', {});
    assert.strictEqual(result.isError, false);
    const text = result.content[0].text;
    assert.ok(text.includes('new_untracked.txt') || text.includes('??'), `Expected untracked file but got: ${text}`);
  });

  test('2. git_diff: reports modified line diff in git repository', async () => {
    fs.appendFileSync(path.join(testProj, 'README.md'), 'Modified line for diff\n');
    const result = await callMcpTool('git_diff', { path: 'README.md' });
    assert.strictEqual(result.isError, false);
    const text = result.content[0].text;
    assert.ok(text.includes('+Modified line for diff'), `Expected diff to contain added line: ${text}`);
  });

  test('3. fetch_url: rejects non-https URLs and private/loopback hosts', async () => {
    // 3.1 Non-https
    const httpRes = await callMcpTool('fetch_url', { url: 'http://example.com' });
    assert.strictEqual(httpRes.isError, true);
    assert.ok(httpRes.content[0].text.includes('Only https:// URLs are allowed'));

    // 3.2 Private/loopback host
    const loopbackRes = await callMcpTool('fetch_url', { url: 'https://127.0.0.1/secret' });
    assert.strictEqual(loopbackRes.isError, true);
    assert.ok(loopbackRes.content[0].text.includes('Blocked: private/loopback'));
  });

  test('4. GET /api/dashboard & GET /api/status: return valid dashboard telemetry', async () => {
    // 4.1 /api/dashboard
    const dashRes = await fetch(`${baseUrl}/api/dashboard`, {
      headers: { 'x-easy-mcp-admin': adminSecret }
    });
    assert.strictEqual(dashRes.status, 200);
    const dashData = await dashRes.json();
    assert.strictEqual(dashData.project, testProj);
    assert.ok(dashData.toolsCount >= 10);
    assert.ok(typeof dashData.totalCalls === 'number');
    assert.ok(typeof dashData.totalErrors === 'number');

    // 4.2 /api/status
    const statusRes = await fetch(`${baseUrl}/api/status`, {
      headers: { 'x-easy-mcp-admin': adminSecret }
    });
    assert.strictEqual(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.strictEqual(statusData.project, testProj);
    assert.ok(typeof statusData.uptimeSec === 'number');
  });

  test('5. POST /api/set-project: switches active project directory', async () => {
    const secondProj = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-tools-second-'));
    try {
      const switchRes = await fetch(`${baseUrl}/api/set-project`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-easy-mcp-admin': adminSecret
        },
        body: JSON.stringify({ path: secondProj })
      });
      assert.strictEqual(switchRes.status, 200);
      const json = await switchRes.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.project, secondProj);

      // Verify dashboard now reflects secondProj
      const checkRes = await fetch(`${baseUrl}/api/status`, {
        headers: { 'x-easy-mcp-admin': adminSecret }
      });
      const checkData = await checkRes.json();
      assert.strictEqual(checkData.project, secondProj);

      // Verify non-existent folder returns 400
      const badRes = await fetch(`${baseUrl}/api/set-project`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-easy-mcp-admin': adminSecret
        },
        body: JSON.stringify({ path: path.join(os.tmpdir(), 'non_existent_folder_xyz_123') })
      });
      assert.strictEqual(badRes.status, 400);
      const badJson = await badRes.json();
      assert.strictEqual(badJson.success, false);
    } finally {
      try { fs.rmSync(secondProj, { recursive: true, force: true }); } catch {}
    }
  });

  test('6. POST /api/set-tunnel & POST /api/set-public-url: updates tunnel configuration', async () => {
    // 6.1 Set tunnel mode to 'none'
    const tunRes = await fetch(`${baseUrl}/api/set-tunnel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-easy-mcp-admin': adminSecret
      },
      body: JSON.stringify({ mode: 'none' })
    });
    assert.strictEqual(tunRes.status, 200);
    const tunData = await tunRes.json();
    assert.strictEqual(tunData.tunnelMode, 'none');

    // 6.2 Set custom public URL
    const pubRes = await fetch(`${baseUrl}/api/set-public-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-easy-mcp-admin': adminSecret
      },
      body: JSON.stringify({ url: 'https://my-custom-mcp-domain.com' })
    });
    assert.strictEqual(pubRes.status, 200);
    const pubData = await pubRes.json();
    assert.strictEqual(pubData.success, true);
    assert.strictEqual(pubData.publicUrl, 'https://my-custom-mcp-domain.com');

    // 6.3 Rejects non-https custom URL
    const badPubRes = await fetch(`${baseUrl}/api/set-public-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-easy-mcp-admin': adminSecret
      },
      body: JSON.stringify({ url: 'http://insecure-domain.com' })
    });
    assert.strictEqual(badPubRes.status, 400);
  });
});
