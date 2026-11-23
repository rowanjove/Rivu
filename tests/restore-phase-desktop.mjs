import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {execFileSync} from 'node:child_process';
import {_electron as electron,chromium} from 'playwright-core';
const directory=resolve(process.env.RIVU_RESTORE_PHASE_DIR||''),inside=relative(tmpdir(),directory),output=process.env.RIVU_RESTORE_PHASE_RESULT;
assert.ok(inside.startsWith('rivu-gui-restore-')&&!inside.includes('..')&&!isAbsolute(inside));assert.ok(output&&!existsSync(output)&&!existsSync(output+'.main.json'));
const candidate=JSON.parse(readFileSync('artifacts/rivu-directory-latest.json')),archive=join(directory,'gui-backup.zip');assert.ok(existsSync(archive));
const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;await new Promise(done=>server.close(done));
const resolveBeforeTiming=process.env.RIVU_RESTORE_RESOLVE_BUTTON_FIRST==='1';
let application,remote;let renderer={samples:0,maxGapMs:0},restartedPid;
try{
 application=await electron.launch({executablePath:candidate.executablePath,args:['--no-sandbox','--rivu-restore-test='+randomUUID()],env:{...process.env,RIVU_DATA_DIR:directory}});
 let page;const deadline=Date.now()+30000;while(Date.now()<deadline){page=application.windows().find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,100));}assert.ok(page);
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'恢复备份',exact:true}).waitFor();
 const resolvedButton=resolveBeforeTiming?await page.getByRole('button',{name:'恢复备份',exact:true}).elementHandle():null;if(resolveBeforeTiming)assert.ok(resolvedButton);
 await page.exposeFunction('__restorePhaseHeartbeat',state=>{renderer=state;});
 await page.evaluate(()=>{let at=performance.now(),samples=0,maxGapMs=0;const gaps=[],longTasks=[],visibility=[{at:Date.now(),state:document.visibilityState,focused:document.hasFocus()}];setInterval(()=>{const now=performance.now(),ms=now-at;maxGapMs=Math.max(maxGapMs,ms);if(ms>=100&&gaps.length<100)gaps.push({at:Date.now(),ms,visibility:document.visibilityState,focused:document.hasFocus()});at=now;samples++;},10);const changed=()=>visibility.push({at:Date.now(),state:document.visibilityState,focused:document.hasFocus()});document.addEventListener('visibilitychange',changed);window.addEventListener('focus',changed);window.addEventListener('blur',changed);new PerformanceObserver(list=>{for(const entry of list.getEntries())if(longTasks.length<1000)longTasks.push({startEpochMs:performance.timeOrigin+entry.startTime,ms:entry.duration});}).observe({entryTypes:['longtask']});setInterval(()=>void window.__restorePhaseHeartbeat({samples,maxGapMs,gaps,longTasks,visibility}),250);});
 await application.evaluate(({app,dialog},{archive,port,path})=>{
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[archive]});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});
  const state={samples:0,maxGapMs:0,startedAt:Date.now()};let at=performance.now();const timer=setInterval(()=>{const now=performance.now();state.samples++;state.maxGapMs=Math.max(state.maxGapMs,now-at);at=now;},10);timer.unref();
  const relaunch=app.relaunch.bind(app);app.relaunch=()=>{clearInterval(timer);process.getBuiltinModule('node:fs').writeFileSync(path,JSON.stringify({...state,endedAt:Date.now()}),{flag:'wx'});return relaunch({args:['--no-sandbox','--rivu-restore-test='+Date.now(),`--remote-debugging-port=${port}`]});};
 },{archive,port,path:resolve(output+'.main.json')});
 const oldPid=application.process().pid,closed=application.waitForEvent('close',{timeout:600000});
 // Functional observation window includes full preflight, rollback copy and
 // validation. It is not the100ms responsiveness threshold.
 if(resolvedButton)await resolvedButton.click();else await page.getByRole('button',{name:'恢复备份',exact:true}).click();await closed;application=undefined;
 const ready=Date.now()+60000;let connected=false;while(Date.now()<ready){try{remote=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);connected=true;break;}catch{}await new Promise(done=>setTimeout(done,100));}assert.ok(connected);
 const session=await remote.newBrowserCDPSession(),info=await session.send('SystemInfo.getProcessInfo');restartedPid=Number(info.processInfo.find(p=>p.type==='browser').id);assert.notEqual(restartedPid,oldPid);await remote.close();remote=undefined;
 const main=JSON.parse(readFileSync(output+'.main.json','utf8'));
 writeFileSync(output,JSON.stringify({status:'RESTORED-AUDIT-PENDING',buttonResolvedBeforeTiming:resolveBeforeTiming,candidate,directory,oldPid,restartedPid,port,main,renderer,responsiveness:{under100:main.samples>0&&renderer.samples>0&&main.maxGapMs<100&&renderer.maxGapMs<100,scope:'Continuous10ms timers through confirmed restore and preflight; last250ms renderer heartbeat can be absent; not physical60FPS'},scope:'Reused failed synthetic GUI fixture and its original exported backup; dialog choices stubbed, real relaunch'},null,2),{flag:'wx'});
 execFileSync(process.execPath,['scripts/audit-relaunched-restore.mjs'],{env:{...process.env,RIVU_RESTORE_AUDIT_DIR:directory,RIVU_RESTORE_AUDIT_PID:String(restartedPid),RIVU_RESTORE_AUDIT_PORT:String(port),RIVU_RESTORE_AUDIT_RESULT:output+'.audit.json'},stdio:'inherit'});
 const audit=JSON.parse(readFileSync(output+'.audit.json','utf8')),under100=main.samples>0&&renderer.samples>0&&main.maxGapMs<100&&renderer.maxGapMs<100;
 assert.equal(audit.status,'PASS-post-relaunch-audit');assert.equal(audit.ownedRelaunchedProcessClosed,true);
 writeFileSync(output+'.completion.json',JSON.stringify({status:under100?'PASS-scoped-functional-and-timer-observation':'FAIL-timer-observation',raw:output,audit:output+'.audit.json',under100,mainMaxGapMs:main.maxGapMs,rendererMaxGapMs:renderer.maxGapMs,scope:'Actual confirmed synthetic500k/50k restore and real relaunch, independently audited data. Not physical60FPS, all devices or wholePRD acceptance.'},null,2),{flag:'wx'});
 console.log('PASS phase restore and independent post-relaunch audit; inspect responsiveness separately');
 if(process.env.RIVU_REQUIRE_RESTORE_RESPONSIVENESS==='1')assert.ok(under100,'Restore main/renderer timers must remain below100ms');
}finally{await application?.close();if(remote?.isConnected())await remote.close();}
