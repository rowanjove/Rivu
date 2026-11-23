import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {_electron as electron} from 'playwright-core';
const output=process.env.RIVU_TITLEBAR_RESULT;assert.ok(output&&!existsSync(output));
const directory=mkdtempSync(join(resolve('bench-data'),'rivu-titlebar-')),executable=resolve(process.env.RIVU_TEST_EXE);let app;
try{
 app=await electron.launch({executablePath:executable,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
 let page;const deadline=Date.now()+30000;while(Date.now()<deadline){page=app.windows().find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,100));}assert.ok(page);
 await page.waitForFunction(()=>document.documentElement.dataset.windowChrome==='integrated');
 const geometry=await page.evaluate(()=>({top:document.querySelector('.app-shell').getBoundingClientRect().top,drag:getComputedStyle(document.querySelector('.window-titlebar')).webkitAppRegion,overlayVisible:navigator.windowControlsOverlay?.visible,overlayHeight:navigator.windowControlsOverlay?.getTitlebarAreaRect().height}));
 assert.equal(geometry.top,0);assert.equal(geometry.drag,'drag');assert.equal(geometry.overlayVisible,true);assert.equal(geometry.overlayHeight,32);
 const windowState=await app.evaluate(({BrowserWindow,Menu})=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html'));const original=win.setTitleBarOverlay;win.setTitleBarOverlay=function(options){globalThis.__lastOverlay=options;return original.call(this,options);};return {pid:process.pid,handle:win.getNativeWindowHandle().readBigUInt64LE().toString(),menuRemoved:Menu.getApplicationMenu()===null};});assert.equal(windowState.menuRemoved,true);
 const script=join(directory,'capture-titlebar.ps1');writeFileSync(script,`param([long]$WindowHandle,[int]$OwnerPid,[string]$OutputPath)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class TitlebarCapture {
[StructLayout(LayoutKind.Sequential)] public struct Rect{public int Left,Top,Right,Bottom;}
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
}
'@
$handle=[IntPtr]::new($WindowHandle);[uint32]$actualPid=0;[void][TitlebarCapture]::GetWindowThreadProcessId($handle,[ref]$actualPid)
if($actualPid -ne $OwnerPid){throw 'Owned test window mismatch'}
$rect=New-Object TitlebarCapture+Rect;[void][TitlebarCapture]::GetWindowRect($handle,[ref]$rect)
$bitmap=New-Object Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top));$graphics=[Drawing.Graphics]::FromImage($bitmap);$dc=$graphics.GetHdc()
try{if(-not [TitlebarCapture]::PrintWindow($handle,$dc,2)){throw 'Native capture failed'}}finally{$graphics.ReleaseHdc($dc);$graphics.Dispose()}
$crop=$bitmap.Clone([Drawing.Rectangle]::new(0,0,$bitmap.Width,[Math]::Min(150,$bitmap.Height)),$bitmap.PixelFormat)
try{$crop.Save($OutputPath,[Drawing.Imaging.ImageFormat]::Png)}finally{$crop.Dispose();$bitmap.Dispose()}
`);
 await page.getByRole('button',{name:'设置',exact:true}).click();const theme=page.locator('.settings-dialog label').filter({hasText:/^主题/}).locator('select'),captures=[];
 for(const [value,expected]of [['dark','#00000000'],['light','#00000000'],['system','#00000000']]){
  if(value==='system')await page.emulateMedia({colorScheme:'dark'});
  await theme.selectOption(value);const wanted=value==='light'?'light':'dark';await page.waitForFunction(wanted=>document.documentElement.dataset.theme===wanted,wanted);
  let applied;const until=Date.now()+5000;while(Date.now()<until){applied=await app.evaluate(()=>globalThis.__lastOverlay);if(applied?.color===expected)break;await new Promise(done=>setTimeout(done,25));}assert.equal(applied.color,expected);
  const overlayTop=await page.locator('.overlay').evaluate(e=>e.getBoundingClientRect().top);assert.equal(overlayTop,0,'Modal dimming must include titlebar');const titlebarBackground=await page.locator('.window-titlebar').evaluate(e=>getComputedStyle(e).backgroundColor);assert.equal(titlebarBackground,'rgba(0, 0, 0, 0)');const image=resolve(output+'.'+value+'.png');assert.ok(!existsSync(image));execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,windowState.handle,String(windowState.pid),image],{stdio:'pipe'});captures.push({theme:value,image,overlay:applied});
 }
 const invalid=await page.evaluate(()=>window.rivu.setWindowTheme('invalid').then(()=>'',error=>String(error)));assert.match(invalid,/窗口主题无效/);
 await page.keyboard.press('Escape');await page.locator('.settings-dialog').waitFor({state:'hidden'});
 const mainImage=resolve(output+'.main.png');assert.ok(!existsSync(mainImage));execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,windowState.handle,String(windowState.pid),mainImage],{stdio:'pipe'});captures.push({theme:'main-dark',image:mainImage});
 const controls=await app.evaluate(async({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html'));win.maximize();await new Promise(done=>setTimeout(done,150));const maximized=win.isMaximized();win.unmaximize();await new Promise(done=>setTimeout(done,150));win.minimize();await new Promise(done=>setTimeout(done,150));const minimized=win.isMinimized();win.restore();return {maximized,minimized};});assert.deepEqual(controls,{maximized:true,minimized:true});
 await app.close();app=undefined;writeFileSync(output,JSON.stringify({status:'PASS',directory,executable,geometry,windowState,captures,controls,scope:'Real packaged Windows titlebar overlay, theme IPC, drag region and native window controls; header captures inspected separately'},null,2),{flag:'wx'});console.log('PASS integrated titlebar, theme sync and native controls');
}finally{await app?.close();}
