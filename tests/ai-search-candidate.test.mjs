import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['server/ai-search-candidate.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {summaryCandidateMatch}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].contents).toString('base64'));
const match=term=>'"'+term.replaceAll('"','""')+'"';
function fixture(){const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE ai_results(entry_id TEXT,type TEXT,content TEXT);CREATE VIRTUAL TABLE ai_result_fts USING fts5(content,content='ai_results',tokenize='trigram');CREATE TRIGGER ai_insert AFTER INSERT ON ai_results BEGIN INSERT INTO ai_result_fts(rowid,content) VALUES(new.rowid,new.content);END;");return db;}
function seed(db,word,count,type='summary'){const add=db.prepare('INSERT INTO ai_results(entry_id,type,content) VALUES (?,?,?)');for(let n=0;n<count;n++)add.run('entry-'+n%700,type,'head '+word+' tail');}
function ids(db,fts,term){const statement=db.prepare("SELECT a.rowid id FROM ai_result_fts JOIN ai_results a ON a.rowid=ai_result_fts.rowid WHERE ai_result_fts MATCH ? AND a.type='summary' AND a.content LIKE ? ORDER BY a.rowid");statement.setReadBigInts(true);return statement.all(fts,'%'+term+'%').map(r=>r.id);}

test('AI candidate selection preserves exact multilingual IDs and rejects broad prefixes',()=>{
 const db=fixture();try{
  const words=['overlapbridge','overlord','摘要专属','摘要专用','数字1234','École','école','ПРИВЕТ','привет','ΑΒΓΔΕΖ','αβγδεζ','𐐀𐐁𐐂𐐃','４５６７','e\u0301cole','foo-bar','foo_bar','100%word','foo"bar','mix42','one','摘要','a'.repeat(33)];
  db.exec('BEGIN');for(const word of words){seed(db,word,1105);seed(db,word,5,'translate');}seed(db,'over unrelated 摘要专刊 mix unrelated',1200);db.prepare('INSERT INTO ai_results(rowid,entry_id,type,content) VALUES (?,?,?,?)').run(9007199254740993n,'large','summary','overlapbridge 数字1234');
  let optimized=0,retained=0;
  for(const term of [...words,'OVERLAPBRIDGE','absentword']){const original=match(term),selected=summaryCandidateMatch(db,term,original,true);assert.deepEqual(ids(db,selected,term),ids(db,original,term),term);if(selected!==original)optimized++;else retained++;}
  assert.ok(optimized>0&&retained>0);assert.equal(summaryCandidateMatch(db,'overlapbridge',match('overlapbridge'),true),match('overlapbridge'),'collision ratio must keep full phrase');
  assert.ok(ids(db,summaryCandidateMatch(db,'数字1234',match('数字1234'),true),'数字1234').includes(9007199254740993n));
 }finally{db.close();}
});

test('sampling caps and rare/non-simple guards retain the original match',()=>{
 const db=fixture();try{
  db.exec('BEGIN');seed(db,'commonword',2000);seed(db,'company collision',66000);seed(db,'raresuffix',10);
  assert.equal(summaryCandidateMatch(db,'commonword',match('commonword'),true),match('commonword'),'prefix over64Ki rows must retain original');
  assert.equal(summaryCandidateMatch(db,'raresuffix',match('raresuffix'),true),match('raresuffix'));
  for(const term of ['abc','a_bcd','abcd%','a'.repeat(33),'e\u0301cole'])assert.equal(summaryCandidateMatch(db,term,match(term),true),match(term));
  assert.equal(summaryCandidateMatch(db,'commonword',match('commonword'),false),match('commonword'));
  db.exec('ROLLBACK');assert.equal(summaryCandidateMatch(db,'commonword',match('commonword'),true),match('commonword'),'sampling requires a read snapshot');
 }finally{db.close();}
});

test('prefix density is rechecked after changes and savepoint rollback in the same snapshot',()=>{
 const db=fixture();try{
  db.exec('BEGIN');seed(db,'preciseword',1105);assert.equal(summaryCandidateMatch(db,'preciseword',match('preciseword'),true),'"pre"');
  db.exec('SAVEPOINT added');seed(db,'prefix collision',5000);assert.equal(summaryCandidateMatch(db,'preciseword',match('preciseword'),true),match('preciseword'));
  db.exec('ROLLBACK TO added');assert.equal(summaryCandidateMatch(db,'preciseword',match('preciseword'),true),'"pre"');db.exec('ROLLBACK');
 }finally{db.close();}
});
