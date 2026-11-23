import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {_electron as electron} from 'playwright-core';
import AdmZip from 'adm-zip';
import {RivuDatabase} from '../dist-server/database.cjs';
assert.ok(process.env.RIVU_TEST_EXE);
const directory=mkdtempSync(join(tmpdir(),'rivu-export-browser-'));
const scope=relative(resolve(tmpdir()),resolve(directory));assert.ok(scope.startsWith('rivu-export-browser-')&&!scope.startsWith('..')&&!isAbsolute(scope));
const archiveId=randomUUID(),versionId=randomUUID(),base='https://fixture.invalid';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');
const binary=Buffer.from('<!doctype html><script>window.__untrustedExecuted=true</script>Original binary');
const snapshot=Buffer.from('<meta http-equiv="refresh" content="0;url=https://fixture.invalid/beacon"><style>body{display:none}</style><script>window.__untrustedExecuted=true</script><form><input></form><h2>Snapshot text</h2><img src="https://fixture.invalid/beacon">');
const source='<style>body{display:none}</style><script>window.__untrustedExecuted=true</script><h2>Export text 中文</h2><p class="overlay" id="root" data-theme="dark">Safe content</p><input><button>Source control</button><img src="/image.png" alt="Local image"><img src="/beacon"><a href="/linked">Original link</a>';
const db=new RivuDatabase(join(directory,'rivu.db')),feed=db.addFeed({title:'Export fixture',url:base+'/feed',fetchInterval:0});db.addEntries(feed.id,[{title:'Export fixture article',url:base+'/article',content:source,hash:'browser'}]);const id=db.entries()[0].id,now=new Date().toISOString();
db.db.prepare('INSERT INTO permanent_archives(id,source_entry_id,feed_id,feed_title,title,url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(archiveId,id,feed.id,feed.title,'Export fixture archive',base+'/article',now,now);
db.db.prepare('INSERT INTO archive_versions(id,archive_id,content_hash,body_html,created_at) VALUES (?,?,?,?,?)').run(versionId,archiveId,createHash('sha256').update(source).digest('hex'),source,now);
for(const [kind,url,mime,bytes] of [['image',base+'/image.png','image/png',png],['audio',base+'/audio','audio/html',binary],['snapshot',base+'/article','text/html',snapshot]])db.db.prepare('INSERT INTO archive_assets(id,archive_id,version_id,kind,url,mime,bytes,data) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),archiveId,versionId,kind,url,mime,bytes.length,bytes);db.close();
let app;
try{
 app=await electron.launch({executablePath:process.env.RIVU_TEST_EXE,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});let page;const end=Date.now()+30000;while(Date.now()<end){page=app.windows().find(w=>w.url().includes('/index.html'));if(page)break;await new Promise(r=>setTimeout(r,100));}assert.ok(page);
 const destination=join(directory,'export.zip');await app.evaluate(({dialog},path)=>{globalThis.__originalSaveDialog=dialog.showSaveDialog;dialog.showSaveDialog=async()=>({canceled:false,filePath:path});},destination);
 try{assert.equal(await page.evaluate(archiveId=>window.rivu.saveFile('archive',{archiveId}),archiveId),destination);}finally{await app.evaluate(({dialog})=>{dialog.showSaveDialog=globalThis.__originalSaveDialog;delete globalThis.__originalSaveDialog;});}
 const zip=new AdmZip(destination),manifest=JSON.parse(zip.readAsText('metadata.json')),assets=manifest.versions[0].assets,binaryAsset=assets.find(a=>a.kind==='audio'),snapshotAsset=assets.find(a=>a.kind==='snapshot');assert.ok(binaryAsset.path.endsWith('.bin'));assert.equal(binaryAsset.mime,'audio/html');assert.deepEqual(zip.getEntry(binaryAsset.path).getData(),binary);
 const exported=join(directory,'exported');for(const entry of zip.getEntries()){const name=relative(exported,resolve(exported,entry.entryName));assert.ok(!name.startsWith('..')&&!isAbsolute(name));}zip.extractAllTo(exported);
 const downloadPath=join(directory,'received.bin');
 const result=await app.evaluate(async({BrowserWindow,session},args)=>{
   const privateSession=session.fromPartition('export-test-'+Date.now());let requests=0;privateSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{requests++;callback({cancel:true});});
   const win=new BrowserWindow({show:false,webPreferences:{session:privateSession,nodeIntegration:false,contextIsolation:true,sandbox:true}});
   const inspect=()=>win.webContents.executeJavaScript(`({scriptExecuted:!!window.__untrustedExecuted,controls:document.querySelectorAll('script,style,form,input,button,[class],[id],[data-theme]').length,text:document.body.textContent,imageWidth:document.querySelector('img[alt="Local image"]')?.naturalWidth||0,hasBridge:typeof window.rivu!=='undefined'})`);
   try{
     await win.loadURL(args.index);const index=await inspect();
     const downloaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('binary download timeout')),10000);privateSession.once('will-download',(_event,item)=>{item.setSavePath(args.downloadPath);item.once('done',(_event,state)=>{clearTimeout(timer);resolve(state);});});});
     await win.webContents.executeJavaScript(`document.querySelector('a[download]').click()`);const downloadState=await downloaded;const after=await inspect(),indexUnchanged=win.webContents.getURL()===args.index;
     await win.loadURL(args.snapshot);const snapshot=await inspect();return {index,after,snapshot,indexUnchanged,downloadState,requests};
   }finally{win.destroy();privateSession.webRequest.onBeforeRequest(null);privateSession.removeAllListeners('will-download');}
 },{index:pathToFileURL(join(exported,'index.html')).href,snapshot:pathToFileURL(join(exported,snapshotAsset.path)).href,downloadPath});
 console.log(JSON.stringify({packagedExport:true,binaryPath:binaryAsset.path,binaryMime:binaryAsset.mime,...result},null,2));
 for(const view of [result.index,result.after,result.snapshot]){assert.equal(view.scriptExecuted,false);assert.equal(view.controls,0);assert.equal(view.hasBridge,false);}assert.equal(result.index.imageWidth,1);assert.ok(result.index.text.includes('Export text 中文'));assert.ok(result.snapshot.text.includes('Snapshot text'));assert.equal(result.requests,0);assert.equal(result.indexUnchanged,true);assert.equal(result.downloadState,'completed');assert.deepEqual(readFileSync(downloadPath),binary);
 await app.close();app=null;const check=new RivuDatabase(join(directory,'rivu.db'));try{assert.equal(check.entry(id).content,source);assert.equal(check.db.prepare('SELECT body_html FROM archive_versions WHERE id=?').get(versionId).body_html,source);}finally{check.close();}
}finally{await app?.close();rmSync(directory,{recursive:true,force:true});}
