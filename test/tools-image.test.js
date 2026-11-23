'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');

// ---------------------------------------------------------------------------
// Test Assets: Minimal Valid Image Buffers
// ---------------------------------------------------------------------------

// 1x1 Transparent PNG
const SAMPLE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
);

// 1x1 Minimal JPEG
const SAMPLE_JPEG = Buffer.from(
  'ffd8ffe000104a46494600010101006000600000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bda0008010100003f007f00ffd9',
  'hex'
);

// 1x1 Minimal GIF89a
const SAMPLE_GIF89A = Buffer.from(
  '47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b',
  'hex'
);

// 1x1 Minimal GIF87a
const SAMPLE_GIF87A = Buffer.from(
  '47494638376101000100800000ffffff0000002c00000000010001000002024401003b',
  'hex'
);

// Minimal Valid WebP (RIFF...WEBP)
const SAMPLE_WEBP = Buffer.from(
  '524946461a000000574542505650384c0d0000002f00000010071011118888fe0700',
  'hex'
);

// Minimal BMP (Unsupported format for MCP image)
const SAMPLE_BMP = Buffer.from(
  '424d1e000000000000001a0000000c00000001000100010018000000ffffffff0000',
  'hex'
);

// ---------------------------------------------------------------------------
// Test Server Harness Helpers
// ---------------------------------------------------------------------------

function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function httpRequest({ port, path: reqPath, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ statusCode: res.statusCode, headers: res.headers, raw: data, json });
        });
      }
    );
    req.on('error', reject);
    if (body) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        req.write(body);
      } else {
        req.write(JSON.stringify(body));
      }
    }
    req.end();
  });
}

