import {externalUrl,INVALID_EXTERNAL_LINK,EXTERNAL_OPEN_ERROR} from '../shared/external-url';
// The build script runs before electron:build; esbuild embeds this JSON in the
// main bundle so packaged builds do not depend on a source-tree file at runtime.
import buildInfo from '../shared/build-info.json' with { type: 'json' };
import {readImageResponse} from './image-response';
import {expectedRendererUrl,isAuthorizedRendererUrl} from './renderer-issuer';
import {prepareLocalRequestRuntime} from './local-request-runtime';
import {NativeImageProtocol,type NativeImageRead} from './image-protocol';
import {createDirectImageFetch} from './image-direct';
import {isEntryRead,isEntryResult,isBulkReadWrite,isFeedCategoryWrite,isFeedPatch,isCategoryDelete,isImageRead} from './entry-transport';
import { app, BrowserWindow, dialog, ipcMain, shell, protocol, session, Menu } from 'electron';
protocol.registerSchemesAsPrivileged([{scheme:'rivu-image',privileges:{standard:true,secure:true}}]);
let nativeImageFetch:(url:string,init:RequestInit)=>Promise<Response>=async()=>{throw Error('图片服务暂不可用');};
let nativeImageRead:NativeImageRead=async()=>{throw Error('图片服务暂不可用');};
let nativeProtocolRegistered=false;
const nativeImages=new NativeImageProtocol((url,init)=>nativeImageFetch(url,init),app.isPackaged?'file://':'http://127.0.0.1:5173');
let unsubscribeImageState:(()=>void)|undefined;
import { join, resolve } from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { RivuDatabase, SCHEMA_VERSION } from '../server/database';
import { createService } from '../server/service';
import { exportOpml, importOpml, previewOpml, type OpmlImportOptions } from '../server/opml';
import { createBackup } from '../server/backup';
import {inspectBackupInWorker,restoreBackupInWorker,recoverRestoreInWorker,withBackupSnapshot} from './backup-inspection';
import {BackupRestoreSession} from './backup-restore-session';

import { LocalLogs, logErrorType } from '../server/local-logs';
import { directFetch } from '../server/direct-fetch';

