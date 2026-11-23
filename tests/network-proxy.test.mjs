import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { proxyForRequest, requestBytes, setProxyPreferences } from '../server/network.ts';

const execFileAsync=promisify(execFile);

const proxyKeys=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NO_PROXY','no_proxy'];
async function withProxyEnvironment(values,run){
  const previous=Object.fromEntries(proxyKeys.map(key=>[key,process.env[key]]));
  for(const key of proxyKeys)delete process.env[key];
  Object.assign(process.env,values);
  try{return await run();}finally{for(const key of proxyKeys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
}
const publicLookup=async()=>[{address:'8.8.8.8',family:4}];
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;}
async function close(server){await new Promise(resolve=>server.close(resolve));}

test('HTTP proxy receives only the prechecked IP while retaining the original Host',async()=>{
  let observed;
  const proxy=createServer((req,res)=>{observed={url:req.url,host:req.headers.host};res.end('feed');});
  const address=await listen(proxy);
  try{await withProxyEnvironment({HTTP_PROXY:address},async()=>{
    const result=await requestBytes('http://example.test/news?latest=1',1024,'text/plain',undefined,publicLookup);
    assert.equal(result.bytes.toString(),'feed');
    assert.deepEqual(observed,{url:'http://8.8.8.8/news?latest=1',host:'example.test'});
  });}finally{await close(proxy);}
});

test('DNS resolution times out before a delayed address can open a connection',async()=>{
  let hits=0;
  const server=createServer((_req,res)=>{hits++;res.end('unexpected');});
  const address=await listen(server);
  try{
    const delayedLookup=()=>new Promise(resolve=>setTimeout(()=>resolve([{address:'127.0.0.1',family:4}]),15_100));
    await assert.rejects(requestBytes(`${address}/feed`,1024,'text/plain',new URL(address).origin,delayedLookup),{message:'请求超时（DNS 解析）'});
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(hits,0,'DNS 超时后不能继续连接');
  }finally{await close(server);}
});

test('HTTPS proxy CONNECT uses the prechecked IP and NO_PROXY checks the original hostname',async()=>{
  let tunnel;
  const proxy=createServer();proxy.on('connect',(req,socket)=>{tunnel=req.url;socket.destroy();});
  const address=await listen(proxy);
  try{await withProxyEnvironment({HTTPS_PROXY:address},async()=>{
    await assert.rejects(requestBytes('https://example.test/news',1024,'text/plain',undefined,publicLookup));
    assert.equal(tunnel,'8.8.8.8:443');
    process.env.NO_PROXY='example.test';
    assert.equal(proxyForRequest(new URL('https://example.test/news')),null);
  });}finally{await close(proxy);}
});

test('invalid proxy fails closed with a generic error and does not affect local requests',async()=>{
  const local=createServer((_req,res)=>res.end('offline'));
  const address=await listen(local);
  try{await withProxyEnvironment({HTTP_PROXY:'http://name:secret@bad host'},async()=>{
    await assert.rejects(requestBytes('http://example.test/news',1024,'text/plain',undefined,publicLookup),{message:'代理配置无效'});
    const result=await requestBytes(`${address}/feed`,1024,'text/plain',new URL(address).origin,async()=>[{address:'127.0.0.1',family:4}]);
    assert.equal(result.bytes.toString(),'offline');
  });}finally{await close(local);}
});

test('global Node proxy flag cannot intercept private feeds or AI and local API fetches',async()=>{
  let localHits=0,proxyHits=0;
  const local=createServer((_req,res)=>{localHits++;res.end('direct');});
  const proxy=createServer((_req,res)=>{proxyHits++;res.end('intercepted');});
  const localUrl=await listen(local),proxyUrl=await listen(proxy);
  const code=`import { requestBytes } from './server/network.ts';
import { directFetch } from './server/direct-fetch.ts';
const origin=process.argv[1];
const feed=await requestBytes(origin+'/feed',1024,'text/plain',origin);
if(feed.bytes.toString()!=='direct')throw Error('private feed was proxied');
const response=await directFetch(origin+'/ai',{headers:{Authorization:'Bearer secret'}});
if(await response.text()!=='direct')throw Error('AI request was proxied');`;
  try{
    await execFileAsync(process.execPath,['--input-type=module','-e',code,localUrl],{cwd:process.cwd(),timeout:10000,env:{...process.env,NODE_USE_ENV_PROXY:'1',HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,NO_PROXY:'',no_proxy:''}});
    assert.equal(localHits,2);
    assert.equal(proxyHits,0);
  }finally{await close(local);await close(proxy);}
});

test('saved custom proxy overrides environment and its exclusions use the original domain',async()=>{
  let observed;
  const proxy=createServer((req,res)=>{observed=req.url;res.end('custom');});
  const address=await listen(proxy);
  try{await withProxyEnvironment({HTTP_PROXY:'http://127.0.0.1:1'},async()=>{
    setProxyPreferences({mode:'custom',httpProxy:address,httpsProxy:'',noProxy:'.excluded.test'});
    assert.equal(proxyForRequest(new URL('http://news.excluded.test/feed')),null);
    const result=await requestBytes('http://example.test/feed',1024,'text/plain',undefined,publicLookup);
    assert.equal(result.bytes.toString(),'custom');
    assert.equal(observed,'http://8.8.8.8/feed');
    setProxyPreferences({mode:'direct',httpProxy:'',httpsProxy:'',noProxy:''});
    assert.equal(proxyForRequest(new URL('http://example.test/feed')),null);
  });}finally{setProxyPreferences({mode:'environment',httpProxy:'',httpsProxy:'',noProxy:''});await close(proxy);}
});
