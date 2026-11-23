import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import yauzl from 'yauzl';
import {chromium} from 'playwright-core';

const directory=resolve(process.env.RIVU_RESTORE_AUDIT_DIR||''),inside=relative(tmpdir(),directory),output=process.env.RIVU_RESTORE_AUDIT_RESULT;
const pid=Number(process.env.RIVU_RESTORE_AUDIT_PID),port=Number(process.env.RIVU_RESTORE_AUDIT_PORT);
assert.ok(output&&!existsSync(output)&&inside.startsWith('rivu-gui-restore-')&&!inside.includes('..')&&!isAbsolute(inside));
assert.ok(Number.isSafeInteger(pid)&&pid>0&&Number.isInteger(port)&&port>0&&port<65536);
const processInfo=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`],{encoding:'utf8'}));
const candidate=JSON.parse(readFileSync('artifacts/rivu-directory-latest.json','utf8'));
assert.equal(resolve(processInfo.ExecutablePath).toLowerCase(),resolve(candidate.executablePath).toLowerCase());
assert.ok(processInfo.CommandLine.includes('--rivu-restore-test=')&&processInfo.CommandLine.includes(`--remote-debugging-port=${port}`));
const staging=mkdtempSync(join(resolve('bench-data'),'rivu-restore-audit-'));
const report={status:'running',directory,staging,pid,port,candidate,restore:JSON.parse(readFileSync(join(directory,'restore-report.json'),'utf8')),tables:[],scope:'Independent post-relaunch audit of an owned actual desktop process after original UI observer falsely failed; original harness remains FAIL; raw backup/current29table digests, API/preferences and owned process closure checked separately'};
const save=()=>writeFileSync(output,JSON.stringify(report,null,2));save();let browser,session;
const bounded=promise=>Promise.race([promise.catch(()=>{}),new Promise(done=>setTimeout(done,1000))]);
const tables=['ai_conversations','ai_filter_decisions','ai_messages','ai_results','ai_rule_jobs','ai_rules','app_meta','archive_assets','archive_versions','cached_images','categories','entries','entry_identities','entry_media','entry_tags','feed_icon_keys','feeds','newsletter_files','offline_saves','permanent_archives','reading_positions','rsshub_instances','rule_matches','rules','smart_folders','tags','rivu_entry_visibility','rivu_feed_unread_counts','rivu_source_entry_counts'];
function digest(db,table){
 const statement=db.prepare(table==='entries'?'SELECT *,hex(CAST(content AS BLOB)) raw_content,hex(CAST(full_content AS BLOB)) raw_full_content FROM entries ORDER BY id':`SELECT * FROM ${table} ORDER BY rowid`);statement.setReadBigInts(true);
 const hash=createHash('sha256');let count=0;for(const row of statement.iterate()){hash.update(JSON.stringify(row,(_key,value)=>typeof value==='bigint'?{$sqliteInteger:String(value)}:value)+'\n');count++;}return {count,sha256:hash.digest('hex')};
}
try{
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);session=await browser.newBrowserCDPSession();
 const processes=await session.send('SystemInfo.getProcessInfo');assert.equal(Number(processes.processInfo.find(p=>p.type==='browser').id),pid);
 let page;const pageDeadline=Date.now()+300000;
 while(Date.now()<pageDeadline){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,100));}
 assert.ok(page,'Owned relaunched library must become ready within the functional audit window');await page.waitForFunction(()=>!!window.rivu);
 assert.equal((await page.evaluate(()=>window.rivu.request('GET','/health'))).ok,true);
 const zip=await yauzl.openPromise(join(directory,'gui-backup.zip'),{strictFileNames:true,validateEntrySizes:true});let backupSettings;
 try{for await(const entry of zip.eachEntry()){
  if(entry.fileName==='rivu.db'){assert.ok(entry.uncompressedSize<=20*1024**3);await pipeline(await zip.openReadStreamPromise(entry),createWriteStream(join(staging,'rivu.db'),{flags:'wx'}));}
  if(entry.fileName==='settings.json'){assert.ok(entry.uncompressedSize<=1024**2);const chunks=[];for await(const chunk of await zip.openReadStreamPromise(entry))chunks.push(chunk);backupSettings=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 }}finally{zip.close();}
 assert.ok(backupSettings);const expected=new DatabaseSync(join(staging,'rivu.db'),{readOnly:true}),actual=new DatabaseSync(join(directory,'rivu.db'),{readOnly:true});let id;
 try{
  expected.exec('BEGIN');actual.exec('BEGIN');assert.equal(actual.prepare('PRAGMA user_version').get().user_version,43);
  for(const table of tables){const wanted=digest(expected,table),observed=digest(actual,table);assert.deepEqual(observed,wanted,table);report.tables.push({table,...observed});save();}
  assert.equal(report.tables.find(t=>t.table==='entries').count,500001);assert.equal(report.tables.find(t=>t.table==='ai_results').count,50000);
  assert.equal(actual.prepare('PRAGMA foreign_key_check').all().length,0);
  const row=actual.prepare('SELECT id,read,starred,saved FROM entries INDEXED BY entries_list_metadata WHERE title=?').get('恢复文章😀');assert.ok(row);assert.deepEqual({read:row.read,starred:row.starred,saved:row.saved},{read:0,starred:0,saved:1});id=row.id;
 }finally{actual.close();expected.close();}
 const reading=await page.evaluate(()=>window.rivu.request('GET','/api/reading/settings'));assert.deepEqual(reading.preferences,backupSettings.reading);
 const recovered=JSON.parse(readFileSync(join(directory,'settings.json'),'utf8'));assert.equal(recovered.ai.apiKey,undefined);assert.equal(recovered.ai.credentialId,undefined);
 const entry=await page.evaluate(id=>window.rivu.request('GET',`/api/entries/${id}`),id);assert.deepEqual({read:entry.read,starred:entry.starred,saved:entry.saved},{read:0,starred:0,saved:1});
 report.apiAndSettings=true;report.status='PASS-post-relaunch-audit';save();
}catch(error){report.status='FAIL';report.error=String(error);save();throw error;}
finally{
 if(session)await bounded(session.send('Browser.close'));if(browser?.isConnected())await bounded(browser.close());
 const deadline=Date.now()+10000;let alive=true;while(Date.now()<deadline){try{process.kill(pid,0);}catch{alive=false;break;}await new Promise(done=>setTimeout(done,100));}report.ownedRelaunchedProcessClosed=!alive;
 if(alive&&report.status==='PASS-post-relaunch-audit')report.status='FAIL-owned-process-still-live';save();
}
assert.equal(report.status,'PASS-post-relaunch-audit');