describe('Easy MCP QA Test Suite: Tools, Image Handling & Security Switches', () => {
  let serverProcess = null;
  let serverPort = null;
  let serverToken = 'test-qa-token-' + Math.random().toString(36).slice(2);
  let adminSecret = null;
  let testProjectDir = null;
  let outsideDir = null;
  let rpcSeq = 0;

  async function mcpCall(name, toolArgs) {
    const payload = {
      jsonrpc: '2.0',
      id: ++rpcSeq,
      method: 'tools/call',
      params: { name, arguments: toolArgs }
    };
    const bodyStr = JSON.stringify(payload);
    const res = await httpRequest({
      port: serverPort,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + serverToken,
        'Content-Length': Buffer.byteLength(bodyStr)
      },
      body: bodyStr
    });
    return res.json;
  }

  async function mcpList() {
    const payload = {
      jsonrpc: '2.0',
      id: ++rpcSeq,
      method: 'tools/list'
    };
    const bodyStr = JSON.stringify(payload);
    const res = await httpRequest({
      port: serverPort,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + serverToken,
        'Content-Length': Buffer.byteLength(bodyStr)
      },
      body: bodyStr
    });
    return res.json;
  }

  async function directCall(name, toolArgs) {
    const payload = { name, arguments: toolArgs };
    const bodyStr = JSON.stringify(payload);
    const res = await httpRequest({
      port: serverPort,
      path: '/call',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + serverToken,
        'Content-Length': Buffer.byteLength(bodyStr)
      },
      body: bodyStr
    });
    return res.json;
  }

  async function updateSettings(settings) {
    const bodyStr = JSON.stringify(settings);
    const res = await httpRequest({
      port: serverPort,
      path: '/api/settings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-easy-mcp-admin': adminSecret,
        'Content-Length': Buffer.byteLength(bodyStr)
      },
      body: bodyStr
    });
    return res.json;
  }

  async function getSettings() {
    const res = await httpRequest({
      port: serverPort,
      path: '/api/settings',
      method: 'GET',
      headers: {
        'x-easy-mcp-admin': adminSecret
      }
    });
    return res.json;
  }

  before(async () => {
    serverPort = await getFreePort();
    testProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-qa-project-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-mcp-qa-outside-'));

    // Create an outside secret file for path-jail verification
    fs.writeFileSync(path.join(outsideDir, 'secret_outside.txt'), 'SUPER_SECRET_EXTERNAL_CONTENT');

    // Spawn server.js with clean isolated environment
    const serverScript = path.resolve(__dirname, '..', 'server.js');
    serverProcess = spawn(process.execPath, [serverScript], {
      env: {
        ...process.env,
        EASY_MCP_PORT: String(serverPort),
        EASY_MCP_TOKEN: serverToken,
        EASY_MCP_TUNNEL: 'none',
        EASY_MCP_PROJECT: testProjectDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      serverProcess.stdout.on('data', (d) => {
        const text = d.toString();
        if (text.includes('Easy MCP server on')) {
          settled = true;
          resolve();
        }
      });
      serverProcess.stderr.on('data', (d) => {
        // stderr log
      });
      serverProcess.on('exit', (code) => {
        if (!settled) reject(new Error('Server exited unexpectedly with code ' + code));
      });
      setTimeout(() => {
        if (!settled) reject(new Error('Timed out waiting for Easy MCP server to start'));
      }, 10000);
    });

    // Extract admin secret from dashboard HTML
    const dashRes = await httpRequest({
      port: serverPort,
      path: `/?token=${serverToken}`,
      method: 'GET'
    });
    const match = dashRes.raw.match(/const ADMIN = '([a-f0-9]+)';/);
    assert.ok(match, 'Admin secret must be present in dashboard HTML');
    adminSecret = match[1];
  });

  after(() => {
    if (serverProcess) {
      try {
        serverProcess.kill();
      } catch {}
    }
    if (testProjectDir) {
      try {
        fs.rmSync(testProjectDir, { recursive: true, force: true });
      } catch {}
    }
    if (outsideDir) {
      try {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // =========================================================================
  // 1. File Tools
  // =========================================================================
  describe('1. File Tools', () => {
    it('write_file: creates a new text file and returns byte count', async () => {
      const content = 'Hello, Easy MCP!\nTesting write_file.';
      const res = await mcpCall('write_file', { path: 'test_write.txt', content });
      assert.strictEqual(res.result.isError, false);
      const text = res.result.content[0].text;
      assert.match(text, /Wrote test_write\.txt/);
      assert.match(text, new RegExp(`${Buffer.byteLength(content)} bytes`));

      const saved = fs.readFileSync(path.join(testProjectDir, 'test_write.txt'), 'utf8');
      assert.strictEqual(saved, content);
    });

    it('write_file: recursively creates parent directories for nested paths', async () => {
      const content = 'Nested directory test';
      const res = await mcpCall('write_file', { path: 'nested/dir/deep/file.txt', content });
      assert.strictEqual(res.result.isError, false);
      assert.match(res.result.content[0].text, /Wrote nested\/dir\/deep\/file\.txt/);

      const saved = fs.readFileSync(path.join(testProjectDir, 'nested', 'dir', 'deep', 'file.txt'), 'utf8');
      assert.strictEqual(saved, content);
    });

    it('write_file: overwrites existing file content', async () => {
      const initial = 'initial content';
      const updated = 'updated new content';
      await mcpCall('write_file', { path: 'overwrite.txt', content: initial });
      const res = await mcpCall('write_file', { path: 'overwrite.txt', content: updated });
      assert.strictEqual(res.result.isError, false);

      const saved = fs.readFileSync(path.join(testProjectDir, 'overwrite.txt'), 'utf8');
      assert.strictEqual(saved, updated);
    });

    it('write_files: batch creates/overwrites multiple files', async () => {
      const files = [
        { path: 'batch/a.txt', content: 'Batch file A' },
        { path: 'batch/b.txt', content: 'Batch file B' },
        { path: 'batch/c.txt', content: 'Batch file C' }
      ];
      const res = await mcpCall('write_files', { files });
      assert.strictEqual(res.result.isError, false);
      const output = res.result.content[0].text;
      assert.match(output, /Wrote batch\/a\.txt/);
      assert.match(output, /Wrote batch\/b\.txt/);
      assert.match(output, /Wrote batch\/c\.txt/);

      assert.strictEqual(fs.readFileSync(path.join(testProjectDir, 'batch', 'a.txt'), 'utf8'), 'Batch file A');
      assert.strictEqual(fs.readFileSync(path.join(testProjectDir, 'batch', 'b.txt'), 'utf8'), 'Batch file B');
      assert.strictEqual(fs.readFileSync(path.join(testProjectDir, 'batch', 'c.txt'), 'utf8'), 'Batch file C');
    });

    it('read_file: reads text file with line numbers and file header', async () => {
      const content = 'First Line\nSecond Line\nThird Line';
      fs.writeFileSync(path.join(testProjectDir, 'sample_read.txt'), content);

      const res = await mcpCall('read_file', { path: 'sample_read.txt' });
      assert.strictEqual(res.result.isError, false);
      const text = res.result.content[0].text;
      assert.match(text, /File: sample_read\.txt \(3 lines\)/);
      assert.match(text, /1 \| First Line/);
      assert.match(text, /2 \| Second Line/);
      assert.match(text, /3 \| Third Line/);
    });

    it('read_file: reads file in nested subdirectory', async () => {
      const content = 'deep nested line';
      fs.mkdirSync(path.join(testProjectDir, 'deeply', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(testProjectDir, 'deeply', 'nested', 'doc.txt'), content);

      const res = await mcpCall('read_file', { path: 'deeply/nested/doc.txt' });
      assert.strictEqual(res.result.isError, false);
      assert.match(res.result.content[0].text, /File: deeply\/nested\/doc\.txt/);
      assert.match(res.result.content[0].text, /1 \| deep nested line/);
    });

    it('read_file: throws error when reading non-existent file', async () => {
      const res = await mcpCall('read_file', { path: 'missing_file.txt' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Error: ENOENT/);
    });

    it('read_files: reads multiple text files and concatenates output', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'multi1.txt'), 'Content of Multi 1');
      fs.writeFileSync(path.join(testProjectDir, 'multi2.txt'), 'Content of Multi 2');

      const res = await mcpCall('read_files', { paths: ['multi1.txt', 'multi2.txt'] });
      assert.strictEqual(res.result.isError, false);
      const text = res.result.content[0].text;
      assert.match(text, /===== multi1\.txt =====\nContent of Multi 1/);
      assert.match(text, /===== multi2\.txt =====\nContent of Multi 2/);
    });

    it('read_files: handles non-existent file gracefully alongside valid files', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'valid.txt'), 'Valid file text');

      const res = await mcpCall('read_files', { paths: ['valid.txt', 'non_existent.txt'] });
      assert.strictEqual(res.result.isError, false);
      const text = res.result.content[0].text;
      assert.match(text, /===== valid\.txt =====\nValid file text/);
      assert.match(text, /===== non_existent\.txt =====\n\[error\] ENOENT/);
    });

    it('edit_file: replaces exact text snippet in the middle', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'edit_mid.txt'), 'Hello Beautiful World');
      const res = await mcpCall('edit_file', {
        path: 'edit_mid.txt',
        old_text: 'Beautiful',
        new_text: 'Wonderful'
      });
      assert.strictEqual(res.result.isError, false);
      assert.match(res.result.content[0].text, /Edited edit_mid\.txt/);

      const updated = fs.readFileSync(path.join(testProjectDir, 'edit_mid.txt'), 'utf8');
      assert.strictEqual(updated, 'Hello Wonderful World');
    });

    it('edit_file: replaces exact text snippet at the start of the file', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'edit_start.txt'), 'Alpha Beta Gamma');
      const res = await mcpCall('edit_file', {
        path: 'edit_start.txt',
        old_text: 'Alpha',
        new_text: 'Omega'
      });
      assert.strictEqual(res.result.isError, false);

      const updated = fs.readFileSync(path.join(testProjectDir, 'edit_start.txt'), 'utf8');
      assert.strictEqual(updated, 'Omega Beta Gamma');
    });

    it('edit_file: replaces exact text snippet at the end of the file', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'edit_end.txt'), 'Start Middle Finish');
      const res = await mcpCall('edit_file', {
        path: 'edit_end.txt',
        old_text: 'Finish',
        new_text: 'Complete'
      });
      assert.strictEqual(res.result.isError, false);

      const updated = fs.readFileSync(path.join(testProjectDir, 'edit_end.txt'), 'utf8');
      assert.strictEqual(updated, 'Start Middle Complete');
    });

    it('edit_file: throws error when old_text is not found', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'edit_miss.txt'), 'Some content here');
      const res = await mcpCall('edit_file', {
        path: 'edit_miss.txt',
        old_text: 'NotFoundString',
        new_text: 'Replacement'
      });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Error: old_text not found/);
    });

    it('edit_file: throws error when old_text is not unique (multiple occurrences)', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'edit_dup.txt'), 'repeat repeat repeat');
      const res = await mcpCall('edit_file', {
        path: 'edit_dup.txt',
        old_text: 'repeat',
        new_text: 'single'
      });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Error: old_text is not unique/);
    });

    it('edit_file: throws error when old_text has overlapping occurrences', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'edit_overlap.txt'), 'aaaa');
      const res = await mcpCall('edit_file', {
        path: 'edit_overlap.txt',
        old_text: 'aa',
        new_text: 'bb'
      });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Error: old_text is not unique/);
    });

    it('edit_file: rejects empty snippet (old_text: "") on empty file with "old_text is not unique"', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'empty_boundary.txt'), '');
      const res = await mcpCall('edit_file', {
        path: 'empty_boundary.txt',
        old_text: '',
        new_text: 'injected_text'
      });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Error: old_text is not unique/);
    });

    it('list_directory: lists directory contents with [FILE] and [DIR] markers', async () => {
      const listSubdir = path.join(testProjectDir, 'list_test_dir');
      fs.mkdirSync(path.join(listSubdir, 'subfolder'), { recursive: true });
      fs.writeFileSync(path.join(listSubdir, 'item1.txt'), '12345');

      const res = await mcpCall('list_directory', { path: 'list_test_dir' });
      assert.strictEqual(res.result.isError, false);
      const text = res.result.content[0].text;
      assert.match(text, /Directory: list_test_dir/);
      assert.match(text, /\[DIR\]\s+subfolder\//);
      assert.match(text, /\[FILE\]\s+item1\.txt \(5 bytes\)/);
    });

    it('list_directory: returns (empty) for an empty directory', async () => {
      const emptySubdir = path.join(testProjectDir, 'empty_dir');
      fs.mkdirSync(emptySubdir, { recursive: true });

      const res = await mcpCall('list_directory', { path: 'empty_dir' });
      assert.strictEqual(res.result.isError, false);
      assert.match(res.result.content[0].text, /\(empty\)/);
    });

    it('search_files: finds matching text across project files with line numbers', async () => {
      const searchDir = path.join(testProjectDir, 'search_folder');
      fs.mkdirSync(searchDir, { recursive: true });
      fs.writeFileSync(path.join(searchDir, 'f1.txt'), 'foo\nTARGET_MATCH_STRING\nbar');
      fs.writeFileSync(path.join(searchDir, 'f2.txt'), 'first\nsecond\nTARGET_MATCH_STRING line');

      const res = await mcpCall('search_files', { query: 'TARGET_MATCH_STRING', path: 'search_folder' });
      assert.strictEqual(res.result.isError, false);
      const text = res.result.content[0].text;
      assert.match(text, /search_folder\/f1\.txt:2: TARGET_MATCH_STRING/);
      assert.match(text, /search_folder\/f2\.txt:3: TARGET_MATCH_STRING line/);
    });

    it('search_files: returns "No matches." when query does not match', async () => {
      const res = await mcpCall('search_files', { query: 'NON_EXISTENT_QUERY_99999' });
      assert.strictEqual(res.result.isError, false);
      assert.strictEqual(res.result.content[0].text, 'No matches.');
    });

    it('search_files: respects path parameter to restrict search scope', async () => {
      const dirA = path.join(testProjectDir, 'scope_a');
      const dirB = path.join(testProjectDir, 'scope_b');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });
      fs.writeFileSync(path.join(dirA, 'file.txt'), 'SCOPE_KEYWORD in A');
      fs.writeFileSync(path.join(dirB, 'file.txt'), 'SCOPE_KEYWORD in B');

      const res = await mcpCall('search_files', { query: 'SCOPE_KEYWORD', path: 'scope_a' });
      assert.strictEqual(res.result.isError, false);
      assert.match(res.result.content[0].text, /scope_a\/file\.txt/);
      assert.doesNotMatch(res.result.content[0].text, /scope_b\/file\.txt/);
    });

    it('search_files: skips files larger than 2MB', async () => {
      const searchDir = path.join(testProjectDir, 'search_large');
      fs.mkdirSync(searchDir, { recursive: true });
      const largeFile = path.join(searchDir, 'large.txt');

      // Create a file > 2MB containing the keyword
      const fd = fs.openSync(largeFile, 'w');
      fs.writeSync(fd, 'SKIP_LARGE_KEYWORD\n');
      fs.ftruncateSync(fd, 2 * 1024 * 1024 + 1024);
      fs.closeSync(fd);

      const res = await mcpCall('search_files', { query: 'SKIP_LARGE_KEYWORD', path: 'search_large' });
      assert.strictEqual(res.result.isError, false);
      assert.strictEqual(res.result.content[0].text, 'No matches.');
    });

    it('get_file_info: returns JSON with type "file", size, and timestamps', async () => {
      const filePath = path.join(testProjectDir, 'info_file.txt');
      fs.writeFileSync(filePath, '1234567890');

      const res = await mcpCall('get_file_info', { path: 'info_file.txt' });
      assert.strictEqual(res.result.isError, false);
      const info = JSON.parse(res.result.content[0].text);
      assert.strictEqual(info.path, 'info_file.txt');
      assert.strictEqual(info.type, 'file');
      assert.strictEqual(info.size, 10);
      assert.ok(info.modified);
      assert.ok(info.created);
    });

    it('get_file_info: returns JSON with type "directory" for directories', async () => {
      const dirPath = path.join(testProjectDir, 'info_dir');
      fs.mkdirSync(dirPath, { recursive: true });

      const res = await mcpCall('get_file_info', { path: 'info_dir' });
      assert.strictEqual(res.result.isError, false);
      const info = JSON.parse(res.result.content[0].text);
      assert.strictEqual(info.path, 'info_dir');
      assert.strictEqual(info.type, 'directory');
    });
  });

  // =========================================================================
  // 2. Image Handling & Format Verification
  // =========================================================================
  describe('2. Image Handling & Format Verification', () => {
    it('read_file: reads valid PNG image and returns base64 + image/png', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'image.png'), SAMPLE_PNG);

      const res = await mcpCall('read_file', { path: 'image.png' });
      assert.strictEqual(res.result.isError, false);
      assert.strictEqual(res.result.content.length, 1);
      const item = res.result.content[0];
      assert.strictEqual(item.type, 'image');
      assert.strictEqual(item.mimeType, 'image/png');
      assert.strictEqual(typeof item.data, 'string');
    });

    it('read_file: decodes base64 PNG data and matches exact binary content', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'verify.png'), SAMPLE_PNG);

      const res = await mcpCall('read_file', { path: 'verify.png' });
      assert.strictEqual(res.result.isError, false);
      const decodedBuffer = Buffer.from(res.result.content[0].data, 'base64');
      assert.ok(decodedBuffer.equals(SAMPLE_PNG), 'Decoded base64 must match original PNG byte-for-byte');
    });

    it('read_file: reads valid JPEG image (.jpg and .jpeg) and returns image/jpeg', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'photo.jpg'), SAMPLE_JPEG);
      fs.writeFileSync(path.join(testProjectDir, 'photo.jpeg'), SAMPLE_JPEG);

      const resJpg = await mcpCall('read_file', { path: 'photo.jpg' });
      assert.strictEqual(resJpg.result.isError, false);
      assert.strictEqual(resJpg.result.content[0].type, 'image');
      assert.strictEqual(resJpg.result.content[0].mimeType, 'image/jpeg');
      assert.ok(Buffer.from(resJpg.result.content[0].data, 'base64').equals(SAMPLE_JPEG));

      const resJpeg = await mcpCall('read_file', { path: 'photo.jpeg' });
      assert.strictEqual(resJpeg.result.isError, false);
      assert.strictEqual(resJpeg.result.content[0].type, 'image');
      assert.strictEqual(resJpeg.result.content[0].mimeType, 'image/jpeg');
      assert.ok(Buffer.from(resJpeg.result.content[0].data, 'base64').equals(SAMPLE_JPEG));
    });

    it('read_file: reads valid GIF image (GIF87a / GIF89a) and returns image/gif', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'anim89.gif'), SAMPLE_GIF89A);
      fs.writeFileSync(path.join(testProjectDir, 'anim87.gif'), SAMPLE_GIF87A);

      const res89 = await mcpCall('read_file', { path: 'anim89.gif' });
      assert.strictEqual(res89.result.isError, false);
      assert.strictEqual(res89.result.content[0].type, 'image');
      assert.strictEqual(res89.result.content[0].mimeType, 'image/gif');
      assert.ok(Buffer.from(res89.result.content[0].data, 'base64').equals(SAMPLE_GIF89A));

      const res87 = await mcpCall('read_file', { path: 'anim87.gif' });
      assert.strictEqual(res87.result.isError, false);
      assert.strictEqual(res87.result.content[0].type, 'image');
      assert.strictEqual(res87.result.content[0].mimeType, 'image/gif');
      assert.ok(Buffer.from(res87.result.content[0].data, 'base64').equals(SAMPLE_GIF87A));
    });

    it('read_file: reads valid WebP image (RIFF...WEBP) and returns image/webp', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'graphic.webp'), SAMPLE_WEBP);

      const res = await mcpCall('read_file', { path: 'graphic.webp' });
      assert.strictEqual(res.result.isError, false);
      assert.strictEqual(res.result.content[0].type, 'image');
      assert.strictEqual(res.result.content[0].mimeType, 'image/webp');
      assert.ok(Buffer.from(res.result.content[0].data, 'base64').equals(SAMPLE_WEBP));
    });

    it('read_file: handles uppercase extensions (.PNG, .JPG, .JPEG, .GIF, .WEBP)', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'UPPER.PNG'), SAMPLE_PNG);
      fs.writeFileSync(path.join(testProjectDir, 'UPPER.JPG'), SAMPLE_JPEG);
      fs.writeFileSync(path.join(testProjectDir, 'UPPER.JPEG'), SAMPLE_JPEG);
      fs.writeFileSync(path.join(testProjectDir, 'UPPER.GIF'), SAMPLE_GIF89A);
      fs.writeFileSync(path.join(testProjectDir, 'UPPER.WEBP'), SAMPLE_WEBP);

      const resPng = await mcpCall('read_file', { path: 'UPPER.PNG' });
      assert.strictEqual(resPng.result.content[0].mimeType, 'image/png');

      const resJpg = await mcpCall('read_file', { path: 'UPPER.JPG' });
      assert.strictEqual(resJpg.result.content[0].mimeType, 'image/jpeg');

      const resJpeg = await mcpCall('read_file', { path: 'UPPER.JPEG' });
      assert.strictEqual(resJpeg.result.content[0].mimeType, 'image/jpeg');

      const resGif = await mcpCall('read_file', { path: 'UPPER.GIF' });
      assert.strictEqual(resGif.result.content[0].mimeType, 'image/gif');

      const resWebp = await mcpCall('read_file', { path: 'UPPER.WEBP' });
      assert.strictEqual(resWebp.result.content[0].mimeType, 'image/webp');
    });

    it('read_file: rejects file with .png extension containing plain text (signature mismatch)', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'fake.png'), 'This is plain text, not a PNG');

      const res = await mcpCall('read_file', { path: 'fake.png' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /File extension indicates image\/png, but its contents do not match that image format/);
    });

    it('read_file: rejects file with .jpg extension containing PNG signature', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'mismatch.jpg'), SAMPLE_PNG);

      const res = await mcpCall('read_file', { path: 'mismatch.jpg' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /File extension indicates image\/jpeg, but its contents do not match that image format/);
    });

    it('read_file: rejects 0-byte image file (fails minimum header length)', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'empty.png'), Buffer.alloc(0));

      const res = await mcpCall('read_file', { path: 'empty.png' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /File extension indicates image\/png, but its contents do not match that image format/);
    });

    it('read_file: rejects unsupported image format (.bmp) with "Binary file, cannot read as text"', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'unsupported.bmp'), SAMPLE_BMP);

      const res = await mcpCall('read_file', { path: 'unsupported.bmp' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Binary file, cannot read as text/);
    });

    it('read_file: enforces 5 MiB image limit (rejects image > 5 MiB)', async () => {
      const largeImagePath = path.join(testProjectDir, 'oversized.png');
      const fd = fs.openSync(largeImagePath, 'w');
      fs.writeSync(fd, SAMPLE_PNG);
      // Truncate to 5 MiB + 1024 bytes (exceeds limit)
      fs.ftruncateSync(fd, 5 * 1024 * 1024 + 1024);
      fs.closeSync(fd);

      const res = await mcpCall('read_file', { path: 'oversized.png' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Image too large to send through MCP/);
      assert.match(res.result.content[0].text, /limit 5 MB/);
    });

    it('read_file: accepts image within 5 MiB limit', async () => {
      const allowedImagePath = path.join(testProjectDir, 'allowed_size.png');
      const fd = fs.openSync(allowedImagePath, 'w');
      fs.writeSync(fd, SAMPLE_PNG);
      // Truncate to 1 MiB (within 5 MiB limit)
      fs.ftruncateSync(fd, 1024 * 1024);
      fs.closeSync(fd);

      const res = await mcpCall('read_file', { path: 'allowed_size.png' });
      assert.strictEqual(res.result.isError, false);
      assert.strictEqual(res.result.content[0].type, 'image');
    });

    it('read_file: enforces 10 MiB text limit (rejects text file > 10 MiB)', async () => {
      const largeTextPath = path.join(testProjectDir, 'oversized_text.txt');
      const fd = fs.openSync(largeTextPath, 'w');
      fs.writeSync(fd, 'Normal text line\n');
      // Truncate to 10 MiB + 1024 bytes
      fs.ftruncateSync(fd, 10 * 1024 * 1024 + 1024);
      fs.closeSync(fd);

      const res = await mcpCall('read_file', { path: 'oversized_text.txt' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /File too large to read as text/);
      assert.match(res.result.content[0].text, /limit 10 MB/);
    });

    it('read_file: accepts text file within 10 MiB limit', async () => {
      const allowedText = 'Valid text line\n'.repeat(100);
      fs.writeFileSync(path.join(testProjectDir, 'allowed_text.txt'), allowedText);

      const res = await mcpCall('read_file', { path: 'allowed_text.txt' });
      assert.strictEqual(res.result.isError, false);
      assert.match(res.result.content[0].text, /File: allowed_text\.txt \(101 lines\)/);
    });

    it('read_files: fails when attempting to read an image file (text-only tool)', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'text_doc.txt'), 'Hello doc');
      fs.writeFileSync(path.join(testProjectDir, 'pic.png'), SAMPLE_PNG);

      const res = await mcpCall('read_files', { paths: ['text_doc.txt', 'pic.png'] });
      assert.strictEqual(res.result.isError, false);
      const text = res.result.content[0].text;
      assert.match(text, /===== text_doc\.txt =====\nHello doc/);
      assert.match(text, /===== pic\.png =====\n\[error\] Binary file, cannot read as text/);
    });

    it('search_files: silently skips binary image files without throwing or matching', async () => {
      const searchImgDir = path.join(testProjectDir, 'search_img_only');
      fs.mkdirSync(searchImgDir, { recursive: true });
      fs.writeFileSync(path.join(searchImgDir, 'photo_in_search.png'), SAMPLE_PNG);

      const res = await mcpCall('search_files', { query: 'PNG', path: 'search_img_only' });
      assert.strictEqual(res.result.isError, false);
      assert.strictEqual(res.result.content[0].text, 'No matches.');
    });

    it('direct POST /call: returns image result object for read_file', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'direct_call.png'), SAMPLE_PNG);

      const res = await directCall('read_file', { path: 'direct_call.png' });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.result.type, 'image');
      assert.strictEqual(res.result.mimeType, 'image/png');
      assert.ok(Buffer.from(res.result.data, 'base64').equals(SAMPLE_PNG));
    });
  });

  // =========================================================================
  // 3. Security Switches & Path Jail
  // =========================================================================
  describe('3. Security Switches & Path Jail', () => {
    it('readOnly = true: write_file is blocked with "Server is read-only"', async () => {
      await updateSettings({ readOnly: true });
      const res = await mcpCall('write_file', { path: 'readonly_test.txt', content: 'Blocked' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Server is read-only/);
      await updateSettings({ readOnly: false });
    });

    it('readOnly = true: write_files is blocked with "Server is read-only"', async () => {
      await updateSettings({ readOnly: true });
      const res = await mcpCall('write_files', { files: [{ path: 'ro.txt', content: 'Blocked' }] });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Server is read-only/);
      await updateSettings({ readOnly: false });
    });

    it('readOnly = true: edit_file is blocked with "Server is read-only"', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'ro_edit.txt'), 'old string');
      await updateSettings({ readOnly: true });
      const res = await mcpCall('edit_file', { path: 'ro_edit.txt', old_text: 'old', new_text: 'new' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Server is read-only/);
      await updateSettings({ readOnly: false });
    });

    it('readOnly = true: read_file and other read-only tools continue to function', async () => {
      fs.writeFileSync(path.join(testProjectDir, 'readable.txt'), 'still readable');
      await updateSettings({ readOnly: true });

      const resRead = await mcpCall('read_file', { path: 'readable.txt' });
      assert.strictEqual(resRead.result.isError, false);
      assert.match(resRead.result.content[0].text, /still readable/);

      const resList = await mcpCall('list_directory', { path: '.' });
      assert.strictEqual(resList.result.isError, false);

      const resInfo = await mcpCall('get_file_info', { path: 'readable.txt' });
      assert.strictEqual(resInfo.result.isError, false);

      await updateSettings({ readOnly: false });
    });

    it('disableShell = true: execute_command is blocked', async () => {
      await updateSettings({ disableShell: true });
      const res = await mcpCall('execute_command', { command: 'echo hello' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Shell is off \(the default\)/);
    });

    it('disableShell = true: start_job is blocked', async () => {
      await updateSettings({ disableShell: true });
      const res = await mcpCall('start_job', { command: 'echo hello' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Shell is off \(the default\)/);
    });

    it('skipJail = false: read_file blocks path traversal (../)', async () => {
      const res = await mcpCall('read_file', { path: '../secret_outside.txt' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Path escapes project folder: \.\.\/secret_outside\.txt/);
    });

    it('skipJail = false: write_file blocks path traversal (../)', async () => {
      const res = await mcpCall('write_file', { path: '../escaped_write.txt', content: 'hacked' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Path escapes project folder: \.\.\/escaped_write\.txt/);
    });

    it('skipJail = false: edit_file blocks path traversal (../)', async () => {
      const res = await mcpCall('edit_file', {
        path: '../secret_outside.txt',
        old_text: 'SUPER_SECRET',
        new_text: 'TAMPERED'
      });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Path escapes project folder/);
    });

    it('skipJail = false: list_directory blocks path traversal (..)', async () => {
      const res = await mcpCall('list_directory', { path: '..' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Path escapes project folder/);
    });

    it('skipJail = false: search_files blocks path traversal (..)', async () => {
      const res = await mcpCall('search_files', { query: 'test', path: '..' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Path escapes project folder/);
    });

    it('skipJail = false: get_file_info blocks path traversal (../)', async () => {
      const res = await mcpCall('get_file_info', { path: '../secret_outside.txt' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Path escapes project folder/);
    });

    it('skipJail = false: blocks absolute paths outside project folder', async () => {
      const targetAbs = path.join(outsideDir, 'secret_outside.txt');
      const res = await mcpCall('read_file', { path: targetAbs });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Path escapes project folder/);
    });

    it('skipJail = false: set_project tool is blocked with folder jail error', async () => {
      const res = await mcpCall('set_project', { path: outsideDir });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /set_project is disabled while the folder jail is on/);
    });

    it('skipJail = false: tools/list hides set_project', async () => {
      const res = await mcpList();
      const toolNames = res.result.tools.map((t) => t.name);
      assert.ok(!toolNames.includes('set_project'), 'set_project must be hidden when folder jail is on');
    });

    it('skipJail = true: allows access outside project and exposes set_project', async () => {
      await updateSettings({ skipJail: true });

      const listRes = await mcpList();
      const toolNames = listRes.result.tools.map((t) => t.name);
      assert.ok(toolNames.includes('set_project'), 'set_project must be visible when skipJail is true');

      const targetAbs = path.join(outsideDir, 'secret_outside.txt');
      const readRes = await mcpCall('read_file', { path: targetAbs });
      assert.strictEqual(readRes.result.isError, false);
      assert.match(readRes.result.content[0].text, /SUPER_SECRET_EXTERNAL_CONTENT/);

      await updateSettings({ skipJail: false });
    });
  });

  // =========================================================================
  // 4. Dynamic Runtime Flag Toggling (/api/settings)
  // =========================================================================
  describe('4. Dynamic Runtime Flag Toggling (/api/settings)', () => {
    it('dynamically toggles readOnly flag and updates enforcement immediately', async () => {
      // 1. Initially readOnly is false
      let res = await mcpCall('write_file', { path: 'dyn_ro.txt', content: 'Step 1' });
      assert.strictEqual(res.result.isError, false);

      // 2. Set readOnly = true
      let update = await updateSettings({ readOnly: true });
      assert.strictEqual(update.readOnly, true);
      res = await mcpCall('write_file', { path: 'dyn_ro.txt', content: 'Step 2' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Server is read-only/);

      // 3. Restore readOnly = false
      update = await updateSettings({ readOnly: false });
      assert.strictEqual(update.readOnly, false);
      res = await mcpCall('write_file', { path: 'dyn_ro.txt', content: 'Step 3' });
      assert.strictEqual(res.result.isError, false);
    });

    it('dynamically toggles disableShell flag and enables/disables execute_command', async () => {
      // 1. disableShell = true -> blocked
      await updateSettings({ disableShell: true });
      let res = await mcpCall('execute_command', { command: 'node -v' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Shell is off/);

      // 2. Enable shell (disableShell = false)
      await updateSettings({ disableShell: false });
      res = await mcpCall('execute_command', { command: 'node -v' });
      assert.strictEqual(res.result.isError, false);
      assert.match(res.result.content[0].text, /Exit code: 0/);
      assert.match(res.result.content[0].text, /v\d+/);

      // 3. Re-disable shell
      await updateSettings({ disableShell: true });
      res = await mcpCall('execute_command', { command: 'node -v' });
      assert.strictEqual(res.result.isError, true);
      assert.match(res.result.content[0].text, /Shell is off/);
    });

    it('dynamically toggles skipJail flag and updates set_project visibility and execution', async () => {
      // 1. Default skipJail = false
      let list = await mcpList();
      assert.ok(!list.result.tools.some((t) => t.name === 'set_project'));

      // 2. Enable skipJail = true
      await updateSettings({ skipJail: true });
      list = await mcpList();
      assert.ok(list.result.tools.some((t) => t.name === 'set_project'));

      // 3. Disable skipJail = false
      await updateSettings({ skipJail: false });
      list = await mcpList();
      assert.ok(!list.result.tools.some((t) => t.name === 'set_project'));
    });
  });

  // =========================================================================
  // 5. Defect Discovery & Edge Cases (RED Tests)
  // =========================================================================
  describe('5. Defect Discovery & Edge Cases (RED Tests)', () => {
    it('[RED] assertNotGitInternal: should block writing new .gitmodules when disableShell is true', async () => {
      await updateSettings({ disableShell: true });

      // Ensure .gitmodules does not exist prior to test
      const targetPath = path.join(testProjectDir, '.gitmodules');
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

      // Attempt to write .gitmodules
      // When disableShell is true, writing git internals (.gitmodules, .git/config, .git/hooks/*)
      // must be blocked to prevent arbitrary command execution via git.
      const res = await mcpCall('write_file', {
        path: '.gitmodules',
        content: '[submodule "evil"]\npath = evil\nurl = https://example.com'
      });

      // EXPECTATION: Should be blocked by assertNotGitInternal
      // CURRENT BUG IN server.js: realpathOrAncestor resolves non-existent .gitmodules to
      // projectRoot, resulting in rel = "", which bypasses the assertNotGitInternal check!
      assert.strictEqual(
        res.result.isError,
        true,
        'Expected write_file to .gitmodules to be blocked when disableShell=true, but it succeeded!'
      );
      assert.match(
        res.result.content[0].text,
        /Writing git internals is blocked while the shell is disabled/
      );
    });

    it('[RED] assertNotGitInternal: should block writing new git hook (.git/hooks/pre-commit) when disableShell is true', async () => {
      await updateSettings({ disableShell: true });

      // Create .git/hooks folder if it doesn't exist, but ensure pre-commit does not exist
      fs.mkdirSync(path.join(testProjectDir, '.git', 'hooks'), { recursive: true });
      const hookPath = path.join(testProjectDir, '.git', 'hooks', 'pre-commit');
      if (fs.existsSync(hookPath)) fs.unlinkSync(hookPath);

      // Attempt to write a new hook
      const res = await mcpCall('write_file', {
        path: '.git/hooks/pre-commit',
        content: '#!/bin/sh\necho "executed hook"\n'
      });

      // EXPECTATION: Should be blocked by assertNotGitInternal
      // CURRENT BUG IN server.js: realpathOrAncestor resolves non-existent hook to .git/hooks,
      // and path.relative gives ".git/hooks". Since it checks rel.startsWith(".git/hooks/"),
      // it fails to match and allows creating new git hooks!
      assert.strictEqual(
        res.result.isError,
        true,
        'Expected write_file to .git/hooks/pre-commit to be blocked when disableShell=true, but it succeeded!'
      );
      assert.match(
        res.result.content[0].text,
        /Writing git internals is blocked while the shell is disabled/
      );
    });

    it('[RED] GET /mcp status probe: should reflect active tools count and exclude set_project when skipJail is false', async () => {
      await updateSettings({ skipJail: false });

      // JSON-RPC tools/list returns 17 tools (without set_project)
      const listRes = await mcpList();
      const activeTools = listRes.result.tools.map((t) => t.name);
      assert.strictEqual(activeTools.includes('set_project'), false);

      // Probe GET /mcp
      const probeRes = await httpRequest({
        port: serverPort,
        path: '/mcp',
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + serverToken,
          Accept: 'application/json'
        }
      });

      // EXPECTATION: GET /mcp probe status should match active tools
      // CURRENT BUG IN server.js: line 2225 hardcodes toolsCount: TOOLS.length (18)
      // and tools: TOOLS.map(t => t.name), advertising set_project even when jail is on!
      assert.strictEqual(
        probeRes.json.tools.includes('set_project'),
        false,
        'Expected GET /mcp status to exclude set_project when skipJail is false, but it was included!'
      );
      assert.strictEqual(
        probeRes.json.toolsCount,
        activeTools.length,
        `Expected GET /mcp toolsCount to be ${activeTools.length}, but was ${probeRes.json.toolsCount}`
      );
    });
  });
});
