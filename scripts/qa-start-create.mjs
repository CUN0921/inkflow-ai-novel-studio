import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';

const folder=mkdtempSync(join(tmpdir(),'inkflow-start-create-'));
const port=4331, base=`http://127.0.0.1:${port}`;
const env={...process.env,PORT:String(port),NOVEL_DB_PATH:join(folder,'test.db'),OPENAI_API_KEY:''};
for(const key of Object.keys(env)) if(key.toLowerCase()==='path') delete env[key];
env.Path=join(env.SystemRoot,'System32'); // Explorer environment without Codex's injected Node PATH.
for(const role of ['PLANNER','WRITER','REVIEWER','CHECKER']) env[`AI_${role}_API_KEY`]='';
const require=createRequire('C:/Users/17566/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
let browser,servicePid;
async function launch() {
  const cmd=join(process.env.SystemRoot,'System32','cmd.exe');
  const child=spawn(cmd,['/d','/s','/c',`""${resolve('启动墨流.cmd')}" -NoBrowser"`],{env,cwd:tmpdir(),windowsHide:true,windowsVerbatimArguments:true,stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',chunk=>output+=chunk); child.stderr.on('data',chunk=>output+=chunk);
  const code=await new Promise((res,rej)=>{child.on('error',rej);child.on('exit',res);});
  assert.equal(code,0,output);
  return output;
}
const api=async path=>(await fetch(base+path)).json();
try {
  await assert.rejects(()=>fetch(`${base}/api/health`),'Test port must be unused');
  const output=await launch();console.log(output.trim());
  servicePid=Number(output.match(/PID (\d+)/)?.[1]); assert.ok(servicePid);
  assert.equal((await api('/api/health')).app,'inkflow');
  const again=await launch();assert.match(again,/already running/);
  await new Promise(r=>setTimeout(r,1000));assert.equal((await api('/api/health')).ok,true);
  browser=await require('playwright').chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1500,height:1000}});
  const errors=[],toasts=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);
  await page.evaluate(()=>new MutationObserver(()=>window.testToasts.push(document.querySelector('#toast').textContent)).observe(document.querySelector('#toast'),{childList:true,subtree:true}));
  // Save toast messages so caught errors also fail the test.
  await page.evaluate(()=>window.testToasts=[]);
  await page.locator('.project-card').first().click();
  await page.locator('.chapter-item').first().click();
  const oldTitle=await page.locator('#chapterTitleInput').inputValue();
  const before=(await api('/api/projects')).length;
  let posts=0;
  page.on('request',request=>{if(request.method()==='POST' && request.url()===`${base}/api/projects`) posts++;});
  await page.route('**/api/projects',async route=>{
    if(route.request().method()==='POST') await new Promise(r=>setTimeout(r,300));
    await route.continue();
  });
  async function create(title) {
    await page.locator('#newProjectBtn').click();
    await page.locator('#newProjectForm [name=title]').fill(title);
    await page.locator('#newProjectForm [name=premise]').fill('测试创建后自动生成方案');
    await page.locator('#newProjectForm').evaluate(form=>{
      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    });
    await page.waitForFunction(title=>document.querySelector('#projectTitle').textContent===title && document.querySelector('#chapterCount').textContent==='10 章',title);
    assert.equal(await page.locator('#chapterTitleInput').count(),0,'Old editor must be cleared');
    await page.locator('.chapter-item').first().click();
    assert.ok(await page.locator('#chapterTitleInput').inputValue());
  }
  await create('从旧章节新建测试');
  await create('连续新建测试');
  assert.equal(posts,2);assert.equal((await api('/api/projects')).length,before+2);
  // A planning error must leave the created project accessible and retryable.
  await page.route('**/api/projects/*/plan',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'测试规划失败'})}));
  await page.locator('#newProjectBtn').click();
  await page.locator('#newProjectForm [name=title]').fill('保留失败作品测试');
  await page.locator('#newProjectForm [name=premise]').fill('模拟规划失败，允许重试');
  await page.locator('#newProjectForm [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='测试规划失败');
  assert.equal(await page.locator('#projectTitle').textContent(),'保留失败作品测试');
  assert.equal(await page.locator('#planBtn').isEnabled(),true);
  const count=(await api('/api/projects')).length;
  await page.unroute('**/api/projects/*/plan');
  await page.locator('#planBtn').click();
  await page.waitForFunction(()=>document.querySelector('#chapterCount').textContent==='10 章');
  assert.equal((await api('/api/projects')).length,count);
  toasts.push(...await page.evaluate(()=>window.testToasts));
  assert.ok(!toasts.some(text=>/Cannot read/i.test(text)),JSON.stringify(toasts));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,noNodePathLaunch:true,repeatedLaunch:true,launcherExitKeepsServiceAlive:true,oldChapterCleared:!!oldTitle,duplicateSubmitBlocked:true,consecutiveCreate:true,failedPlanRetry:true,pageErrors:errors}));
} finally {
  if(browser)await browser.close();
  if(servicePid){process.kill(servicePid);await new Promise(r=>setTimeout(r,500));}
  rmSync(folder,{recursive:true,force:true});
}