let win:BrowserWindow|null=null;
app.on('accessibility-support-changed',(_event,enabled)=>{if(win&&!win.isDestroyed())win.webContents.send('rivu:accessibility-changed',enabled);});
let db:RivuDatabase;
let service:ReturnType<typeof createService>;
let logs:LocalLogs|null=null;
let baseUrl='';
let pendingOpml:{id:string;xml:string}|null=null;
let pendingNewsletter:{id:string;url:string;createdAt:number}|null=null;
let starting=true;
const backupRestoreSession=new BackupRestoreSession();
if(process.env.RIVU_DATA_DIR){const isolated=resolve(process.env.RIVU_DATA_DIR);mkdirSync(isolated,{recursive:true});app.setPath('userData',isolated);}
const dataDir=()=>join(app.getPath('userData'));
const trustedRendererUrl=expectedRendererUrl(app.isPackaged,__dirname);
const runtimeRequire=createRequire(__filename);
const projectUndiciVersion=(()=>{try{const packageInfo=runtimeRequire('undici/package.json') as {version?:unknown};return typeof packageInfo.version==='string'?packageInfo.version:'unknown';}catch{return 'unknown';}})();
const windowIcon=()=>app.isPackaged?join(process.resourcesPath,'icons','rivu.ico'):join(__dirname,'../assets/rivu.ico');
const recoverPendingRestore=()=>recoverRestoreInWorker(app.isPackaged?join(process.resourcesPath,'app.asar.unpacked','dist-electron','backup-inspection-worker.cjs'):join(__dirname,'backup-inspection-worker.cjs'),join(__dirname,'backup-inspection-task.cjs'),dataDir());
const prepareDatabase=async()=>{
  const splash=new BrowserWindow({icon:windowIcon(),autoHideMenuBar:true,titleBarStyle:'hidden',titleBarOverlay:{color:'#161b21',symbolColor:'#e8edf2',height:32},width:560,height:280,resizable:false,closable:false,backgroundColor:'#161b21',show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  // The progress renderer is optional UI; database preparation must not wait for it.
  const splashReady=splash.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;padding:44px 36px 32px;background:#161b21;color:#e8edf2;font:14px/1.6 "Segoe UI Variable","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif}h1{font-size:20px;font-weight:650;letter-spacing:-0.02em;margin:0 0 14px}p{line-height:1.65;color:#bcc7d2;margin:0 0 16px}small{color:#9aaab9;font-variant-numeric:tabular-nums}</style><div style="position:fixed;inset:0 0 auto;height:32px;-webkit-app-region:drag"></div><h1>Rivu 正在准备本地数据库</h1><p id="stage">正在检查本地数据库。首次升级可能需要几分钟，请保持应用运行。</p><small id="elapsed">已用 0 秒</small><script>const started=Date.now();setInterval(()=>document.getElementById('elapsed').textContent='已用 '+Math.floor((Date.now()-started)/1000)+' 秒',1000)</script></html>`));
  // A fast worker may finish and destroy the splash before loadURL settles.
  void splashReady.catch(()=>{});
  const workerPath=app.isPackaged?join(process.resourcesPath,'app.asar.unpacked','dist-electron','startup-worker.cjs'):join(__dirname,'startup-worker.cjs');
  const modulePath=app.isPackaged?join(process.resourcesPath,'app.asar','dist-electron','startup-database.cjs'):join(__dirname,'startup-database.cjs');
  const showTimer=setTimeout(()=>{void splashReady.then(()=>{if(!splash.isDestroyed())splash.show();}).catch(()=>{});},250);
  try{
    await new Promise<void>((resolve,reject)=>{
      const worker=new Worker(workerPath,{workerData:{databasePath:join(dataDir(),'rivu.db'),modulePath}});
      let settled=false;
      worker.on('message',(message:{phase?:'snapshot'|'schema'|'index'|'verify'|'done';done?:boolean;error?:string})=>{
        if(settled)return;
        const labels={snapshot:'正在保留迁移前快照',schema:'正在迁移数据库结构',index:'正在准备本地索引与统计',verify:'正在校验升级结果',done:'数据库升级完成'};
        if(message.phase){const label=labels[message.phase];if(label)void splashReady.then(()=>{if(!splash.isDestroyed())return splash.webContents.executeJavaScript(`document.getElementById('stage').textContent=${JSON.stringify(label)}`);}).catch(()=>{});return;}
        settled=true;if(message.done)resolve();else reject(Error(message.error||'数据库准备失败'));
      });
      worker.on('error',error=>{if(!settled){settled=true;reject(error);}});
      worker.on('exit',code=>{if(!settled){settled=true;reject(Error(`数据库准备进程退出（${code}）`));}});
    });
  }finally{clearTimeout(showTimer);if(!splash.isDestroyed())splash.destroy();}
};
const startLocalService=async()=>{const maintenanceWorker=app.isPackaged?join(process.resourcesPath,'app.asar.unpacked','dist-electron','maintenance-worker.cjs'):join(__dirname,'maintenance-worker.cjs');const feedParseWorker=app.isPackaged?join(process.resourcesPath,'app.asar.unpacked','dist-electron','feed-parse-worker.cjs'):join(__dirname,'feed-parse-worker.cjs');const feedParseTask=app.isPackaged?join(process.resourcesPath,'app.asar','dist-electron','feed-parse-task.cjs'):join(__dirname,'feed-parse-task.cjs');const feedWriteWorker=app.isPackaged?join(process.resourcesPath,'app.asar.unpacked','dist-electron','feed-write-worker.cjs'):join(__dirname,'feed-write-worker.cjs');const feedWriteTask=app.isPackaged?join(process.resourcesPath,'app.asar','dist-electron','feed-write-task.cjs'):join(__dirname,'feed-write-task.cjs');service=createService(db,undefined,join(dataDir(),'settings.json'),dataDir(),maintenanceWorker,logs??undefined,feedParseWorker,feedParseTask,feedWriteWorker,feedWriteTask,app.isPackaged?join(process.resourcesPath,'app.asar.unpacked','dist-electron','archive-export-worker.cjs'):join(__dirname,'archive-export-worker.cjs'),app.isPackaged?join(process.resourcesPath,'app.asar','dist-electron','archive-export-task.cjs'):join(__dirname,'archive-export-task.cjs'),app.isPackaged?join(process.resourcesPath,'app.asar.unpacked','dist-electron','archive-read-worker.cjs'):join(__dirname,'archive-read-worker.cjs'),app.isPackaged?join(process.resourcesPath,'app.asar','dist-electron','archive-read-task.cjs'):join(__dirname,'archive-read-task.cjs'),app.isPackaged?join(process.resourcesPath,'app.asar.unpacked','dist-electron','ai-scan-worker.cjs'):join(__dirname,'ai-scan-worker.cjs'),app.isPackaged?join(process.resourcesPath,'app.asar','dist-electron','ai-scan-task.cjs'):join(__dirname,'ai-scan-task.cjs'),app.isPackaged?join(process.resourcesPath,'app.asar.unpacked','dist-electron','entry-read-worker.cjs'):join(__dirname,'entry-read-worker.cjs'),app.isPackaged?join(process.resourcesPath,'app.asar','dist-electron','entry-read-task.cjs'):join(__dirname,'entry-read-task.cjs'),app.isPackaged?join(process.resourcesPath,'app.asar','dist-electron','image-url-task.cjs'):join(__dirname,'image-url-task.cjs'));const started=await service.start();const address=started.address;if(!address||typeof address==='string')throw Error('本地服务启动失败');baseUrl=`http://127.0.0.1:${address.port}`;unsubscribeImageState?.();const currentService=service,currentBase=baseUrl;nativeImageRead=currentService.readNativeImage;nativeImageFetch=createDirectImageFetch({baseUrl:currentBase,token:currentService.token,read:currentService.readNativeImage});unsubscribeImageState=service.onImageAvailability(available=>{if(service===currentService)nativeImages.setEndpoint(available?{baseUrl:currentBase,token:currentService.token}:null);});};
const createWindow=()=>{
  win=new BrowserWindow({icon:windowIcon(),autoHideMenuBar:true,titleBarStyle:'hidden',titleBarOverlay:{color:'#00000000',symbolColor:'#181e24',height:32},width:1440,height:900,minWidth:400,minHeight:600,backgroundColor:'#fafbfc',show:false,webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,additionalArguments:[`--rivu-accessibility=${app.isAccessibilitySupportEnabled()?1:0}`]}});
  win.webContents.on('did-finish-load',()=>{if(win&&!win.isDestroyed())win.webContents.send('rivu:accessibility-changed',app.isAccessibilitySupportEnabled());});
  win.on('close',event=>{if(backupRestoreSession.committing)event.preventDefault();});
  win.webContents.on('did-start-navigation',details=>{if(details.isMainFrame&&!details.isSameDocument)nativeImages.rotate();});
  win.webContents.on('did-navigate',()=>nativeImages.rotate());
  win.webContents.on('destroyed',()=>nativeImages.rotate());
  const sourceContents=win.webContents;sourceContents.setWindowOpenHandler(({url})=>{const notify=(message:string)=>{if(!sourceContents.isDestroyed())sourceContents.send('rivu:external-error',message);};const target=externalUrl(url);if(target)void Promise.resolve().then(()=>shell.openExternal(target)).catch(()=>notify(EXTERNAL_OPEN_ERROR));else notify(INVALID_EXTERNAL_LINK);return {action:'deny'};});
  win.webContents.on('will-navigate',(event,url)=>{if(!isAuthorizedRendererUrl(url,trustedRendererUrl))event.preventDefault();});
  win.once('ready-to-show',()=>win?.show());
  if(!app.isPackaged)win.loadURL('http://127.0.0.1:5173/');else win.loadFile(join(__dirname,'../dist/index.html'));
};
app.whenReady().then(async()=>{
  Menu.setApplicationMenu(null);
  prepareLocalRequestRuntime(__filename);
  mkdirSync(dataDir(),{recursive:true});try{logs=await LocalLogs.open(dataDir());}catch{logs=null;}void logs?.write('app','startup_begin',{buildId:buildInfo.buildId,appVersion:app.getVersion(),runtimeVersion:process.versions.electron}).catch(()=>{});await recoverPendingRestore();await prepareDatabase();db=new RivuDatabase(join(dataDir(),'rivu.db'),undefined,true);await startLocalService();void logs?.write('app','startup_ready').catch(()=>{});
  session.defaultSession.protocol.handle('rivu-image',request=>nativeImages.handle(request));nativeProtocolRegistered=true;
  const assertRendererIssuer=(event:Electron.IpcMainInvokeEvent)=>{
    if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw Error('渲染器窗口无效');
    if(!isAuthorizedRendererUrl(event.senderFrame.url,trustedRendererUrl))throw Error('渲染器页面无效');
  };
  const assertImageIssuer=(event:Electron.IpcMainInvokeEvent)=>{
    try{assertRendererIssuer(event);}catch(error){throw Error(error instanceof Error?error.message:'图片窗口无效');}
  };
  ipcMain.handle('rivu:diagnostics',event=>{
    assertRendererIssuer(event);
    return {
      build:{version:buildInfo.appVersion,buildId:buildInfo.buildId,builtAt:buildInfo.buildDate,sourceHash:buildInfo.sourceHash},
      schemaVersion:SCHEMA_VERSION,
      runtime:{electron:process.versions.electron??'unknown',node:process.versions.node??'unknown',chrome:process.versions.chrome??'unknown',undici:process.versions.undici??'unknown'},
      fetchImplementation:`undici@${projectUndiciVersion}`,
    };
  });
  ipcMain.handle('rivu:window-theme',(event,theme:unknown)=>{assertImageIssuer(event);if(theme!=='light'&&theme!=='dark')throw Error('窗口主题无效');if(process.platform==='win32')win!.setTitleBarOverlay({color:'#00000000',symbolColor:theme==='dark'?'#e8edf2':'#181e24',height:32});});
  ipcMain.handle('rivu:accessibility-state',event=>{assertImageIssuer(event);return app.isAccessibilitySupportEnabled();});
  ipcMain.handle('rivu:image-url',(event,entryId:string,url:string,mode:'lookup'|'load'='load')=>{
    assertImageIssuer(event);return nativeImages.url(entryId,url,mode);
  });
  ipcMain.handle('rivu:image-cancel',(event,url:string)=>{assertImageIssuer(event);nativeImages.cancel(url);});
  ipcMain.handle('rivu:image-bytes',(event,url:string)=>{
    assertImageIssuer(event);const read=nativeImageRead;
    return nativeImages.readBytes({url,method:'GET',initiatorOrigin:app.isPackaged?'file://':'http://127.0.0.1:5173'},read,()=>assertImageIssuer(event));
  });
  ipcMain.handle('rivu:request',async(event,method:string,path:string,body?:unknown)=>{
    assertRendererIssuer(event);
    if(!['GET','POST','PATCH','PUT','DELETE'].includes(method)||!/^\/api\//.test(path)&&path!=='/health'||path.startsWith('//'))throw Error('无效的本地 API 请求');
    const headers:Record<string,string>={'X-Rivu-Token':service.token};if(body!==undefined)headers['Content-Type']='application/json';
    const categoryWrite=isFeedCategoryWrite(method,path,body),feedPatch=isFeedPatch(method,path),categoryDelete=isCategoryDelete(method,path),imageRead=isImageRead(method,path);
    if(body===undefined&&imageRead){
      const target=new URL(path,'http://local.invalid');target.searchParams.set('transport','binary');
      const response=await service.app.inject({method:'GET',url:target.pathname+target.search,headers,payloadAsStream:true});
      return readImageResponse(response);
    }
    if(body===undefined&&isEntryRead(method,path)||method==='PATCH'&&isEntryResult(method,path)||isBulkReadWrite(method,path)||categoryWrite||feedPatch||categoryDelete){
      const response=await service.app.inject({method:method as 'GET'|'PATCH'|'POST'|'DELETE',url:path,headers,payload:body===undefined?undefined:JSON.stringify(body)});
      if(response.statusCode<200||response.statusCode>=300)throw Error(response.json().error||`HTTP ${response.statusCode}`);
      return feedPatch?{feedJson:response.body}:isBulkReadWrite(method,path)||categoryWrite||categoryDelete?response.json():{entryJson:response.body};
    }
    const response=await directFetch(`${baseUrl}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    if(response.ok&&isEntryResult(method,path))return {entryJson:await response.text()};
    const payload=await response.json();if(!response.ok)throw Error(payload.error||`HTTP ${response.status}`);return payload;
  });
  ipcMain.handle('rivu:preview-opml',async(event)=>{assertRendererIssuer(event);const result=await dialog.showOpenDialog(win!,{properties:['openFile'],filters:[{name:'OPML',extensions:['opml','xml']}]});if(result.canceled)return null;const xml=await readFile(result.filePaths[0],'utf8');return service.withDatabaseAccess(()=>{const preview=previewOpml(db,xml),id=randomUUID();pendingOpml={id,xml};return {id,preview};});});
  ipcMain.handle('rivu:import-opml',async(event,id:string,options:OpmlImportOptions)=>{assertRendererIssuer(event);return service.withDatabaseAccess(()=>{if(!pendingOpml||pendingOpml.id!==id)throw Error('OPML 预览已失效，请重新选择文件');const xml=pendingOpml.xml;pendingOpml=null;return importOpml(db,xml,options);});});
  ipcMain.handle('rivu:preview-newsletter',async(event)=>{
    assertRendererIssuer(event);
    const chosen=await dialog.showOpenDialog(win!,{properties:['openDirectory'],title:'选择存放 .eml 邮件的文件夹'});
    if(chosen.canceled)return null;
    const preview=await service.previewNewsletter(chosen.filePaths[0]),id=randomUUID();
    pendingNewsletter={id,url:preview.url,createdAt:Date.now()};
    return {id,folder:preview.folder,count:preview.count,samples:preview.samples,skipped:preview.skipped};
  });
  ipcMain.handle('rivu:subscribe-newsletter',async(event,id:string,title:string,categoryId?:string)=>{assertRendererIssuer(event);return service.withDatabaseAccess(()=>{
    if(!pendingNewsletter||pendingNewsletter.id!==id||Date.now()-pendingNewsletter.createdAt>10*60_000)throw Error('Newsletter 目录预览已失效，请重新选择');
    if(typeof title!=='string'||!title.trim()||title.length>200)throw Error('Newsletter 名称无效');
    if(categoryId!==undefined&&!db.categories().some(item=>(item as {id:string}).id===categoryId))throw Error('目标分类不存在');
    const url=pendingNewsletter.url;pendingNewsletter=null;
    if(db.feeds().some(item=>(item as {url:string}).url===url))throw Error('这个 Newsletter 文件夹已经订阅');
    return db.addFeed({title:title.trim(),url,type:'newsletter',categoryId,folderAuthorized:true});
  });});
  ipcMain.handle('rivu:reconnect-newsletter',async(event,id:string)=>{
    assertRendererIssuer(event);
    const feed=db.feed(id);if(!feed||feed.type!=='newsletter')throw Error('Newsletter 订阅不存在');
    const chosen=await dialog.showOpenDialog(win!,{properties:['openDirectory'],title:'重新选择 Newsletter 文件夹'});
    if(chosen.canceled)return null;
    const preview=await service.previewNewsletter(chosen.filePaths[0]);
    await service.waitForFeedRefresh(id);
    return service.withDatabaseAccess(()=>db.reconnectNewsletter(id,preview.url));
  });
  ipcMain.handle('rivu:choose-file',async(event,kind:'backup')=>{assertRendererIssuer(event);return backupRestoreSession.run(async beginCommit=>{
    if(kind!=='backup')throw Error('无效的文件类型');
    const selected=await dialog.showOpenDialog(win!,{properties:['openFile'],filters:[{name:'Rivu Backup',extensions:['zip']}]});
    if(selected.canceled)return null;
    const result=await withBackupSnapshot(selected.filePaths[0],async path=>{
      const info=await inspectBackupInWorker(app.isPackaged?join(process.resourcesPath,'app.asar.unpacked','dist-electron','backup-inspection-worker.cjs'):join(__dirname,'backup-inspection-worker.cjs'),join(__dirname,'backup-inspection-task.cjs'),path);
      const confirmation=await dialog.showMessageBox(win!,{type:'warning',buttons:['取消','恢复备份'],defaultId:0,cancelId:0,message:'恢复备份将替换当前数据库',detail:`备份数据库版本：${info.schemaVersion}。${info.hasSettings?'备份中的设置也将替换当前设置。':'当前设置将保留。'}${info.includesSecrets?' 此备份包含 AI 密钥。':''}本地 Newsletter 恢复后需重新选择文件夹。恢复前建议先导出当前备份。`});
      if(confirmation.response!==1)return null;
      if(shutdownStarted||!win||win.isDestroyed())return null;
      beginCommit();
      let closed=false;
      try{await service.stop();db.close();closed=true;await restoreBackupInWorker(app.isPackaged?join(process.resourcesPath,'app.asar.unpacked','dist-electron','backup-inspection-worker.cjs'):join(__dirname,'backup-inspection-worker.cjs'),join(__dirname,'backup-inspection-task.cjs'),path,dataDir());return {restored:true,restartRequired:true};}
      catch(error){if(closed){try{await recoverPendingRestore();}catch(recoveryError){throw new AggregateError([error,recoveryError],'恢复状态无法确认，服务未重启；请保留恢复日志与原数据副本');}db=new RivuDatabase(join(dataDir(),'rivu.db'),undefined,true);await startLocalService();}throw error;}
    });
    // Remove the private selected ZIP before exiting for the real relaunch.
    if(result?.restored){app.relaunch();app.exit(0);}
    return result;
  });});
  ipcMain.handle('rivu:save-file',async(event,kind:'opml'|'backup'|'archive',options?:{includeSecrets?:boolean;archiveId?:string})=>{assertRendererIssuer(event);if(!['opml','backup','archive'].includes(kind))throw Error('无效的导出类型');if(kind==='backup'&&options?.includeSecrets===true){const warning=await dialog.showMessageBox(win!,{type:'warning',buttons:['取消','继续备份'],defaultId:0,cancelId:0,message:'此备份将包含明文 AI 密钥',detail:'备份 ZIP 未加密。持有此文件的人可以读取其中的 AI 密钥。'});if(warning.response!==1)return null;}if(kind==='archive'&&!options?.archiveId)throw Error('未选择永久归档');const result=await dialog.showSaveDialog(win!,{defaultPath:kind==='opml'?'rivu-subscriptions.opml':kind==='archive'?`rivu-article-${new Date().toISOString().slice(0,10)}.zip`:`rivu-backup-${new Date().toISOString().slice(0,10)}.zip`,filters:[kind==='opml'?{name:'OPML',extensions:['opml']}:{name:'ZIP',extensions:['zip']}]});if(result.canceled||!result.filePath)return null;if(kind==='archive')return service.exportPermanentArchive(options!.archiveId!,result.filePath);return service.withDatabaseAccess(async()=>{if(kind==='opml'){await writeFile(result.filePath!,exportOpml(db),'utf8');return result.filePath;}await createBackup(db,dataDir(),result.filePath!,{includeSecrets:options?.includeSecrets===true});return {path:result.filePath,bytes:(await stat(result.filePath!)).size};});});
  ipcMain.handle('rivu:open-external',async(event,url:string)=>{assertRendererIssuer(event);const target=externalUrl(url);if(!target)throw Error('无效的外部链接');await shell.openExternal(target);});
  ipcMain.handle('rivu:open-backup-directory',async(event)=>{assertRendererIssuer(event);const path=join(dataDir(),'backups');await mkdir(path,{recursive:true});const error=await shell.openPath(path);if(error)throw Error(error);});
  createWindow();starting=false;app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
}).catch(async error=>{const detail=error instanceof Error?error.stack||error.message:String(error);if(!logs)try{logs=await LocalLogs.open(dataDir());}catch{}void logs?.write('error','startup_failed',{errorType:logErrorType(error)}).catch(()=>{});await logs?.flush();await dialog.showMessageBox({type:'error',message:'Rivu 启动失败',detail});app.quit();});
app.on('window-all-closed',()=>{if(!starting&&process.platform!=='darwin')app.quit();});
let shutdownStarted=false,shutdownReady=false;
app.on('before-quit',(event)=>{if(backupRestoreSession.committing){event.preventDefault();return;}if(shutdownReady)return;event.preventDefault();if(shutdownStarted)return;shutdownStarted=true;void (async()=>{try{nativeImages.setEndpoint(null);if(nativeProtocolRegistered){session.defaultSession.protocol.unhandle('rivu-image');nativeProtocolRegistered=false;}await service?.stop();db?.close();void logs?.write('app','shutdown').catch(()=>{});await logs?.flush();}finally{shutdownReady=true;app.quit();}})();});
