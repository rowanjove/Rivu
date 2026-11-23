import {createServer} from 'node:http';
export async function providerFixture(){
 let mode='valid',calls=0,closed=0;
 const marker='__rivuProviderPadding';
 const server=createServer(async(req,res)=>{
  for await(const chunk of req){}
  calls++;res.setHeader('content-type','application/json');
  if(mode==='http-error'){res.statusCode=500;res.write('fixture error');res.on('close',()=>closed++);return;}
  if(mode==='declared'){res.setHeader('content-length',String(9*1024*1024));res.write(' ');res.on('close',()=>closed++);return;}
  if(mode==='streamed'){res.write(' '.repeat(5*1024*1024));res.end(' '.repeat(4*1024*1024));return;}
  if(mode==='model-large'){res.end(JSON.stringify({data:[{id:'fixture'}],[marker]:'x'.repeat(3*1024*1024)}));return;}
  if(mode==='invalid-json'){res.end('{broken');return;}
  if(mode==='invalid-utf8'){res.end(Buffer.concat([Buffer.from('{"choices":[{"message":{"content":"'),Buffer.from([0xc3,0x28]),Buffer.from('"}}]}')]));return;}
  const content=mode==='content-large'?'x'.repeat(1024*1024+1):'本地模拟回答 [1]';
  res.end(JSON.stringify(req.url.endsWith('/models')?{data:[{id:'fixture'}]}:{choices:[{message:{content}}],[marker]:'x'.repeat(6*1024*1024)}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:`http://127.0.0.1:${server.address().port}/v1`,marker,setMode(value){mode=value;},get calls(){return calls;},get closed(){return closed;},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
