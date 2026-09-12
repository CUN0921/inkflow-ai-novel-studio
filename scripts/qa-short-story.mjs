import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire('C:/Users/17566/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const folder = mkdtempSync(join(tmpdir(),'inkflow-short-story-qa-'));
const port = 4346;
const base = `http://127.0.0.1:${port}`;
const service = spawn(process.execPath,['server.mjs'],{
  cwd:process.cwd(), windowsHide:true, stdio:['ignore','pipe','pipe'],
  env:{...process.env,PORT:String(port),NOVEL_DB_PATH:join(folder,'test.db'),NOVEL_SETTINGS_PATH:join(folder,'settings.json')}
});
let browser;

async function waitForHealth() {
  const deadline = Date.now()+10000;
  while (Date.now()<deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('短故事 QA 服务启动超时');
}

try {
  await waitForHealth();
  browser = await chromium.launch({channel:'chrome',headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);

  await page.locator('#newProjectBtn').click();
  await page.locator('#projectMode').selectOption('short');
  assert.equal(await page.locator('#perspectiveField').isVisible(),true);
  assert.deepEqual(await page.locator('#projectTargetWords option').allTextContents(),['1 万字','1.5 万字 · 推荐','2 万字','3 万字','5 万字','8 万字']);
  await page.locator('#newProjectForm [name=title]').fill('第七封无人签收的信');
  await page.locator('#newProjectForm [name=genre]').fill('现实悬疑');
  await page.locator('#newProjectForm [name=premise]').fill('邮递员发现一封写给七天后自己的信，而寄件人是已经去世的母亲。');
  await page.locator('#newProjectForm [name=tone]').fill('克制、紧凑、第一人称');
  await page.locator('#newProjectForm [name=perspective]').selectOption('first');
  await page.locator('#newProjectForm [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#chapterCount')?.textContent==='1 篇');

  assert.match(await page.locator('#projectStatus').textContent(),/短故事/);
  assert.equal(await page.locator('#workspaceTabs [data-tab=chapters]').textContent(),'全文与结构');
  assert.equal(await page.locator('#planBtn').isVisible(),false);
  assert.equal(await page.locator('.chapter-item b').textContent(),'全文');
  await page.locator('.chapter-item').click();
  assert.equal(await page.locator('#chapterTargetWords').inputValue(),'15000');
  assert.match(await page.locator('#editorPanel').textContent(),/完整故事结构/);

  await page.locator('#workspaceTabs [data-tab=outline]').click();
  assert.equal(await page.locator('#shortStoryGuide').isVisible(),true);
  const guide = await page.locator('#shortStoryGuide').textContent();
  assert.match(guide,/开篇钩子/);
  assert.match(guide,/核心冲突/);
  assert.match(guide,/建议试读节点/);
  assert.equal(await page.locator('#volumePlanCard').isVisible(),false);

  await page.locator('#workspaceTabs [data-tab=framework]').click();
  const framework = await page.locator('#frameworkContent').textContent();
  assert.match(framework,/完整结构/);
  assert.match(framework,/一篇完结/);
  assert.doesNotMatch(framework,/分卷目标/);

  await page.locator('#workspaceTabs [data-tab=chapters]').click();
  await page.locator('#writeCurrentChapterBtn').click();
  assert.match(await page.locator('#writeDialogTitle').textContent(),/完整短故事/);
  assert.equal(await page.locator('#writeQueueActions').isVisible(),false);
  await page.locator('#writeForm [type=submit]').click();
  await page.waitForFunction(async()=>{
    const response=await fetch('/api/projects');
    const projects=await response.json();
    return projects.find(item=>item.title==='第七封无人签收的信')?.status==='completed';
  },null,{timeout:10000});

  const projects = await (await fetch(`${base}/api/projects`)).json();
  const shortProject = projects.find(item=>item.title==='第七封无人签收的信');
  assert.ok(shortProject);
  const fresh = await (await fetch(`${base}/api/projects/${shortProject.id}`)).json();
  assert.equal(fresh.chapters.length,1);
  assert.equal(fresh.chapters[0].status,'completed');
  const exported = await (await fetch(`${base}/api/projects/${shortProject.id}/export`)).text();
  assert.equal(exported.trim(),fresh.chapters[0].content.trim());
  assert.doesNotMatch(exported,/^第七封无人签收的信|^第 1 章/);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,modeSelector:true,onePiecePlan:true,shortBlueprint:true,writingDialog:true,completedWorkflow:true,bodyOnlyExport:true,pageErrors:errors}));
} finally {
  if (browser) await browser.close();
  service.kill();
  await new Promise(resolve=>service.once('exit',resolve));
  rmSync(folder,{recursive:true,force:true});
}
