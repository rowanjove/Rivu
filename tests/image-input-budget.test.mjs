import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {FeedParser} from '../dist-server/feed-parser.js';

test('oversized image body/base/cover and escaped candidate reject before hashing or worker creation',async()=>{
 const parser=new FeedParser('must-not-spawn.cjs',undefined,64,64),original=crypto.createHash;let hashes=0;
 crypto.createHash=function(...args){hashes++;return original.apply(this,args);};syncBuiltinESMExports();
 try{
  for(const entry of [{content:'x'.repeat(40)},{url:'x'.repeat(40)},{cover:'x'.repeat(40)},{content:'x',cover:'\0'.repeat(10)}]){
   await assert.rejects(parser.imageUrls(entry),e=>e.statusCode===503&&e.resourceBusy===true);
  }
  assert.equal(hashes,0);
 }finally{crypto.createHash=original;syncBuiltinESMExports();await parser.stop();}
});
