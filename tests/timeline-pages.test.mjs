import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RivuDatabase} from '../dist-server/database.cjs';
import {validateUnreadCounts} from '../dist-server/unread-counts.js';
const block="(EXISTS (SELECT 1 FROM rule_matches rm JOIN rules r ON r.id=rm.rule_id WHERE rm.entry_id=e.id AND r.enabled=1 AND r.action_type='block') OR EXISTS (SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=e.id AND a.decision='block'))";
const mute="(EXISTS (SELECT 1 FROM rule_matches rm JOIN rules r ON r.id=rm.rule_id WHERE rm.entry_id=e.id AND r.enabled=1 AND r.action_type='mute') OR EXISTS (SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=e.id AND a.decision='mute'))";

test('nonempty deep pages preserve legacy membership, full fields and order for blocked, unread, media, summary and tags',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-timeline-pages-')),db=new RivuDatabase(join(directory,'rivu.db'));
 try{
  const feed=db.addFeed({title:'Kept',url:'https://example.invalid/kept'}),orphan=db.addFeed({title:'Orphan',url:'https://example.invalid/orphan'}),tag=db.addTag('Rule tag'),manual=db.addTag('Manual tag');
  const insert=db.db.prepare('INSERT INTO entries(id,feed_id,title,content,description,hash,published_at,fetched_at,read,starred,saved,author) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  db.db.exec('BEGIN');for(let i=0;i<24040;i++)insert.run(randomUUID(),feed.id,`Article ${i}`,`完整正文😀${i}`,'description '+i,'hash-'+i,i%7===0?null:`2026-01-0${i%3+1}`,`2025-01-0${i%3+1}`,Number(i%20===0),Number(i%3===0),Number(i%5===0),'author '+i);db.db.exec('COMMIT');
  db.db.exec("INSERT INTO rules(id,name,conditions,action_type,created_at,updated_at) VALUES ('timeline-block','Block','{}','block','2026','2026'),('timeline-mute','Mute','{}','mute','2026','2026')");
  db.db.prepare("INSERT INTO rules(id,name,conditions,action_type,tag_id,created_at,updated_at) VALUES ('timeline-tag','Tag','{}','tag',?,'2026','2026')").run(tag.id);
  db.db.exec("INSERT INTO rule_matches SELECT 'timeline-block',id,'2026' FROM entries WHERE rowid<=12000; INSERT INTO rule_matches SELECT 'timeline-mute',id,'2026' FROM entries WHERE rowid%10=0; INSERT INTO rule_matches SELECT 'timeline-tag',id,'2026' FROM entries WHERE rowid>12000");
  db.db.prepare('INSERT INTO entry_tags SELECT id,? FROM entries WHERE rowid>12000 AND rowid%11<>0').run(manual.id);
  db.db.exec("INSERT INTO ai_results(id,entry_id,type,language,provider,model,content,prompt_version,content_hash,created_at) SELECT 'summary-'||id,id,'summary','zh','fixture','fixture','摘要','v1',hash,'2026' FROM entries");
  for(const kind of ['image','audio','video'])db.db.prepare("INSERT INTO entry_media(entry_id,kind,url,source,created_at) SELECT id,?,'https://example.invalid/media/'||id,'body','2026' FROM entries").run(kind);
  db.addEntries(orphan.id,[{title:'Orphan',content:'excluded',publishedAt:'2030',hash:'orphan'}]);db.db.exec('PRAGMA foreign_keys=OFF');db.db.prepare('DELETE FROM feeds WHERE id=?').run(orphan.id);db.db.exec('PRAGMA foreign_keys=ON');validateUnreadCounts(db.db);
  for(const scope of [{view:'all'},{view:'unread'},{view:'blocked'},{view:'summary'},{view:'images'},{view:'audio'},{view:'video'},{view:'all',tagId:tag.id},{view:'all',tagId:manual.id}])for(const offset of [1,9999,10000]){
   const predicates=[scope.view==='blocked'?block:`NOT ${block}`],args=[];
   if(scope.view==='unread')predicates.push('e.read=0',`NOT ${mute}`);
   if(scope.view==='summary')predicates.push("EXISTS (SELECT 1 FROM ai_results a WHERE a.entry_id=e.id AND a.type='summary')");
   if(['images','audio','video'].includes(scope.view)){predicates.push('EXISTS (SELECT 1 FROM entry_media m WHERE m.entry_id=e.id AND m.kind=?)');args.push(scope.view==='images'?'image':scope.view);}
   if(scope.tagId){predicates.push("(EXISTS (SELECT 1 FROM entry_tags t WHERE t.entry_id=e.id AND t.tag_id=?) OR EXISTS (SELECT 1 FROM rule_matches rm JOIN rules r ON r.id=rm.rule_id WHERE rm.entry_id=e.id AND r.enabled=1 AND r.action_type='tag' AND r.tag_id=?))");args.push(scope.tagId,scope.tagId);}
   const expected=db.db.prepare(`SELECT e.* FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE ${predicates.join(' AND ')} ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC LIMIT 100 OFFSET ${offset}`).all(...args);assert.equal(expected.length,100,JSON.stringify(scope));
   for(const listOnly of [true,false]){const actual=db.entries({...scope,offset,limit:100,listOnly});assert.deepEqual(actual.map(row=>row.id),expected.map(row=>row.id),JSON.stringify({...scope,listOnly}));for(let i=0;i<actual.length;i++){assert.equal(actual[i].feed_title,'Kept');assert.equal(actual[i].rule_blocked,scope.view==='blocked'?1:0);if(!listOnly)for(const [field,value] of Object.entries(expected[i]).filter(([name])=>name!=='storage_id'))assert.equal(actual[i][field],value,field);}}
  }
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});

test('rule, match and AI insert/update/delete keep independent blocked and unread projections in sync',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-timeline-effects-')),db=new RivuDatabase(join(directory,'rivu.db'));
 try{const feed=db.addFeed({title:'Fixture',url:'https://example.invalid/effects'});db.addEntries(feed.id,[{title:'One',hash:'one'},{title:'Two',hash:'two'}]);const [one,two]=db.entries().map(row=>row.id);
  const check=()=>{const expected=db.db.prepare(`SELECT e.id,COALESCE(e.published_at,e.fetched_at) sort_time,CASE WHEN ${block} THEN 1 ELSE 0 END blocked,CASE WHEN e.read=0 AND NOT ${block} AND NOT ${mute} THEN 1 ELSE 0 END visible FROM entries e ORDER BY e.id`).all();assert.deepEqual(db.db.prepare('SELECT entry_id id,sort_time,blocked,visible FROM rivu_entry_visibility ORDER BY entry_id').all(),expected);validateUnreadCounts(db.db);};
  const sql=(text,...args)=>{db.db.prepare(text).run(...args);check();};check();
  sql("INSERT INTO rules(id,name,conditions,action_type,created_at,updated_at) VALUES ('effect','Effect','{}','block','2026','2026')");
  sql("INSERT INTO rule_matches VALUES ('effect',?,'2026')",one);sql("UPDATE rule_matches SET entry_id=? WHERE rule_id='effect'",two);sql("UPDATE rules SET action_type='mute' WHERE id='effect'");sql("UPDATE rules SET enabled=0 WHERE id='effect'");sql("UPDATE rules SET enabled=1,action_type='block' WHERE id='effect'");sql("DELETE FROM rule_matches WHERE rule_id='effect'");sql("INSERT INTO rule_matches VALUES ('effect',?,'2026')",one);sql("DELETE FROM rules WHERE id='effect'");
  db.setFilterDecision(one,{decision:'block',reason:'fixture',criteria:'fixture',provider:'local',model:'fixture',content_hash:'one'});check();sql("UPDATE ai_filter_decisions SET entry_id=?,decision='mute' WHERE entry_id=?",two,one);sql('DELETE FROM ai_filter_decisions WHERE entry_id=?',two);
  db.setFilterDecision(one,{decision:'block',reason:'fixture',criteria:'fixture',provider:'local',model:'fixture',content_hash:'one'});check();sql('UPDATE entries SET content=? WHERE id=?','changed',one);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
