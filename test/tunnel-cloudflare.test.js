'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
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

describe('Cloudflare Persistent Domain (9router port)', () => {
  let mockWorker;
  let mockWorkerPort;
  let mockWorkerUrl;
  let registrations = [];

  before(async () => {
    mockWorkerPort = await getFreePort();
    mockWorkerUrl = `http://127.0.0.1:${mockWorkerPort}`;
    mockWorker = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/tunnel/register') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            registrations.push(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success', shortId: data.shortId, tunnelUrl: data.tunnelUrl }));
          } catch (err) {
            res.writeHead(400);
            res.end(err.message);
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise(resolve => mockWorker.listen(mockWorkerPort, '127.0.0.1', resolve));
  });

  after(() => {
    if (mockWorker) mockWorker.close();
  });

  test('1. Generates and persists 6-char shortId in ~/.easy-mcp/config.json', async () => {
    const port = await getFreePort();
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-tun-home-'));
    const testProj = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-tun-proj-'));
    const token = 'test_token_cloudflare_persistent_123';

    const env = {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      EASY_MCP_PORT: String(port),
      EASY_MCP_TOKEN: token,
      EASY_MCP_PROJECT: testProj,
      EASY_MCP_TUNNEL: 'none',
      EASY_MCP_WORKER_URL: mockWorkerUrl,
      EASY_MCP_REQUIRE_AUTH: '1'
    };

    const serverArgs = [path.resolve(__dirname, '..', 'server.js')];
    const child = spawn(process.execPath, serverArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Server start timed out')), 8000);
        child.stdout.on('data', d => {
          if (d.toString().includes('Easy MCP server on')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('error', err => { clearTimeout(timer); reject(err); });
      });

      const res = await fetch(`http://127.0.0.1:${port}/mcp?token=${token}`);
      assert.strictEqual(res.status, 200);

      // When tunnelMode is 'none', let's test switching tunnel to 'cloudflare' via admin API
      // First read admin secret from dashboard HTML
      const dashRes = await fetch(`http://127.0.0.1:${port}/`);
      const html = await dashRes.text();
      const adminSecret = html.match(/const ADMIN = ['"]([a-f0-9]+)['"];/)?.[1];
      assert.ok(adminSecret, 'Admin secret must be present in dashboard HTML');

      // Call /api/set-tunnel with mode: cloudflare
      const setRes = await fetch(`http://127.0.0.1:${port}/api/set-tunnel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-easy-mcp-admin': adminSecret
        },
        body: JSON.stringify({ mode: 'cloudflare' })
      });
      assert.strictEqual(setRes.status, 200);

      // Verify shortId format in config
      const cfgPath = path.join(testHome, '.easy-mcp', 'config.json');
      assert.ok(fs.existsSync(cfgPath), 'config.json must exist');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      assert.ok(cfg.shortId, 'config.json must contain shortId');
      assert.match(cfg.shortId, /^[a-z0-9]{6}$/, 'shortId must be 6 alphanumeric chars');
    } finally {
      await stopServer(child);
    }
  });

  test('2. Directly registers shortId and tunnelUrl with 9router worker endpoint', async () => {
    const testShortId = 'x9k2p4';
    const testTunnelUrl = 'https://unit-test-tunnel.trycloudflare.com';

    const res = await fetch(`${mockWorkerUrl}/api/tunnel/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortId: testShortId, tunnelUrl: testTunnelUrl })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'success');
    assert.strictEqual(data.shortId, testShortId);
    assert.strictEqual(data.tunnelUrl, testTunnelUrl);
    assert.strictEqual(registrations.length, 1);
  });
});
