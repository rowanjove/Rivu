import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {_electron as electron} from 'playwright-core';

const directory=resolve(process.env.RIVU_STARTUP_DATA_DIR||'');
const inside=relative(tmpdir(),directory),output=process.env.RIVU_STARTUP_RESULT;
assert.ok(inside.startsWith('rivu-gui-restore-')&&!inside.includes('..')&&!isAbsolute(inside),'Only owned synthetic restore fixtures are allowed');
assert.ok(existsSync(join(directory,'gui-backup.zip'))&&output&&!existsSync(output));
const candidate=JSON.parse(readFileSync('artifacts/rivu-directory-latest.json','utf8'));
const report={status:'RUNNING',candidate,directory,runs:[],targetMs:3000,scope:'Sequential existing-library packaged launches, host launch call to visible entry list and feed navigation. OS cache not flushed; instrumented desktop observation, not cold-boot or physical frame acceptance.'};
const database=new DatabaseSync(join(directory,'rivu.db'),{readOnly:true});
try{report.fixture={entries:database.prepare('SELECT count(*) count FROM entries').get().count,aiResults:database.prepare('SELECT count(*) count FROM ai_results').get().count};}finally{database.close();}
assert.equal(report.fixture.entries,500001);assert.equal(report.fixture.aiResults,50000);
const save=()=>writeFileSync(output,JSON.stringify(report,null,2));save();
try{
 for(let run=1;run<=3;run++){
  let application,pid;const logPath=join(directory,'logs','app.log'),beforeLog=existsSync(logPath)?readFileSync(logPath).length:0;
  const started=performance.now(),sample={run};report.runs.push(sample);save();
  try{
   application=await electron.launch({executablePath:candidate.executablePath,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory},timeout:300000});
   sample.launchConnectedMs=performance.now()-started;
   pid=application.process().pid;
   let page;const deadline=performance.now()+300000;
   while(performance.now()<deadline){page=application.windows().find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,50));}
   assert.ok(page,'Main page must appear');sample.mainPageMs=performance.now()-started;
   await page.locator('.entry-row[data-entry-id]').first().waitFor({state:'visible',timeout:300000});
   await page.locator('.feed-nav').first().waitFor({state:'visible',timeout:300000});
   sample.usableMs=performance.now()-started;
   sample.visible=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible()&&!w.isDestroyed()));
   assert.equal(sample.visible,true);
   sample.feedNavCount=await page.locator('.feed-nav').count();assert.equal(sample.feedNavCount,1001);
   sample.renderer=await page.evaluate(()=>({navigation:performance.getEntriesByType('navigation').map(n=>({domContentLoadedMs:n.domContentLoadedEventEnd,loadMs:n.loadEventEnd})),entries:document.querySelectorAll('.entry-row[data-entry-id]').length}));
   sample.withinTarget=sample.usableMs<=report.targetMs;
  }finally{
   if(application){await application.close();let alive=true;const closedDeadline=performance.now()+10000;while(performance.now()<closedDeadline){try{process.kill(pid,0);}catch{alive=false;break;}await new Promise(done=>setTimeout(done,50));}sample.processClosed=!alive;assert.equal(alive,false,'Owned process must exit');}
   if(existsSync(logPath)){sample.startupEvents=readFileSync(logPath).subarray(beforeLog).toString('utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(row=>['startup_begin','startup_ready','startup_failed'].includes(row.event));const begin=sample.startupEvents.find(e=>e.event==='startup_begin'),ready=sample.startupEvents.find(e=>e.event==='startup_ready');if(begin&&ready)sample.servicePreparationMs=Date.parse(ready.at)-Date.parse(begin.at);}
   save();
  }
 }
 report.status=report.runs.every(r=>r.withinTarget)?'PASS-scoped-existing-library-startup':'FAIL-startup-target';save();
 console.log(JSON.stringify({status:report.status,runs:report.runs.map(r=>({run:r.run,usableMs:r.usableMs}))}));
 if(report.status!=='PASS-scoped-existing-library-startup')process.exitCode=1;
}catch(error){report.status='FAIL-observation';report.error=String(error);save();throw error;}
