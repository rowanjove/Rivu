import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {execFileSync} from 'node:child_process';
import {DatabaseSync,backup} from 'node:sqlite';
import {_electron as electron,chromium} from 'playwright-core';
import yauzl from 'yauzl';
import {RivuDatabase,SCHEMA_VERSION} from '../dist-server/database.cjs';
import {unreadCountTriggerNames} from '../dist-server/unread-counts.js';
import {buildSync} from 'esbuild';
import {createRequire} from 'node:module';

assert.ok(process.env.RIVU_TEST_EXE,'Run against a verified extracted EXE');
const executable=resolve(process.env.RIVU_TEST_EXE),producerExecutable=resolve(process.env.RIVU_BACKUP_PRODUCER_EXE||executable),directory=mkdtempSync(join(tmpdir(),'rivu-gui-restore-'));
const producerSchema=Number(process.env.RIVU_BACKUP_PRODUCER_SCHEMA||37);
assert.ok([37,39,40].includes(producerSchema),'supported frozen historical producer schema');
const databasePath=join(directory,'rivu.db'),backupPath=join(directory,'gui-backup.zip'),badPath=join(directory,'invalid.zip'),settingsPath=join(directory,'settings.json');
const baseManifest=process.env.RIVU_RESTORE_BASE_MANIFEST,output=process.env.RIVU_RESTORE_DESKTOP_RESULT;
assert.ok(!output||!existsSync(output),'Choose a new report path');
if(baseManifest){
 assert.equal(producerExecutable,executable,'Scale mode uses the current producer');
 const fixture=JSON.parse(readFileSync(baseManifest,'utf8')),source=resolve(fixture.databasePath),inside=relative(resolve('bench-data'),source);
 assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside),'Scale source must be a workspace bench fixture');
 const original=new DatabaseSync(source,{readOnly:true});
 try{assert.equal(original.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(original.prepare('SELECT count(*) n FROM entries').get().n,500000);await backup(original,databasePath);}finally{original.close();}
}
const marker='--rivu-restore-test='+randomUUID(),fakeKey='fixture-only-not-a-provider-key';
const preferences={density:'compact',uiFontSize:'large',theme:'dark',font:'serif',fontSize:18,lineHeight:2,width:680,imageWidth:'column',linkTarget:'ask'};
const seed=new RivuDatabase(databasePath);let id;
try{
 const category=seed.addCategory('恢复分类'),feed=seed.addFeed({title:'恢复来源',url:'https://example.invalid/restore',categoryId:category.id});seed.updateFeed(feed.id,{enabled:false});
 seed.addEntries(feed.id,[{title:'恢复文章😀',content:'<p>原始正文\u0000字节</p>',hash:'restore-one',publishedAt:'2026-01-01'}]);id=seed.entries({feedId:feed.id})[0].id;
 seed.setFullContent(id,'<article>完整正文😀\u0000原始字节</article>');seed.updateEntry(id,{saved:true});seed.saveReadingPosition(id,0.42);
 const tag=seed.addTag('恢复标签');seed.setEntryTags(id,[tag.id]);
 if(producerExecutable!==executable){
  const installer=`tests/fixtures/schema${producerSchema}-unread.ts`,hashes={37:'954b8853f13ffe1e38e5dcfda6a5d638317537dcecc1e2e50ef07e1302705e7e',39:'b95ee00e140eff6b1f32e6316e292be083fec0aba31b9809efaf130f86628e2a',40:'162540c8486a2f0cfbdac77b5f1a40da34bcd04cb792ef16cac88a791bd810da'};
  assert.equal(createHash('sha256').update(readFileSync(installer)).digest('hex'),hashes[producerSchema]);
  const oldModule=join(directory,`schema${producerSchema}.cjs`);buildSync({entryPoints:[installer],outfile:oldModule,bundle:true,platform:'node',format:'cjs'});
  seed.db.exec('BEGIN');for(const name of unreadCountTriggerNames)seed.db.exec(`DROP TRIGGER ${name}`);
  seed.db.exec('DROP TABLE rivu_entry_visibility;DROP TABLE rivu_feed_unread_counts;DROP TABLE rivu_source_entry_counts;DROP TABLE rivu_timeline_bucket_counts;DROP TABLE rivu_feed_timeline_bucket_counts;DROP TABLE IF EXISTS rivu_category_timeline_bucket_counts');
  createRequire(import.meta.url)(oldModule).installUnreadCounts(seed.db);seed.db.exec(`PRAGMA user_version=${producerSchema};COMMIT`);
 }
}finally{seed.close();}
writeFileSync(settingsPath,JSON.stringify({reading:preferences,ai:{apiKey:fakeKey,credentialId:'fixture-credential'}}));writeFileSync(badPath,'not-a-zip');
function state(){const db=new DatabaseSync(databasePath,{readOnly:true});try{return Object.fromEntries(['ai_conversations','ai_filter_decisions','ai_messages','ai_results','ai_rule_jobs','ai_rules','app_meta','archive_assets','archive_versions','cached_images','categories','entries','entry_identities','entry_media','entry_tags','feed_icon_keys','feeds','newsletter_files','offline_saves','permanent_archives','reading_positions','rsshub_instances','rule_matches','rules','smart_folders','tags','rivu_entry_visibility','rivu_feed_unread_counts','rivu_source_entry_counts'].map(table=>{
 const hash=createHash('sha256');let count=0;
 const sql=table==='entries'?'SELECT *,hex(CAST(content AS BLOB)) raw_content,hex(CAST(full_content AS BLOB)) raw_full_content FROM entries ORDER BY id':`SELECT * FROM ${table} ORDER BY rowid`;
 const statement=db.prepare(sql);statement.setReadBigInts(true);
 for(const row of statement.iterate()){hash.update(JSON.stringify(row,(_key,value)=>typeof value==='bigint'?{$sqliteInteger:String(value)}:value)+'\n');count++;}
 return [table,{count,sha256:hash.digest('hex')}];
 }));}finally{db.close();}}
