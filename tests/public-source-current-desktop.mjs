import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {lookup} from 'node:dns/promises';
import {_electron as electron} from 'playwright-core';
const output=process.env.RIVU_PUBLIC_SOURCE_RESULT;assert.ok(output&&!existsSync(output),'Choose a new result path');
const candidate=JSON.parse(readFileSync('artifacts/rivu-directory-latest.json','utf8'));
const executable=resolve(process.env.RIVU_TEST_EXE||candidate.executablePath),data=mkdtempSync(join(resolve('bench-data'),'rivu-public-sources-'));
const report={status:'RUNNING',candidate,executable,data,cases:[],scope:'Actual packaged public-source discovery, preview, subscription and local persistence in an isolated library. Current network only; not all sources, routes, providers or devices.'};
const save=()=>writeFileSync(output,JSON.stringify(report,null,2));save();let app,pid;
try{
 app=await electron.launch({executablePath:executable,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:data}});pid=app.process().pid;
 let page;const deadline=Date.now()+30000;
 while(Date.now()<deadline){page=app.windows().find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,100));}assert.ok(page);
 const inputs=[
  {kind:'github',url:'https://github.com/RSSNext/Folo',expected:['https://github.com/RSSNext/Folo/releases.atom','https://github.com/RSSNext/Folo/commits.atom']},
  {kind:'youtube',url:'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw',expected:['https://www.youtube.com/feeds/videos.xml?channel_id=UC_x5XG1OV2P6uZZ5FSM9Ttw']},
  {kind:'podcast',url:'https://podcasts.files.bbci.co.uk/p02nq0gn.rss'}
 ];
 const request=(method,path,body)=>page.evaluate(({method,path,body})=>window.rivu.request(method,path,body),{method,path,body});
 for(const input of inputs){
  const row={kind:input.kind,url:input.url,status:'RUNNING'};report.cases.push(row);save();
  try{
   try{row.resolvedAddresses=await lookup(new URL(input.url).hostname,{all:true,verbatim:true});}catch{row.dnsObservationFailed=true;}
   const previews=await request('POST','/api/feeds/discover',{url:input.url});assert.ok(previews.length>0);
   if(input.expected)assert.deepEqual(previews.map(p=>p.url),input.expected);
   assert.ok(previews.every(p=>p.items.length>0),'Each discovered source must preview entries');row.previews=previews.map(p=>({url:p.url,items:p.items.length}));
   if(input.kind==='podcast'){row.previewAudioItems=previews[0].items.filter(p=>p.media?.some(m=>m.kind==='audio')).length;assert.ok(row.previewAudioItems>0,'Podcast enclosure must be recognized');}
   const subscribed=await request('POST','/api/feeds',{url:previews[0].url});assert.equal(subscribed.url,previews[0].url);
   const entries=await request('GET','/api/entries?feedId='+encodeURIComponent(subscribed.id)+'&limit=10');assert.ok(entries.length>0);row.localEntryCountObserved=entries.length;row.status='PASS';
  }catch(error){row.status='FAIL';row.error=String(error).replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,'$1[redacted]@');}
  save();
 }
 report.status=report.cases.every(row=>row.status==='PASS')?'PASS-scoped-public-sources':'FAIL-public-source-cases';save();
}catch(error){report.status='FAIL-observation';report.error=String(error);save();throw error;}
finally{
 if(app){await app.close();let alive=true;const deadline=Date.now()+10000;while(Date.now()<deadline){try{process.kill(pid,0);}catch{alive=false;break;}await new Promise(done=>setTimeout(done,100));}report.ownedProcessClosed=!alive;if(alive)report.status='FAIL-owned-process-still-live';}
 save();console.log(JSON.stringify({status:report.status,cases:report.cases.map(({kind,status,error})=>({kind,status,error})),data}));
}
if(report.status!=='PASS-scoped-public-sources')process.exitCode=1;
