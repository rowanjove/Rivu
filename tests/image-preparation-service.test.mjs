import test from 'node:test';
import assert from 'node:assert/strict';
import threads from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {createService} from '../dist-server/service.js';

async function exercise(fail,withImage=true){
 const dir=mkdtempSync(join(tmpdir(),'rivu-prepare-service-')),db=new RivuDatabase(join(dir,'rivu.db'));
 const original=threads.Worker,workers=[];let attempts=0,service;
 threads.Worker=new Proxy(original,{construct(Target,args,newTarget){
  if(args[1]?.workerData?.persistentImages){attempts++;if(fail)throw Error('simulated preparation constructor failure');const w=Reflect.construct(Target,args,newTarget);workers.push(w);return w;}
  return Reflect.construct(Target,args,newTarget);
 }});syncBuiltinESMExports();
 try{
  const feed=db.addFeed({title:'Fixture',url:'https://example.invalid/feed',fetchInterval:0});db.updateFeed(feed.id,{enabled:false});
  const content='<p>exact original body</p>'+(withImage?'<IMG src="image.png">':'');
  db.addEntries(feed.id,[{title:'Prepared article',hash:'prepared',content}]);const id=db.entries()[0].id;
  db.db.prepare('DELETE FROM entry_media').run();
  service=createService(db,'test-token');assert.equal(attempts,0);
  const get=(url,authorized=true)=>service.app.inject({url,headers:authorized?{'x-rivu-token':'test-token'}:{}});
  assert.equal((await get('/api/entries/'+id,false)).statusCode,401);assert.equal(attempts,0);
  assert.equal((await get('/api/entries/missing')).statusCode,404);assert.equal(attempts,0);
  for(let i=0;i<2;i++){const response=await get('/api/entries/'+id);assert.equal(response.statusCode,200);assert.equal(response.json().content,content);assert.equal('imageHint' in response.json(),false);}
  if(!fail){for(let i=0;i<2;i++){const status=await get('/api/entries/'+id+'/offline');assert.equal(status.statusCode,200);assert.equal(status.json().images.total,withImage?1:0);}}
  assert.equal(attempts,withImage?(fail?2:1):0);assert.equal(workers.length,withImage&&!fail?1:0);
  await service.stop();assert.ok(workers.every(w=>w.threadId===-1));
 }finally{await service?.stop();threads.Worker=original;syncBuiltinESMExports();db.close();rmSync(dir,{recursive:true,force:true});}
}
test('valid detail reads prepare one parser, startup/unauthorized/missing reads do not, shutdown releases it',()=>exercise(false));
test('preparation constructor failure never changes successful article response',()=>exercise(true));
test('text-only article including cached repeat never prepares an image worker',()=>exercise(false,false));
