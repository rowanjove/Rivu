import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {createServer} from 'node:http';
import AdmZip from 'adm-zip';
import {JSDOM} from 'jsdom';
import {RivuDatabase} from '../dist-server/database.cjs';
import {saveArchive,exportArchive} from '../dist-server/archive.js';

test('unknown media exports as inert binary with exact bytes and MIME metadata, while HTML remains read-only',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-export-boundary-')),db=new RivuDatabase(join(directory,'rivu.db'));
  const bytes=Buffer.from('<!doctype html><body><script>window.__untrustedExecuted=true</script>untrusted attachment</body>');
  const origin=createServer((_req,res)=>{res.setHeader('content-type','audio/html');res.end(bytes);});await new Promise(r=>origin.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${origin.address().port}`,feed=db.addFeed({title:'Local',url:base+'/feed',allowPrivate:true,fetchInterval:0});
  const content='<h2>Safe heading</h2><p id="root" class="overlay" data-theme="dark">Text &amp; entity</p><input value="external control"><button>Static label</button><div><style>body{display:none}</style></div><a href="/linked">link</a>';
  db.addEntries(feed.id,[{title:'Export fixture',url:base+'/article',content,hash:'export',media:[{kind:'audio',url:base+'/audio',mime:'audio/mpeg',source:'enclosure',title:null}]}]);const id=db.entries()[0].id;
  try{
    const archived=await saveArchive(db,id,{attachments:true});assert.equal(archived.errors.length,0);assert.equal(archived.assets.length,1);
    const destination=join(directory,'export.zip');await exportArchive(db,archived.id,destination);const zip=new AdmZip(destination),manifest=JSON.parse(zip.readAsText('metadata.json')),asset=manifest.versions[0].assets[0];
    assert.match(asset.path,/\.bin$/,'untrusted MIME subtypes must not create executable HTML files');assert.equal(asset.mime,'audio/html');assert.deepEqual(zip.getEntry(asset.path).getData(),bytes);
    for(const name of ['index.html','versions/001.html']){
      const dom=new JSDOM(zip.readAsText(name));try{const root=dom.window.document;assert.equal(root.querySelectorAll('script,style,form,input,button,[class],[id],[data-theme]').length,0);assert.ok(root.body.textContent.includes('Safe heading'));assert.ok(root.body.textContent.includes('Text & entity'));assert.equal(root.querySelector('a').href,base+'/linked');assert.ok(root.querySelector(`a[href$="${asset.path.split('/').pop()}"]`).hasAttribute('download'));const csp=root.querySelector('[http-equiv="Content-Security-Policy"]').content;assert.ok(csp.includes("form-action 'none'")&&csp.includes("base-uri 'none'"));}finally{dom.window.close();}
    }
    assert.equal(db.entry(id).content,content);assert.equal(db.db.prepare('SELECT mime FROM archive_assets WHERE id=?').get(archived.assets[0].id).mime,'audio/html');
  }finally{await new Promise(r=>origin.close(r));db.close();const scope=relative(resolve(tmpdir()),resolve(directory));assert.ok(scope.startsWith('rivu-export-boundary-')&&!scope.startsWith('..')&&!isAbsolute(scope));rmSync(directory,{recursive:true,force:true});}
});
