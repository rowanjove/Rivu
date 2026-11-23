import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {_electron as electron} from 'playwright-core';
const directory=resolve(process.env.RIVU_RESTORE_PHASE_DIR||''),inside=relative(tmpdir(),directory),output=process.env.RIVU_RESTORE_RENDERER_RESULT;
assert.ok(inside.startsWith('rivu-gui-restore-')&&!inside.includes('..')&&!isAbsolute(inside));assert.ok(output&&!existsSync(output)&&!existsSync(output+'.trace.json'));
const candidate=JSON.parse(readFileSync('artifacts/rivu-directory-latest.json')),archive=join(directory,'gui-backup.zip');assert.ok(existsSync(archive));
const resolveBeforeTiming=process.env.RIVU_RESTORE_RESOLVE_BUTTON_FIRST==='1';
const digest=path=>existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):null;
let application,recording=false;
try{
 application=await electron.launch({executablePath:candidate.executablePath,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
 let page;const ready=Date.now()+300000;while(Date.now()<ready){page=application.windows().find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,100));}assert.ok(page);
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'恢复备份',exact:true}).waitFor();
 const resolvedButton=resolveBeforeTiming?await page.getByRole('button',{name:'恢复备份',exact:true}).elementHandle():null;
 if(resolveBeforeTiming)assert.ok(resolvedButton);
 const before={settings:digest(join(directory,'settings.json')),report:digest(join(directory,'restore-report.json'))};
 await application.evaluate(({dialog,ipcMain},archive)=>{
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[archive]});dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});
  globalThis.__profilePreflight={done:false};const original=ipcMain._invokeHandlers.get('rivu:choose-file');ipcMain.removeHandler('rivu:choose-file');ipcMain.handle('rivu:choose-file',async(...args)=>{try{const result=await original(...args);globalThis.__profilePreflight.result=result;return result;}catch(error){globalThis.__profilePreflight.error=String(error);throw error;}finally{globalThis.__profilePreflight.done=true;}});
  globalThis.__profileMain={samples:0,maxGapMs:0};let at=performance.now();globalThis.__profileTimer=setInterval(()=>{const now=performance.now();globalThis.__profileMain.samples++;globalThis.__profileMain.maxGapMs=Math.max(globalThis.__profileMain.maxGapMs,now-at);at=now;},10);
 },archive);
 await application.evaluate(async({contentTracing})=>contentTracing.startRecording({included_categories:['devtools.timeline','disabled-by-default-devtools.timeline','blink.user_timing','v8','toplevel','base']}));recording=true;
 await page.evaluate(()=>{
  const state=window.__restoreProfile={samples:0,maxGapMs:0,gaps:[],longTasks:[],visibility:[{at:Date.now(),state:document.visibilityState,focused:document.hasFocus()}],timeOrigin:performance.timeOrigin};let at=performance.now();
  state.timer=setInterval(()=>{const now=performance.now(),ms=now-at;state.samples++;state.maxGapMs=Math.max(state.maxGapMs,ms);if(ms>=100&&state.gaps.length<100){const index=state.gaps.length;state.gaps.push({at:Date.now(),startEpochMs:performance.timeOrigin+at,ms,visibility:document.visibilityState,focused:document.hasFocus()});performance.mark('rivu-restore-gap:'+index);}at=now;},10);
  state.visibilityChanged=()=>state.visibility.push({at:Date.now(),state:document.visibilityState,focused:document.hasFocus()});document.addEventListener('visibilitychange',state.visibilityChanged);window.addEventListener('focus',state.visibilityChanged);window.addEventListener('blur',state.visibilityChanged);
  state.observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())if(state.longTasks.length<1000)state.longTasks.push({startEpochMs:performance.timeOrigin+entry.startTime,ms:entry.duration});});state.observer.observe({entryTypes:['longtask']});performance.mark('rivu-restore-preflight-start');
 });
 const started=Date.now();if(resolvedButton)await resolvedButton.click();else await page.getByRole('button',{name:'恢复备份',exact:true}).click();let done=false;const deadline=Date.now()+600000;
 while(Date.now()<deadline){done=await application.evaluate(()=>globalThis.__profilePreflight.done);if(done)break;await new Promise(resolve=>setTimeout(resolve,250));}assert.ok(done,'Functional preflight observation timed out');
 const main=await application.evaluate(()=>{clearInterval(globalThis.__profileTimer);return {...globalThis.__profileMain,outcome:globalThis.__profilePreflight};});assert.equal(main.outcome.error,undefined);assert.equal(main.outcome.result,null);
 const renderer=await page.evaluate(()=>{const s=window.__restoreProfile;performance.mark('rivu-restore-preflight-end');clearInterval(s.timer);s.observer.disconnect();document.removeEventListener('visibilitychange',s.visibilityChanged);window.removeEventListener('focus',s.visibilityChanged);window.removeEventListener('blur',s.visibilityChanged);const {timer,observer,visibilityChanged,...result}=s;return result;});
 await application.evaluate(async({contentTracing},path)=>contentTracing.stopRecording(path),resolve(output+'.trace.json'));recording=false;
 assert.deepEqual({settings:digest(join(directory,'settings.json')),report:digest(join(directory,'restore-report.json'))},before);assert.equal(existsSync(join(directory,'restore-journal.json')),false);
 await application.close();application=undefined;
 writeFileSync(output,JSON.stringify({status:'PROFILE-COMPLETE',buttonResolvedBeforeTiming:resolveBeforeTiming,candidate,directory,elapsedMs:Date.now()-started,main,renderer,settingsAndPreviousRestoreReportUnchanged:true,scope:'Instrumented real packaged UI, preflight canceled at confirmation; no replacement. Trace/timers may perturb timing, not physical60FPS or full restore acceptance.'},null,2),{flag:'wx'});console.log('PROFILE-COMPLETE canceled large preflight');
}finally{if(recording)await application?.evaluate(async({contentTracing},path)=>contentTracing.stopRecording(path),resolve(output+'.trace.json')).catch(()=>{});await application?.close();}
