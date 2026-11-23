import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

test('directFetch contains malformed compressed responses without unhandled stream errors',()=>{
  const entry=pathToFileURL(resolve('server/direct-fetch.ts')).href;
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import {createServer} from 'node:http';
    import {directFetch} from ${JSON.stringify(entry)};
    const server=createServer((_req,res)=>{
      res.writeHead(200,{'content-encoding':'gzip, gzip, gzip, gzip, gzip, gzip','content-length':'100'});
      res.flushHeaders();setTimeout(()=>res.socket?.end(),20);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {const res=await directFetch('http://127.0.0.1:'+server.address().port,{signal:AbortSignal.timeout(2000)});await res.text();}
    catch {console.log('request rejected safely');}
    await new Promise(resolve=>setTimeout(resolve,150));
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    console.log('PROCESS_SURVIVED');
  `],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||String(result.error));
  assert.match(result.stdout,/request rejected safely/);
  assert.match(result.stdout,/PROCESS_SURVIVED/);
  assert.doesNotMatch(result.stderr,/Unhandled 'error'/);
});
