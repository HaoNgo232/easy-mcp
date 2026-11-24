'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFile } = require('node:child_process');
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

describe('Jobs & Shell Execution Regression Suite', () => {
  let serverProcess;
  let baseUrl;
  let port;
  const token = 'test_token_jobs_shell_12345';
  let testHome;
  let testProj;
  let adminSecret;

  before(async () => {
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-jobs-home-'));
    testProj = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-jobs-proj-'));

    // Create helper test files in project folder
    fs.writeFileSync(path.join(testProj, 'canary.txt'), 'canary_in_project_root');
    fs.writeFileSync(path.join(testProj, 'fail.js'), 'console.error("custom_error_msg"); process.exit(42);\n');
    fs.writeFileSync(path.join(testProj, 'worker.js'), 'let c = 0; setInterval(() => { console.log("tick_" + (++c)); if (c >= 10) process.exit(0); }, 150);\n');
    fs.writeFileSync(path.join(testProj, 'keepalive.js'), 'setInterval(() => console.log("keepalive"), 200);\n');

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

    // Extract admin secret from dashboard HTML
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

  test('1. execute_command: runs shell command and captures stdout & exit code 0', async () => {
    const cmd = 'node -p 1234+5678';
    const result = await callMcpTool('execute_command', { command: cmd });
    assert.strictEqual(result.isError, false);
    const text = result.content[0].text;
    assert.ok(text.includes('Exit code: 0'), `Expected exit code 0 but got: ${text}`);
    assert.ok(text.includes('6912'), `Expected 6912 but got: ${text}`);
  });

  test('2. execute_command: captures stderr output and non-zero exit code', async () => {
    const cmd = 'node fail.js';
    const result = await callMcpTool('execute_command', { command: cmd });
    assert.strictEqual(result.isError, false);
    const text = result.content[0].text;
    assert.ok(text.includes('Exit code: 42'), `Expected exit code 42 but got: ${text}`);
    assert.ok(text.includes('custom_error_msg'), `Expected custom_error_msg but got: ${text}`);
  });

  test('3. execute_command: executes in project folder (cwd check)', async () => {
    const cmd = process.platform === 'win32' ? 'dir canary.txt' : 'ls canary.txt';
    const result = await callMcpTool('execute_command', { command: cmd });
    assert.strictEqual(result.isError, false);
    const text = result.content[0].text;
    assert.ok(text.includes('Exit code: 0'), `Expected exit code 0 but got: ${text}`);
    assert.ok(text.includes('canary.txt'), `Expected canary.txt in output but got: ${text}`);
  });

  test('4. start_job & job_status: background process execution and log streaming', async () => {
    const startRes = await callMcpTool('start_job', { command: 'node worker.js' });
    assert.strictEqual(startRes.isError, false);
    const startText = startRes.content[0].text;
    assert.ok(startText.includes('Started job-'), `Expected Started job- but got: ${startText}`);
    const jobId = startText.match(/(job-\d+)/)?.[1];
    assert.ok(jobId, 'Must return a valid job id');

    // Wait a brief moment for worker ticks
    await new Promise(r => setTimeout(r, 600));

    // Poll job_status
    const statusRes = await callMcpTool('job_status', { id: jobId });
    assert.strictEqual(statusRes.isError, false);
    const statusText = statusRes.content[0].text;
    assert.ok(statusText.includes(jobId));
    assert.ok(statusText.includes('tick_1'), `Expected tick_1 in status output: ${statusText}`);

    // Check list_jobs
    const listRes = await callMcpTool('list_jobs', {});
    assert.strictEqual(listRes.isError, false);
    assert.ok(listRes.content[0].text.includes(jobId));

    // Stop job via stop_job tool
    const stopRes = await callMcpTool('stop_job', { id: jobId });
    assert.strictEqual(stopRes.isError, false);
    assert.ok(stopRes.content[0].text.includes(`Stopped ${jobId}`));

    // Verify job status is now stopped
    const afterStopRes = await callMcpTool('job_status', { id: jobId });
    assert.ok(afterStopRes.content[0].text.includes('stopped'));
  });

  test('5. /api/stop-job: terminates a running job via dashboard HTTP API', async () => {
    const startRes = await callMcpTool('start_job', { command: 'node keepalive.js' });
    const jobId = startRes.content[0].text.match(/(job-\d+)/)?.[1];
    assert.ok(jobId);

    // Call /api/stop-job
    const stopApiRes = await fetch(`${baseUrl}/api/stop-job`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-easy-mcp-admin': adminSecret
      },
      body: JSON.stringify({ id: jobId })
    });
    assert.strictEqual(stopApiRes.status, 200);
    const json = await stopApiRes.json();
    assert.strictEqual(json.success, true);

    // Verify status is stopped
    const statusRes = await callMcpTool('job_status', { id: jobId });
    assert.ok(statusRes.content[0].text.includes('stopped'));
  });
});
