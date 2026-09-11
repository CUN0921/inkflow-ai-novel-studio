import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {NovelDatabase} from '../src/database.mjs';

const require = createRequire('C:/Users/17566/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium} = require('playwright');
const folder = mkdtempSync(join(tmpdir(), 'inkflow-memory-monitor-'));
const dbPath = join(folder, 'test.db');
const appPort = 4370, base = `http://127.0.0.1:${appPort}`;
const db = new NovelDatabase(dbPath);
db.seed();
const project = db.listProjects()[0];
const chapter = db.getProject(project.id).chapters[0];
db.addMemory(project.id, {sourceChapter:1,kind:'character',subject:'顾临舟',fact:'在灯塔下发现一封未来来信。'});
db.addMemory(project.id, {sourceChapter:1,kind:'event',subject:'码头事故',fact:'预言中的码头事故已经发生。'});
db.addMemory(project.id, {sourceChapter:1,kind:'item',subject:'盐渍信纸',fact:'信纸边缘带有灯塔地下室的盐渍。'});
const longRequest = '完整请求上下文。'.repeat(500);
const longResponse = '完整返回内容。'.repeat(4000);
db.addModelEvent({id:'monitor-full',projectId:project.id,chapterId:chapter.id,task:'review',role:'审稿整理',model:'demo-reviewer',protocol:'responses',status:'completed',message:'模型已返回结果',requestText:longRequest,requestLength:longRequest.length,outputBudget:12345,responseText:longResponse,responseLength:longResponse.length,usage:{input_tokens:100,output_tokens:50,total_tokens:150}});
db.close();

const env = {...process.env, PORT:String(appPort), NOVEL_DB_PATH:dbPath, NOVEL_SETTINGS_PATH:join(folder,'settings.json'), OPENAI_API_KEY:''};
for (const role of ['PLANNER','WRITER','REVIEWER','CHECKER']) env[`AI_${role}_API_KEY`] = '';
let server, browser;
async function stop() { if (server?.exitCode === null) { server.kill(); await once(server,'exit').catch(() => {}); } }
try {
  server = spawn(process.execPath, ['server.mjs'], {cwd:resolve('.'),env,windowsHide:true,stdio:'ignore'});
  for (let i=0; i<60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise(r=>setTimeout(r,100)); }
  browser = await chromium.launch({channel:'chrome',headless:true});
  const page = await browser.newPage({viewport:{width:1500,height:1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('.project-card').first().click();
  await page.locator('[data-tab="memory"]').click();
  await page.locator('[data-memory-filter="event"]').click();
  assert.equal(await page.locator('#memoryList .memory-row').count(),1);
  assert.match(await page.locator('#memoryList').textContent(),/码头事故/);
  await page.locator('[data-memory-filter="character"]').click();
  assert.equal(await page.locator('#memoryList .memory-row').count(),1);
  assert.match(await page.locator('#memoryList').textContent(),/顾临舟/);
  await page.locator('[data-memory-filter="all"]').click();
  assert.equal(await page.locator('#memoryList .memory-row').count(),3);
  await page.locator('[data-tab="models"]').click();
  assert.match(await page.locator('.model-event-meta').textContent(),/预算 12,345 token/);
  assert.match(await page.locator('.model-event-meta').textContent(),/请求 4,000 字符/);
  assert.match(await page.locator('.model-event-response summary').textContent(),/已显示前 20,000 字符/);
  assert.match(await page.locator('.model-event-request summary').textContent(),/查看请求内容/);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,memoryFilters:['event','character','all'],requestLength:longRequest.length,responseLength:longResponse.length,requestDetails:true,responseDetails:true,pageErrors:errors}));
} finally { if (browser) await browser.close(); await stop(); rmSync(folder,{recursive:true,force:true}); }
