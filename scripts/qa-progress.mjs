import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const require = createRequire('C:/Users/17566/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium} = require('playwright');
const folder = mkdtempSync(join(tmpdir(), 'inkflow-progress-ui-'));
const appPort = 4360, mockPort = 4361, base = `http://127.0.0.1:${appPort}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = [];
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  const review = body.instructions?.includes('责任编辑');
  calls.push(review ? 'reviewer' : 'writer');
  if (review) await wait(3500);
  const text = review
    ? JSON.stringify({score:91,summary:'本章完成进度刷新测试',memories:[],issues:[]})
    : '进度刷新测试正文。'.repeat(220);
  res.writeHead(200, {'Content-Type':'application/json'});
  res.end(JSON.stringify({status:'completed',output_text:text}));
});
await new Promise(resolve => mock.listen(mockPort, '127.0.0.1', resolve));

const env = {
  ...process.env, PORT:String(appPort), NOVEL_DB_PATH:join(folder, 'test.db'),
  NOVEL_SETTINGS_PATH:join(folder, 'settings.json'), OPENAI_API_KEY:'qa', OPENAI_MODEL:'qa',
  OPENAI_BASE_URL:`http://127.0.0.1:${mockPort}/responses`, OPENAI_PROTOCOL:'responses'
};
let server, browser;
async function stop() {
  if (server?.exitCode === null) { server.kill(); await once(server, 'exit').catch(() => {}); }
}
try {
  server = spawn(process.execPath, ['server.mjs'], {cwd:resolve('.'), env, windowsHide:true, stdio:'ignore'});
  for (let i=0; i<60; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await wait(100);
  }
  browser = await chromium.launch({channel:'chrome', headless:true});
  const page = await browser.newPage({viewport:{width:1500,height:1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('.project-card').first().click();
  await page.locator('.chapter-item').first().click();
  await page.locator('#writeCurrentChapterBtn').click();
  await page.locator('#writeForm [type=submit]').click();
  await page.waitForFunction(() => /正在写第|检查/.test(document.querySelector('#runStatus')?.textContent || ''), {}, {timeout:5000});
  await page.waitForFunction(() => {
    const label = document.querySelector('#progressLabel')?.textContent || '';
    return /[1-9][0-9,]*\s*\/\s*[0-9,]+\s*字/.test(label) && document.querySelector('#runStatus')?.textContent.includes('检查');
  }, {}, {timeout:15000});
  const liveLabel = await page.locator('#progressLabel').textContent();
  const liveChapters = await page.locator('#chapterProgress').textContent();
  assert.match(liveLabel, /[1-9][0-9,]*\s*\/\s*[0-9,]+\s*字/);
  assert.match(liveChapters, /已生成/);
  await page.waitForFunction(() => document.querySelector('#runStatus')?.textContent.includes('已完成 1 章'), {}, {timeout:15000});
  assert.deepEqual(calls, ['writer','reviewer']);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ok:true,liveLabel,liveChapters,progressUpdatedBeforeCompletion:true,calls,pageErrors:errors}));
} finally {
  if (browser) await browser.close();
  await stop();
  await new Promise(resolve => mock.close(resolve));
  rmSync(folder, {recursive:true, force:true});
}
