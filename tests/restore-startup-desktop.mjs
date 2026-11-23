import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {_electron as electron} from 'playwright-core';
import {RivuDatabase} from '../dist-server/database.cjs';
const output=process.env.RIVU_RESTORE_STARTUP_RESULT;assert.ok(output&&!existsSync(output));
const directory=mkdtempSync(join(resolve('bench-data'),'rivu-restore-startup-')),executable=resolve(process.env.RIVU_TEST_EXE),cases=[];
let app;
function seed(path,title){mkdirSync(path,{recursive:true});const model=new RivuDatabase(join(path,'rivu.db'));try{const feed=model.addFeed({title,url:'https://example.invalid/'+title,fetchInterval:0});model.addEntries(feed.id,[{title,hash:title}]);}finally{model.close();}}
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
try{
 const good=join(directory,'prepared'),old=join(directory,'old'),id=randomUUID();seed(old,'Old entry');seed(good,'New entry');
 copyFileSync(join(old,'rivu.db'),join(good,`before-restore-${id}.db`));writeFileSync(join(good,`before-restore-${id}.json`),JSON.stringify({marker:'old'}));writeFileSync(join(good,'settings.json'),JSON.stringify({marker:'new'}));
 writeFileSync(join(good,'restore-journal.json'),JSON.stringify({version:1,id,phase:'prepared',hadDb:true,hadSettings:true,replaceSettings:true}));
 app=await electron.launch({executablePath:executable,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:good}});
 let page;const until=Date.now()+30000;while(Date.now()<until){page=app.windows().find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,100));}assert.ok(page);
 await page.waitForFunction(()=>!!window.rivu);const entries=await page.evaluate(()=>window.rivu.request('GET','/api/entries?view=all'));
 assert.equal(entries[0].title,'Old entry');assert.equal(JSON.parse(readFileSync(join(good,'settings.json'),'utf8')).marker,'old');assert.equal(existsSync(join(good,'restore-journal.json')),false);
 await app.close();app=undefined;cases.push({case:'prepared startup',status:'PASS',oldPairRestoredBeforeServing:true});
 const bad=join(directory,'corrupt');seed(bad,'Unchanged entry');writeFileSync(join(bad,'settings.json'),JSON.stringify({marker:'untouched'}));writeFileSync(join(bad,'restore-journal.json'),'broken journal');
 const before={db:digest(join(bad,'rivu.db')),settings:digest(join(bad,'settings.json'))};
 app=await electron.launch({executablePath:executable,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:bad}});
 let failed=false;const deadline=Date.now()+30000;
 while(Date.now()<deadline){const logs=join(bad,'logs');failed=existsSync(logs)&&readdirSync(logs).filter(name=>name.endsWith('.log')).some(name=>readFileSync(join(logs,name),'utf8').includes('startup_failed'));if(failed)break;await new Promise(done=>setTimeout(done,100));}
 assert.ok(failed,'startup failure must be recorded before any library is served');
 const state=await app.evaluate(({BrowserWindow,ipcMain})=>({windows:BrowserWindow.getAllWindows().length,requestHandler:ipcMain._invokeHandlers.has('rivu:request')}));
 assert.equal(state.windows,0);assert.equal(state.requestHandler,false);assert.equal(digest(join(bad,'rivu.db')),before.db);assert.equal(digest(join(bad,'settings.json')),before.settings);assert.equal(readFileSync(join(bad,'restore-journal.json'),'utf8'),'broken journal');
 const closed=app.waitForEvent('close');await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await closed;app=undefined;
 cases.push({case:'corrupt journal startup',status:'PASS',state,pairHashesUnchanged:true,journalRetained:true,scope:'Startup failure log and absent app UI/API, native error dialog buttons not exercised'});
 writeFileSync(output,JSON.stringify({status:'PASS',executable,directory,cases},null,2));console.log('PASS packaged startup recovery and corrupt-journal fail-closed');
}finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}console.log('Fixture:',directory);}
