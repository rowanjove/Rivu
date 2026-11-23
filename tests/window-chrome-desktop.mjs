import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {_electron as electron} from 'playwright-core';
const output=process.env.RIVU_WINDOW_CHROME_RESULT;assert.ok(output&&!existsSync(output)&&!existsSync(output+'.icon.png'));
const directory=mkdtempSync(join(resolve('bench-data'),'rivu-window-chrome-')),executable=resolve(process.env.RIVU_TEST_EXE);let application;
try{
 application=await electron.launch({executablePath:executable,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
 let page;const deadline=Date.now()+30000;while(Date.now()<deadline){page=application.windows().find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,100));}assert.ok(page);await page.getByText('Rivu',{exact:true}).first().waitFor();
 const state=await application.evaluate(({BrowserWindow,Menu})=>{const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')),handle=window.getNativeWindowHandle();return {pid:process.pid,handle:handle.length===8?handle.readBigUInt64LE().toString():String(handle.readUInt32LE()),menuRemoved:Menu.getApplicationMenu()===null,menuVisible:window.isMenuBarVisible(),autoHide:window.isMenuBarAutoHide()};});
 assert.equal(state.menuRemoved,true);assert.equal(state.menuVisible,false);assert.equal(state.autoHide,true);
 await page.keyboard.press('Alt');assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).isMenuBarVisible()),false);
 const script=join(directory,'read-window-icon.ps1');writeFileSync(script,`param([string]$WindowHandle,[int]$OwnerPid,[string]$OutputPath)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class WindowIconProbe {
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd,int msg,IntPtr wParam,IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
}
'@
$handle=[IntPtr]::new([long]$WindowHandle);[uint32]$actualPid=0
[void][WindowIconProbe]::GetWindowThreadProcessId($handle,[ref]$actualPid)
if($actualPid -ne $OwnerPid){throw 'Owned window identity mismatch'}
$iconHandle=[WindowIconProbe]::SendMessage($handle,0x7F,[IntPtr]::new(2),[IntPtr]::Zero)
if($iconHandle -eq [IntPtr]::Zero){$iconHandle=[WindowIconProbe]::SendMessage($handle,0x7F,[IntPtr]::Zero,[IntPtr]::Zero)}
if($iconHandle -eq [IntPtr]::Zero){throw 'Window icon missing'}
$icon=[Drawing.Icon]::FromHandle($iconHandle);$bitmap=$icon.ToBitmap()
try{$bitmap.Save($OutputPath,[Drawing.Imaging.ImageFormat]::Png)}finally{$bitmap.Dispose();$icon.Dispose()}
`);
 execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,state.handle,String(state.pid),resolve(output+'.icon.png')],{stdio:'pipe'});
 assert.ok(existsSync(output+'.icon.png'));await application.close();application=undefined;
 writeFileSync(output,JSON.stringify({status:'PASS',executable,directory,state,nativeIcon:resolve(output+'.icon.png'),sourceIconBytes:readFileSync('assets/rivu.ico').length,scope:'Packaged real main window has no application menu and a native WM_GETICON image. Visual icon inspected separately.'},null,2),{flag:'wx'});console.log('PASS native window icon and menu removed');
}finally{await application?.close();}
