import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverSource,readSourceCandidate} from '../dist-server/source-adapter.js';
import {rssSourceAdapter} from '../dist-server/feeds.js';
import {customJsonSourceAdapter} from '../dist-server/custom-json.js';
import {newsletterSourceAdapter,parseNewsletterMessage} from '../dist-server/newsletter.js';

test('source contract executes stages in order and stops before later stages on failure',async()=>{
  const calls=[];
  const adapter={id:'fixture',async discover(input){calls.push('discover');return [input,input+1];},async fetch(c){calls.push(`fetch:${c}`);return c*2;},async parse(v){calls.push(`parse:${v}`);return v+1;},normalize(v){calls.push(`normalize:${v}`);return {value:v};}};
  assert.deepEqual(await discoverSource(adapter,2),[{value:5},{value:7}]);
  assert.deepEqual(calls,['discover','fetch:2','parse:4','normalize:5','fetch:3','parse:6','normalize:7']);
  for(const stage of ['discover','fetch','parse','normalize']){
    calls.length=0;
    const broken={...adapter,[stage](){calls.push('failed');throw Error(stage);}};
    await assert.rejects(discoverSource(broken,2),new RegExp(stage));
    assert.equal(calls.at(-1),'failed');
  }
});

test('RSS, JSON API and local Newsletter use the same stages with authorization and stable normalized data',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-adapter-'));
  let base='',requests=0;
  const fixture=createServer((req,res)=>{
    requests++;
    if(req.url==='/api'){res.setHeader('content-type','application/json');res.end(JSON.stringify({items:[{id:'api-one',title:'API',body:'<p>正文</p>',url:'/article',image:'/cover.png'}]}));return;}
    if(req.url==='/json'){res.setHeader('content-type','application/feed+json');res.end(JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'JSON Feed',items:[{id:'json-one',title:'JSON',url:`${base}/article`,content_html:'<p>正文</p>'}]}));return;}
    res.setHeader('content-type','application/rss+xml');res.end(`<rss version="2.0"><channel><title>RSS</title><link>${base}</link><item><guid>rss-one</guid><title>文章</title><link>${base}/article</link><description>正文</description><enclosure url="${base}/audio.mp3" type="audio/mpeg"/></item></channel></rss>`);
  });
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${fixture.address().port}`;
  try{
    await assert.rejects(discoverSource(rssSourceAdapter,{url:`${base}/rss`}));
    assert.equal(requests,0,'private network must be rejected before contacting the fixture');
    for(const path of ['/rss','/json']){
      const [candidate]=await rssSourceAdapter.discover({url:base+path,privateOrigin:base});
      const parsed=await rssSourceAdapter.parse(await rssSourceAdapter.fetch(candidate),candidate);
      const before=requests,raw=JSON.stringify(parsed);
      const normalized=rssSourceAdapter.normalize(parsed,candidate);
      assert.deepEqual(rssSourceAdapter.normalize(parsed,candidate),normalized);
      assert.equal(JSON.stringify(parsed),raw);assert.equal(requests,before,'normalize performs no IO');
      assert.equal(normalized.items.length,1);
      assert.equal(normalized.items[0].url,`${base}/article`);
      if(path==='/rss')assert.equal(normalized.items[0].media[0].kind,'audio');
    }
    const input={url:`${base}/api`,title:' API ',allowPrivate:true,mapping:{itemsPath:'items',titlePath:'title',idPath:'id',urlPath:'url',contentPath:'body',imagePath:'image'}};
    const [api]=await discoverSource(customJsonSourceAdapter,input);
    assert.equal(api.title,'API');assert.equal(api.items[0].guid,'api-one');assert.equal(api.items[0].cover,`${base}/cover.png`);
    const before=requests;
    await assert.rejects(discoverSource(customJsonSourceAdapter,{...input,mapping:{...input.mapping,itemsPath:'__proto__'}}));assert.equal(requests,before);
    const raw=Buffer.from('From: Example <sender@example.com>\r\nMessage-ID: <local-one>\r\nSubject: Newsletter\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nLocal content');
    writeFileSync(join(dir,'one.eml'),raw);writeFileSync(join(dir,'ignore.txt'),'not mail');
    const candidates=await newsletterSourceAdapter.discover(dir);assert.equal(candidates.length,1);
    const mail=await readSourceCandidate(newsletterSourceAdapter,candidates[0]);
    assert.deepEqual(mail,await parseNewsletterMessage(raw));assert.equal(mail.guid,'<local-one>');assert.equal(requests,before,'Newsletter never contacts network');
    writeFileSync(join(dir,'oversized.eml'),Buffer.alloc(5_000_001));
    await assert.rejects(readSourceCandidate(newsletterSourceAdapter,{directory:dir,name:'oversized.eml'}),/5 MB/);
  }finally{await new Promise(resolve=>fixture.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
