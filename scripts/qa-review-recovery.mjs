import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const require=createRequire('C:/Users/17566/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const dir=mkdtempSync(join(tmpdir(),'inkflow-review-recovery-'));
const base='http://127.0.0.1:4342'; let reviewCalls=0;
const mock=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));
  const reviewing=body.instructions?.includes('责任编辑');
  const text=reviewing ? (++reviewCalls===1?'{"score":':JSON.stringify({score:94,summary:'主角收到来信并决定调查',revisedContent:'',memories:[],issues:[]})) : '海雾贴着窗沿涌进房间。顾临舟拆开那封没有邮戳的信，纸上只有一句话：明晚，不要点亮灯塔。他把信折好，决定去旧码头调查。'.repeat(12);
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'completed',output_text:text}));
});
await new Promise(r=>mock.listen(4343,'127.0.0.1',r));
const settingsPath=join(dir,'settings.json');
const profile={apiKey:'qa',model:'qa',baseUrl:'http://127.0.0.1:4343/responses',protocol:'responses',outputTokens:8000,reasoningEffort:'none'};
writeFileSync(settingsPath,JSON.stringify({reviewEnabled:true,profiles:{planner:profile,writer:profile,reviewer:profile,checker:profile}}));
const env={...process.env,PORT:'4342',NOVEL_DB_PATH:join(dir,'test.db'),NOVEL_SETTINGS_PATH:settingsPath};
let server,browser;async function stop(){if(server?.exitCode===null){server.kill();await once(server,'exit');}}
try{
  server=spawn(process.execPath,['server.mjs'],{cwd:resolve('.'),env,windowsHide:true,stdio:'ignore'});
  for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok)break}catch{}await new Promise(r=>setTimeout(r,100))}
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1500,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('.project-card').first().click();await page.locator('.chapter-item').first().click();
  await page.locator('#writeCurrentChapterBtn').click();await page.locator('#writeForm [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#runStatus')?.textContent.includes('校验失败'),{},{timeout:15000});
  await page.waitForSelector('#reviewDraftBtn');
  assert.match(await page.locator('.editor-meta').textContent(),/待审稿/);
  assert.ok((await page.locator('#chapterContent').inputValue()).length>120);
  await page.locator('#reviewDraftBtn').click();
  await page.waitForFunction(()=>document.querySelector('.editor-meta')?.textContent.includes('94'),{},{timeout:15000});
  assert.equal(reviewCalls,2);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,draftPreserved:true,retryReviewOnly:true,score:94,reviewCalls,pageErrors:errors}));
}finally{if(browser)await browser.close();await stop();await new Promise(r=>mock.close(r));rmSync(dir,{recursive:true,force:true});}
