import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {resolve} from 'node:path';
const built=await build({stdin:{contents:"export * from './server/entry-serialized-query';export {queryEntry,entryColumns} from './server/entry-query';",resolveDir:resolve('.'),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
const {querySerializedEntry,queryEntry,entryColumns,hasImageHint,utf8ImageHint}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE entries (${entryColumns.map(name=>`${name} ${['read','starred','archived','saved'].includes(name)?'INTEGER':'TEXT'}`).join(',')});CREATE INDEX entries_list_metadata ON entries(id);
 CREATE TABLE feeds(id TEXT,title TEXT,site_url TEXT,url TEXT,allow_private INTEGER);
 CREATE TABLE rules(id TEXT,enabled INTEGER,action_type TEXT);CREATE TABLE rule_matches(rule_id TEXT,entry_id TEXT);CREATE TABLE ai_filter_decisions(entry_id TEXT,decision TEXT);
 INSERT INTO feeds VALUES ('feed','<img /> metadata only','https://example.invalid','https://example.invalid/feed',1);
 INSERT INTO rules VALUES ('rule',1,'mute');INSERT INTO rule_matches VALUES ('rule','entry');`);
 const row=Object.fromEntries(entryColumns.map(name=>[name,null]));Object.assign(row,{id:'entry',feed_id:'feed',title:'Title " \\ 中文😀 <img>',content:'<p>plain</p>',read:1,starred:0,archived:0,saved:0,hash:'hash',body_revision:'revision',fetched_at:'2026-01-01'});
 db.prepare(`INSERT INTO entries VALUES (${entryColumns.map(()=>'?').join(',')})`).run(...entryColumns.map(name=>row[name]));
 return db;
}
const parse=result=>result?JSON.parse(new TextDecoder().decode(result.json)):undefined;
function check(db){const expected=queryEntry(db,'entry'),result=querySerializedEntry(db,'entry',queryEntry(db,'entry',true)),parsed=parse(result);assert.equal(Object.keys(parsed).length,27);assert.deepEqual(parsed,JSON.parse(JSON.stringify(expected)));assert.equal(result.imageHint,hasImageHint(expected));return result;}

test('native JSON preserves all27 fields, escaping, effective body hints and owned transfer buffers',()=>{
 const db=fixture();try{
  const original=db.prepare.bind(db);let nativeCalls=0;
  db.prepare=sql=>{if(sql.includes('CAST(json_object('))nativeCalls++;return original(sql);};
  const bodies=[null,'','text " \\ \n\r\t\0 中文😀 \u2028\u2029','<p>'+('中文😀 quotation " backslash \\ '.repeat(4000))+'</p>','<IMG/>','<image\u00a0href="x">','<imgx>','<img','<img\ufeffsrc="x">'];
  for(const body of bodies)for(const full of [null,'','plain full content','<image />']){
   db.prepare('UPDATE entries SET content=?,description=?,full_content=?').run(body,'<img src="description">',full);check(db);
  }
  assert.equal(nativeCalls,bodies.length*4);
  db.prepare('UPDATE entries SET content=?,description=?,full_content=?').run('plain','plain',null);
  const metadata=queryEntry(db,'entry',true);
  db.prepare=sql=>{if(sql.includes('e.content content'))throw Error('Ordinary text must not fall back to object body reads');return original(sql);};
  const first=querySerializedEntry(db,'entry',metadata);assert.equal(first.imageHint,false,'Metadata tags must not enter body hint');
  db.prepare=sql=>original(sql);
  structuredClone(first.json.buffer,{transfer:[first.json.buffer]});assert.equal(first.json.byteLength,0);check(db);
  assert.equal(querySerializedEntry(db,'missing',{}),undefined);
 }finally{db.close();}
});

test('UTF8 image hint matches original regex, including Unicode whitespace and byte-view offsets',()=>{
 const spaces=['\t','\n','\v','\f','\r',' ','\u00a0','\u1680','\u2000','\u2001','\u2002','\u2003','\u2004','\u2005','\u2006','\u2007','\u2008','\u2009','\u200a','\u2028','\u2029','\u202f','\u205f','\u3000','\ufeff'];
 for(const tag of ['img','IMG','image','ImAgE'])for(const suffix of [...spaces,'/','>','x','😀','\u200b','']){
  const body='中文😀 before <'+tag+suffix+' after',encoded=new TextEncoder().encode(body),storage=new Uint8Array(encoded.length+12);storage.set(encoded,5);
  assert.equal(utf8ImageHint(storage.subarray(5,5+encoded.length),null),hasImageHint({content:body}),JSON.stringify({tag,suffix}));
 }
 assert.equal(utf8ImageHint(new Uint8Array(),'/cover'),true);
 assert.equal(utf8ImageHint(new TextEncoder().encode('<img'),null),false);
 assert.equal(utf8ImageHint(new TextEncoder().encode('<imgx><image>'),null),true);
});

test('legacy BLOB, invalidUTF8 and REAL metadata keep original object serialization',()=>{
 const db=fixture();try{
  for(const bytes of [Buffer.from('<img />'),Buffer.from([0xff,0xc0,0x22,0x00])]){db.prepare('UPDATE entries SET content=?').run(bytes);check(db);}
  db.exec("UPDATE entries SET content=CAST(x'3C696D6720FF3E' AS TEXT)");check(db);
  db.prepare('UPDATE entries SET content=?,read=?').run('plain',0.12345678901234567);check(db);
  db.prepare('UPDATE entries SET read=?').run(Infinity);assert.equal(parse(check(db)).read,null);
 }finally{db.close();}
});

test('native query errors propagate instead of being masked by compatibility fallback',()=>{
 const db=fixture();try{
  const metadata=queryEntry(db,'entry',true),prepare=db.prepare.bind(db);
  db.prepare=sql=>{if(sql.includes('CAST(json_object('))throw Error('fixture query failed');return prepare(sql);};
  assert.throws(()=>querySerializedEntry(db,'entry',metadata),/fixture query failed/);
 }finally{db.close();}
});
