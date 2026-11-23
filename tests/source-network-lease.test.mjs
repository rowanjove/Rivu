import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createServer} from 'node:http';
import {RivuDatabase} from '../dist-server/database.cjs';
import {createService} from '../dist-server/service.js';
const mapping={itemsPath:'items',idPath:'id',titlePath:'title',contentPath:'content',urlPath:'',datePath:'',summaryPath:'',authorPath:'',imagePath:''};
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('background work blocked during held source request')),10000))]);}finally{clearTimeout(timer);}}
async function fixture(redirect=false){
  const directory=mkdtempSync(join(tmpdir(),'rivu-source-network-')),db=new RivuDatabase(join(directory,'rivu.db')),ready=defer(),gate=defer();let held=0,icons=0,targets=0;
  const server=createServer(async(req,res)=>{
    if(req.url.startsWith('/held')){held++;if(held===1){ready.resolve();await gate.promise;}}
    if(redirect&&req.url.startsWith('/held')){res.writeHead(302,{location:'/target'});res.end();return;}
    if(req.url==='/target')targets++;
    if(req.url==='/icon'){icons++;res.setHeader('content-type','image/png');res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64'));return;}
    res.setHeader('content-type','application/feed+json');res.end(JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'Source',icon:'/icon',items:[{id:'one',title:'Article',content:'body',content_html:'<p>body</p>'}]}));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const background=db.addFeed({title:'Background',url:base+'/background',allowPrivate:true}),source=db.addFeed({title:'Source',url:base+'/held',allowPrivate:true}),json=db.addFeed({title:'JSON',url:base+'/held-json',allowPrivate:true,type:'custom_json',jsonMapping:JSON.stringify(mapping)}),instance=db.addRsshubInstance('Local',base,true);
  const service=createService(db,'token',undefined,directory),request=(method,url,payload)=>service.app.inject({method,url,payload,headers:{'x-rivu-token':'token'}});
  return {directory,db,server,base,background,source,json,instance,service,request,ready,gate,held:()=>held,icons:()=>icons,targets:()=>targets,close:async()=>{gate.resolve();await service.stop();db.close();await new Promise(r=>server.close(r));const path=relative(resolve(tmpdir()),resolve(directory));assert.ok(path.startsWith('rivu-source-network-')&&!path.startsWith('..')&&!isAbsolute(path));rmSync(directory,{recursive:true,force:true});}};
}
function action(f,mode){
  if(mode==='discover')return f.request('POST','/api/feeds/discover',{url:f.base+'/held-new-rss',allowPrivate:true});
  if(mode==='rss')return f.request('POST','/api/feeds',{url:f.base+'/held-new-rss',allowPrivate:true});
  if(mode==='json-preview')return f.request('POST','/api/feeds/custom-json/preview',{url:f.base+'/held-new-json',title:'JSON',mapping,allowPrivate:true});
  if(mode==='json')return f.request('POST','/api/feeds/custom-json',{url:f.base+'/held-new-json',title:'JSON',mapping,allowPrivate:true});
  if(mode==='mapping')return f.request('PATCH',`/api/feeds/${f.json.id}/json-mapping`,{mapping:{...mapping,titlePath:'id'}});
  if(mode==='icon')return f.request('POST',`/api/feeds/${f.source.id}/icon`,{});
  return f.request('POST',mode==='hub-preview'?'/api/rsshub/preview':'/api/rsshub/subscribe',{instanceId:f.instance.id,route:'/held-hub'});
}
for(const mode of ['discover','rss','json-preview','json','mapping','icon','hub-preview','hub'])test(`${mode} releases source network permit while independent Feed Worker commits`,async()=>{
  const f=await fixture();let pending,follower;
  try{
    let done=false;pending=action(f,mode).then(r=>{done=true;return r;});await bounded(f.ready.promise);
    if(mode==='icon'){follower=action(f,mode);await delay(20);}
    const refreshed=await bounded(f.request('POST',`/api/feeds/${f.background.id}/refresh`,{}));assert.equal(refreshed.statusCode,200,refreshed.body);assert.equal(refreshed.json().added,1);assert.equal(done,false);
    assert.equal(f.db.entries({feedId:f.background.id}).length,1);
    assert.equal((await bounded(f.request('PATCH',`/api/feeds/${f.background.id}`,{title:'Changed'}))).statusCode,200);
    f.gate.resolve();const response=await pending;assert.equal(response.statusCode,['rss','json','hub'].includes(mode)?201:200,response.body);
    if(follower){assert.equal((await follower).statusCode,200);assert.equal(f.held(),1);}
  }finally{f.gate.resolve();await Promise.allSettled([pending,follower].filter(Boolean));await f.close();}
});
for(const change of ['delete','authorize','mapping'])test(`JSON mapping rejects stale preview after ${change}`,async()=>{
  const f=await fixture();let pending;
  try{pending=action(f,'mapping');await bounded(f.ready.promise);
    await f.service.withDatabaseAccess(()=>{if(change==='delete')f.db.deleteFeed(f.json.id);else if(change==='authorize')f.db.updateFeed(f.json.id,{allowPrivate:false});else f.db.updateJsonMapping(f.json.id,JSON.stringify({...mapping,titlePath:'content'}));});
    f.gate.resolve();const result=await pending;assert.equal(result.statusCode,change==='delete'?404:409,result.body);
    if(change==='mapping')assert.equal(JSON.parse(f.db.feed(f.json.id).json_mapping).titlePath,'content');
  }finally{f.gate.resolve();await pending;await f.close();}
});
for(const mode of ['icon','hub-preview','hub'])for(const change of ['delete','authorize'])test(`${mode} ${change} during wait rejects stale data and makes no subsequent icon request`,async()=>{
  const f=await fixture();let pending;
  try{pending=action(f,mode);await bounded(f.ready.promise);
    await f.service.withDatabaseAccess(()=>{if(mode==='icon'){if(change==='delete')f.db.deleteFeed(f.source.id);else f.db.updateFeed(f.source.id,{allowPrivate:false});}else if(change==='delete')f.db.deleteRsshubInstance(f.instance.id);else f.db.db.prepare('UPDATE rsshub_instances SET allow_private=0 WHERE id=?').run(f.instance.id);});
    f.gate.resolve();const result=await pending;assert.equal(result.statusCode,change==='delete'?404:409,result.body);assert.equal(f.icons(),0);assert.equal(f.db.feeds().length,change==='delete'&&mode==='icon'?2:3);
    if(mode==='icon'&&change==='authorize')assert.equal(f.db.feed(f.source.id).icon,null);
  }finally{f.gate.resolve();await pending;await f.close();}
});
test('accepted source preview drains on stop while its write permit is paused',async()=>{
  const f=await fixture();let pending,stopped;
  try{pending=action(f,'discover');await bounded(f.ready.promise);let done=false;stopped=f.service.stop().then(()=>done=true);await delay(30);assert.equal(done,false);assert.equal((await f.request('POST','/api/feeds/discover',{url:f.base+'/background',allowPrivate:true})).statusCode,503);f.gate.resolve();assert.equal((await pending).statusCode,200);await stopped;assert.equal(done,true);
  }finally{f.gate.resolve();await pending;await stopped;await f.close();}
});
for(const mode of ['icon','mapping','hub-preview','hub'])test(`${mode} revoked authorization stops redirect before its next request`,async()=>{
  const f=await fixture(true);let pending;
  try{pending=action(f,mode);await bounded(f.ready.promise);await f.service.withDatabaseAccess(()=>{
    if(mode==='icon'||mode==='mapping')f.db.updateFeed(mode==='icon'?f.source.id:f.json.id,{allowPrivate:false});
    else f.db.db.prepare('UPDATE rsshub_instances SET allow_private=0 WHERE id=?').run(f.instance.id);
  });f.gate.resolve();const result=await pending;assert.equal(result.statusCode,409,result.body);assert.equal(f.targets(),0);assert.equal(f.icons(),0);
  }finally{f.gate.resolve();await pending;await f.close();}
});