async function zipMetadata(){const zip=await yauzl.openPromise(backupPath,{strictFileNames:true,validateEntrySizes:true}),result={};try{for await(const entry of zip.eachEntry())if(['manifest.json','settings.json'].includes(entry.fileName)){assert.ok(entry.uncompressedSize<=1024*1024);const chunks=[];let bytes=0;for await(const chunk of await zip.openReadStreamPromise(entry)){bytes+=chunk.length;assert.ok(bytes<=1024*1024);chunks.push(chunk);}result[entry.fileName]=Buffer.concat(chunks).toString('utf8');}}finally{zip.close();}return result;}
const settingsDigest=()=>createHash('sha256').update(readFileSync(settingsPath)).digest('hex');
async function windowOf(application){const deadline=Date.now()+30000;while(Date.now()<deadline){const page=application.windows().find(p=>p.url().includes('/index.html'));if(page){await page.waitForFunction(()=>!!window.rivu);return page;}await new Promise(r=>setTimeout(r,100));}throw Error('No main window');}
async function configureDialogs(application,path,response=0,canceled=false){await application.evaluate(({dialog},{path,response,canceled})=>{globalThis.__restoreWarnings=[];dialog.showOpenDialog=async()=>({canceled,filePaths:canceled?[]:[path]});dialog.showMessageBox=async(_window,options)=>{globalThis.__restoreWarnings.push(options);return {response,checkboxChecked:false};};},{path,response,canceled});}
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function waitStopped(pid){const end=Date.now()+5000;while(alive(pid)&&Date.now()<end)await new Promise(r=>setTimeout(r,100));return !alive(pid);}
async function boundedClose(promise){await new Promise(resolve=>{const timer=setTimeout(resolve,1000);promise.then(()=>{clearTimeout(timer);resolve();},()=>{clearTimeout(timer);resolve();});});}
async function finished(application,count){const started=Date.now(),deadline=started+(baseManifest?180000:15000);while(Date.now()<deadline){if((await application.evaluate(()=>globalThis.__restoresFinished))>=count){console.log(JSON.stringify({phase:'restore-ipc-finished',count,ms:Date.now()-started}));return;}await new Promise(r=>setTimeout(r,50));}throw Error('Restore IPC did not finish');}
let application,remote,session,restartedPid,passed=false;
try{
 application=await electron.launch({executablePath:producerExecutable,args:['--no-sandbox',marker],env:{...process.env,RIVU_DATA_DIR:directory}});
 let page=await windowOf(application);await page.locator('.entry-row').first().waitFor();
 await application.evaluate(({ipcMain})=>{const handler=ipcMain._invokeHandlers.get('rivu:choose-file');globalThis.__restoresFinished=0;globalThis.__restoreCalls=0;ipcMain._invokeHandlers.set('rivu:choose-file',async(...args)=>{const callId=++globalThis.__restoreCalls;try{return await handler(...args);}catch(error){if(callId===globalThis.__observedRestoreCall)globalThis.__restoreFailure=String(error);throw error;}finally{globalThis.__restoresFinished++;}});});
 // Exercise all retained reader roles before restore to prove handles are drained.
 await page.evaluate(async id=>{for(const path of ['/api/entries?offset=1',`/api/entries/${id}`,'/api/feeds?icons=metadata'])await window.rivu.request('GET',path);},id);
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.locator('#settings-backup').scrollIntoViewIfNeeded();
 assert.equal(await page.getByRole('checkbox',{name:'在备份中包含 AI 密钥'}).isChecked(),false);
 await application.evaluate(({dialog},path)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:path});},backupPath);
 await page.getByRole('button',{name:'备份数据库',exact:true}).click();await page.getByRole('status').filter({hasText:'备份已保存'}).waitFor({timeout:180000});
 const metadata=await zipMetadata(),backupSettings=JSON.parse(metadata['settings.json']),manifest=JSON.parse(metadata['manifest.json']);
 assert.equal(manifest.includesSecrets,false);assert.equal(backupSettings.ai.apiKey,undefined);assert.equal(backupSettings.ai.credentialId,undefined);assert.equal(metadata['settings.json'].includes(fakeKey),false);
 if(producerExecutable!==executable){
  assert.equal(manifest.schemaVersion,producerSchema);await application.close();
  application=await electron.launch({executablePath:executable,args:['--no-sandbox',marker],env:{...process.env,RIVU_DATA_DIR:directory}});page=await windowOf(application);await page.locator('.entry-row').first().waitFor();
  await application.evaluate(({ipcMain})=>{const handler=ipcMain._invokeHandlers.get('rivu:choose-file');globalThis.__restoresFinished=0;globalThis.__restoreCalls=0;ipcMain._invokeHandlers.set('rivu:choose-file',async(...args)=>{const callId=++globalThis.__restoreCalls;try{return await handler(...args);}catch(error){if(callId===globalThis.__observedRestoreCall)globalThis.__restoreFailure=String(error);throw error;}finally{globalThis.__restoresFinished++;}});});
  await page.evaluate(async id=>{for(const path of ['/api/entries?offset=1',`/api/entries/${id}`,'/api/feeds?icons=metadata'])await window.rivu.request('GET',path);},id);
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.locator('#settings-backup').scrollIntoViewIfNeeded();
 }
 const original=state();
 await page.evaluate(async id=>{await window.rivu.request('PATCH',`/api/entries/${id}`,{read:true,starred:true,saved:false});await window.rivu.request('PATCH','/api/reading/settings',{theme:'light',fontSize:14});},id);
 const changed=state(),changedSettings=settingsDigest();assert.notDeepEqual(changed,original);
 await configureDialogs(application,backupPath,0,true);await page.getByRole('button',{name:'恢复备份',exact:true}).click();await finished(application,1);
 assert.deepEqual(state(),changed);assert.equal(settingsDigest(),changedSettings);assert.equal((await application.evaluate(()=>globalThis.__restoreWarnings)).length,0);
 await configureDialogs(application,backupPath,0);await page.getByRole('button',{name:'恢复备份',exact:true}).click();
 await finished(application,2);const warningDeadline=Date.now()+10000;while(Date.now()<warningDeadline&&(await application.evaluate(()=>globalThis.__restoreWarnings.length))===0)await new Promise(r=>setTimeout(r,50));
 const warnings=await application.evaluate(()=>globalThis.__restoreWarnings);assert.equal(warnings.length,1);assert.match(warnings[0].message,/替换当前数据库/);assert.match(warnings[0].detail,/设置也将替换当前设置/);assert.equal(warnings[0].defaultId,0);
 assert.deepEqual(state(),changed);assert.equal(settingsDigest(),changedSettings);
 await configureDialogs(application,badPath,1);await page.getByRole('button',{name:'恢复备份',exact:true}).click();await page.getByRole('alert').waitFor();await finished(application,3);
 assert.equal((await application.evaluate(()=>globalThis.__restoreWarnings)).length,0);assert.deepEqual(state(),changed);assert.equal(settingsDigest(),changedSettings);assert.equal((await page.evaluate(()=>window.rivu.request('GET','/health'))).ok,true);
 await page.getByRole('alert').getByRole('button').click();
 const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
 await configureDialogs(application,backupPath,1);
 if(process.env.RIVU_RESTORE_SHUTDOWN_PROBE==='1'){
  const fixtureTask=join(directory,'restore-copy-probe.cjs');
  writeFileSync(fixtureTask,`const {workerData}=require('node:worker_threads');
const barrier=new Int32Array(workerData.fixtureBarrier),fs=require('node:fs/promises'),copy=fs.copyFile;
fs.copyFile=async(...args)=>{if(String(args[1]).includes('before-restore-')&&String(args[1]).endsWith('.db')){Atomics.store(barrier,0,1);while(Atomics.load(barrier,1)===0)Atomics.wait(barrier,1,0);}return copy(...args);};
module.exports=require(workerData.fixtureOriginalModule);
`);
  await application.evaluate((_electron,fixtureTask)=>{
   const threads=process.getBuiltinModule('node:worker_threads'),Original=threads.Worker,barrier=new SharedArrayBuffer(8),state=new Int32Array(barrier);
   Object.defineProperty(globalThis,'__restoreCopyHeld',{get:()=>Atomics.load(state,0)===1,configurable:true});
   globalThis.__releaseRestoreCopy=()=>{Atomics.store(state,1,1);Atomics.notify(state,1);};
   threads.Worker=class extends Original{constructor(file,options){if(options?.workerData?.operation==='restore')options={...options,workerData:{...options.workerData,modulePath:fixtureTask,fixtureOriginalModule:options.workerData.modulePath,fixtureBarrier:barrier}};super(file,options);}};
  },fixtureTask);
 }

 // Use the real Electron relaunch/exit. Only its args add a unique CDP port for
 // observation of the independently relaunched process; never launch it manually.
 await application.evaluate(({app},{port,marker})=>{const relaunch=app.relaunch.bind(app);app.relaunch=()=>relaunch({args:['--no-sandbox',marker,`--remote-debugging-port=${port}`]});},{port,marker});
 // Large restore includes another preflight, validation and a full rollback
 // copy. Observe this functional workflow separately from search/image gates.
 const restoreObservationMs=baseManifest?600000:300000;
 const oldPid=application.process().pid,closed=application.waitForEvent('close',{timeout:restoreObservationMs});
 // Observe only the restore IPC: unrelated settings polls fail as expected
 // while the local service is deliberately stopped for database replacement.
 await application.evaluate(()=>{globalThis.__restoreFailure=null;globalThis.__observedRestoreCall=globalThis.__restoreCalls+1;});
 let observing=true;closed.then(()=>{observing=false;},()=>{observing=false;});
 const failed=(async()=>{while(observing){const error=await application.evaluate(()=>globalThis.__restoreFailure);if(error)throw Error('Restore IPC error: '+error);await new Promise(done=>setTimeout(done,100));}return closed;})().catch(error=>{
  // Normal relaunch destroys the page before the application's close event.
  if(/Target page, context or browser has been closed/i.test(String(error)))return closed;
  throw error;
 });
 const outcome=Promise.race([closed,failed]);
 await page.getByRole('button',{name:'恢复备份',exact:true}).click().catch(error=>{if(!/closed|destroyed/i.test(String(error)))throw error;});
 if(process.env.RIVU_RESTORE_SHUTDOWN_PROBE==='1'){
  const deadline=Date.now()+30000;let held=false;while(Date.now()<deadline){held=await application.evaluate(()=>globalThis.__restoreCopyHeld);if(held)break;await new Promise(done=>setTimeout(done,50));}assert.ok(held,'must pause the actual rollback-copy path');
  const blocked=await application.evaluate(({app,BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());window.close();app.quit();return !window.isDestroyed();});assert.equal(blocked,true,'window close and app quit must be blocked during replacement');
  const duplicate=await page.evaluate(()=>window.rivu.chooseFile('backup').then(()=>'',error=>String(error)));assert.match(duplicate,/已有备份恢复任务/);
  await new Promise(done=>setTimeout(done,5500));
  assert.equal(await page.getByRole('alert').count(),0,'settings polling must not report expected service shutdown during restore');
  await application.evaluate(()=>globalThis.__releaseRestoreCopy());
 }
 await outcome;application=undefined;assert.ok(await waitStopped(oldPid));
 const endpoint=`http://127.0.0.1:${port}`,deadline=Date.now()+60000;let ready=false;
 while(Date.now()<deadline){try{const result=await fetch(endpoint+'/json/version');if(result.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'real auto-relaunch must expose the new process');
 remote=await chromium.connectOverCDP(endpoint);session=await remote.newBrowserCDPSession();const info=await session.send('SystemInfo.getProcessInfo');restartedPid=Number(info.processInfo.find(p=>p.type==='browser').id);assert.ok(restartedPid&&restartedPid!==oldPid);
 let restored;const pageDeadline=Date.now()+30000;while(Date.now()<pageDeadline){restored=remote.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('/index.html'));if(restored)break;await new Promise(r=>setTimeout(r,100));}assert.ok(restored);await restored.waitForFunction(()=>!!window.rivu);
 const health=await restored.evaluate(()=>window.rivu.request('GET','/health'));assert.equal(health.ok,true);assert.deepEqual(state(),original);
 const reading=await restored.evaluate(()=>window.rivu.request('GET','/api/reading/settings'));assert.deepEqual(reading.preferences,preferences);const recovered=JSON.parse(readFileSync(settingsPath,'utf8'));assert.equal(recovered.ai.apiKey,undefined);assert.equal(recovered.ai.credentialId,undefined);
 const report=JSON.parse(readFileSync(join(directory,'restore-report.json'),'utf8'));assert.ok(report.completedAt);assert.ok(report.durationMs>=0);assert.ok(report.backupBytes>0);
 const restoredDatabase=new DatabaseSync(databasePath,{readOnly:true});let restoredSchemaVersion;try{restoredSchemaVersion=restoredDatabase.prepare('PRAGMA user_version').get().user_version;assert.equal(restoredSchemaVersion,SCHEMA_VERSION);}finally{restoredDatabase.close();}
 const returned=await restored.evaluate(id=>window.rivu.request('GET',`/api/entries/${id}`),id);assert.equal(returned.read,0);assert.equal(returned.starred,0);assert.equal(returned.saved,1);
 await boundedClose(session.send('Browser.close'));assert.ok(await waitStopped(restartedPid),'CDP close must exit the owned relaunched fixture process');if(remote.isConnected())await boundedClose(remote.close());remote=undefined;session=undefined;
 const evidence={status:'PASS',directory,backupSchemaVersion:manifest.schemaVersion,restoredSchemaVersion,baseManifest:baseManifest||null,backupBytes:statSync(backupPath).size,restoreDurationMs:report.durationMs,tableDigests:original,historicalProducer:producerExecutable!==executable,guiBackup:true,defaultSecretsExcluded:true,filePickerCancelPreserved:true,confirmationCancelPreserved:true,invalidPreflightPreserved:true,realRestore:true,realAutomaticRelaunch:true,oldProcessExited:true,allSeedTablesAndRawBodyBytesRestored:true,readingPreferencesRestored:true,restoredProviderKeyAbsent:true,threeReaderRolesDrained:true,nativeDialogsStubbed:true,ownedRelaunchedProcessClosed:true};
 if(output)writeFileSync(output,JSON.stringify(evidence,null,2));passed=true;console.log(JSON.stringify(evidence));
}catch(error){
 if(output)writeFileSync(output,JSON.stringify({status:'FAIL',directory,baseManifest:baseManifest||null,error:String(error)},null,2));
 throw error;
}finally{
 if(process.env.RIVU_RESTORE_SHUTDOWN_PROBE==='1')try{await application?.evaluate(()=>globalThis.__releaseRestoreCopy?.());}catch{}
 try{await application?.close();}catch{}
 try{if(session)await boundedClose(session.send('Browser.close'));}catch{}try{if(remote?.isConnected())await boundedClose(remote.close());}catch{}
 if(restartedPid&&alive(restartedPid)){
  const raw=execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter "ProcessId = ${restartedPid}" | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`],{encoding:'utf8'}).trim();const processInfo=raw?JSON.parse(raw):null;
  if(processInfo&&resolve(processInfo.ExecutablePath).toLowerCase()===executable.toLowerCase()&&processInfo.CommandLine.includes(marker))process.kill(restartedPid);
 }
 if(passed)rmSync(directory,{recursive:true,force:true});else console.error('Failure fixture preserved:',directory);
}
