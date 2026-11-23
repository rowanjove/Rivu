// Fault-injection tests sometimes need the original handler while a wrapper is
// deliberately failing renderer requests. Supply the real fixture window's
// identity rather than weakening the production issuer guard with null events.
export function callOriginal(app,name,...args){
  return app.evaluate(({BrowserWindow},{name,args})=>{
    const windows=BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL().includes('/index.html'));
    if(windows.length!==1)throw Error('Expected exactly one fixture application window');
    const sender=windows[0].webContents;
    return globalThis[name]({sender,senderFrame:sender.mainFrame},...args);
  },{name,args});
}
