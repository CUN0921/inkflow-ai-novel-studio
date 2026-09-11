import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const require = createRequire('C:/Users/17566/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium} = require('playwright');
const dir = mkdtempSync(join(tmpdir(),'inkflow-settings-ui-'));
const base = 'http://127.0.0.1:4340';
const calls = [];
const mock = http.createServer(async(req,res)=>{
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks));
  calls.push(input.model);
  const text = input.model === 'ui-reviewer' ? JSON.stringify({score:93,summary:'主角在码头找到信件',memories:[],issues:[]}) : '主角沿码头找到一封湿透的信。他收好信件，决定第二天前往灯塔。'.repeat(10);
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({output_text:text, choices:[{message:{content:text}}]}));
});
await new Promise(r=>mock.listen(4341,'127.0.0.1',r));
const env={...process.env,PORT:'4340',NOVEL_DB_PATH:join(dir,'test.db'),NOVEL_SETTINGS_PATH:join(dir,'settings.json'),OPENAI_API_KEY:''};
for(const role of ['PLANNER','WRITER','REVIEWER','CHECKER']) env[`AI_${role}_API_KEY`]='';
let server, browser;
async function start() {
  server=spawn(process.execPath,['server.mjs'],{cwd:resolve('.'),env,windowsHide:true,stdio:'ignore'});
  for(let i=0;i<60;i++) {try {if((await fetch(base+'/api/health')).ok)return;}catch{} await new Promise(r=>setTimeout(r,100));}
  throw new Error('测试服务启动超时');
}
async function stop() {if(server && server.exitCode===null){server.kill(); await once(server,'exit');}}
try {
  await start();
  browser = await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1500,height:1000}});
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.goto(base); await page.locator('#settingsBtn').click();
  await page.waitForSelector('.model-setting');
  for(const role of ['planner','writer','reviewer','checker']) {
    const field=page.locator(`[data-role=${role}]`);
    await field.locator('[name=baseUrl]').fill(`http://127.0.0.1:4341/${role==='writer'?'chat/completions':'responses'}`);
    await field.locator('[name=protocol]').selectOption(role==='writer'?'chat':'responses');
    await field.locator('[name=model]').fill(`ui-${role}`);
    await field.locator('[name=outputTokens]').fill('8000');
    await field.locator('[name=apiKey]').fill('ui-test-secret');
  }
  await page.locator('[data-role=reviewer] [name=reasoningEffort]').selectOption('none');
  await page.locator('#reviewEnabled').uncheck();
  async function save() {
    const response=page.waitForResponse(r=>r.url().endsWith('/api/settings') && r.request().method()==='PUT');
    await page.locator('#saveSettingsBtn').click(); assert.equal((await response).status(),200);
    await page.waitForFunction(()=>document.querySelector('#settingsFeedback').textContent.includes('设置已保存'));
  }
  await save();
  assert.equal(await page.locator('[data-role=writer] [name=apiKey]').inputValue(),'');
  assert.ok(!(await (await fetch(base+'/api/settings')).text()).includes('ui-test-secret'));
  await page.locator('#testModelsBtn').click();
  await page.waitForFunction(()=>document.querySelector('#settingsFeedback').textContent.includes('网络查重：连接通过'));
  await page.locator('#settingsDialog .close-dialog').first().click();
  await page.locator('.project-card').first().click();
  await page.locator('.chapter-item').first().click();
  const before=calls.length;
  async function writeCurrent() {
    await page.locator('#writeCurrentChapterBtn').click();
    const response=page.waitForResponse(r=>r.url().endsWith('/run') && r.request().method()==='POST');
    await page.locator('#writeForm [type=submit]').click();
    assert.equal((await response).status(),202);
    await page.waitForFunction(()=>document.querySelector('#chapterContent')?.value.trim() && document.querySelector('#runStatus').textContent.includes('已完成 1 章'),{},{timeout:15000});
  }
  await writeCurrent();
  assert.deepEqual(calls.slice(before),['ui-writer']);
  assert.match(await page.locator('.editor-meta').textContent(),/未审稿/);
  await page.locator('#settingsBtn').click(); await page.waitForSelector('.model-setting');
  await page.locator('#reviewEnabled').check(); await save();
  await page.locator('#settingsDialog .close-dialog').first().click();
  await page.locator('.chapter-item').nth(1).click();
  const next=calls.length; await writeCurrent();
  assert.deepEqual(calls.slice(next),['ui-writer','ui-reviewer']);
  assert.match(await page.locator('.editor-meta').textContent(),/93/);
  await page.locator('#settingsBtn').click(); await page.waitForSelector('.model-setting');
  await page.screenshot({path:'data/settings-ui-check.png',fullPage:true});
  await stop(); await start();
  const restored=await (await fetch(base+'/api/settings')).json();
  assert.equal(restored.reviewEnabled,true);
  assert.equal(restored.profiles.find(p=>p.role==='writer').model,'ui-writer');
  assert.equal(restored.profiles.find(p=>p.role==='writer').hasApiKey,true);
  assert.equal(restored.profiles.find(p=>p.role==='reviewer').reasoningEffort,'none');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,saveModels:true,testSavedConnections:true,secretNotReturned:true,reviewOffSkipsModel:true,reviewOnCallsModel:true,restartPersists:true,pageErrors:errors}));
} finally {
  if(browser)await browser.close(); await stop();
  await new Promise(r=>mock.close(r));
  rmSync(dir,{recursive:true,force:true});
}
