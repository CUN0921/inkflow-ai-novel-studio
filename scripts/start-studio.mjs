import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { workspaceId, servicePort } from '../src/runtime-config.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = process.env;
const port = servicePort(env);
const base = `http://127.0.0.1:${port}`;
const dataDir = join(root,'data');
mkdirSync(dataDir,{recursive:true});
const lockPath = join(dataDir,`startup-${port}.lock`);
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function ready() {
  try {
    const response = await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(700)});
    const health = await response.json();
    return response.ok && health.ok && health.app === 'inkflow' && health.workspaceId === workspaceId(root);
  } catch { return false; }
}
async function openBrowser() {
  if (process.argv.includes('--no-browser')) return;
  const executable=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const browser=spawn(executable,['-NoProfile','-Command',`Start-Process '${base}/'`],{windowsHide:true,stdio:'ignore'});
  await once(browser,'exit');
}
async function launch() {
  if (await ready()) { console.log(`Inkflow is already running: ${base}/`); await openBrowser(); return; }
  let locked = false;
  try {
    const deadline = Date.now()+25000;
    while (!locked && Date.now()<deadline) {
      try { closeSync(openSync(lockPath,'wx')); locked = true; }
      catch(error) {
        if(error.code !== 'EEXIST') throw error;
        if(await ready()) { console.log(`Inkflow is ready: ${base}/`); await openBrowser(); return; }
        try { if(Date.now()-statSync(lockPath).mtimeMs>60000) unlinkSync(lockPath); } catch {}
        await sleep(300);
      }
    }
    if (!locked) throw new Error('Another launch is still starting. Please try again shortly.');
    if (await ready()) { console.log(`Inkflow is already running: ${base}/`); await openBrowser(); return; }
    await new Promise((resolve,reject)=>{
      const probe=net.createServer();
      probe.once('error',()=>reject(new Error(`Port ${port} is occupied by another service or an older Inkflow instance. Close that service and retry.`)));
      probe.listen(port,'127.0.0.1',()=>probe.close(resolve));
    });
    const output=openSync(join(dataDir,'server.log'),'a');
    const errors=openSync(join(dataDir,'server-error.log'),'a');
    const child=spawn(process.execPath,[join(root,'server.mjs')],{cwd:root,env:process.env,detached:true,windowsHide:true,stdio:['ignore',output,errors]});
    closeSync(output);closeSync(errors);
    await once(child,'spawn');child.unref();
    const started=Date.now();
    while(Date.now()-started<20000) {
      if(await ready()) { console.log(`Inkflow started: ${base}/ (PID ${child.pid})`); await openBrowser(); return; }
      if(child.exitCode != null) break;
      await sleep(250);
    }
    throw new Error('Startup did not finish. Check data/server-error.log.');
  } finally { if(locked) { try { unlinkSync(lockPath); } catch {} } }
}
launch().catch(error=>{console.error(error.message);process.exitCode=1;});
