import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { RivuDatabase } from '../dist-server/database.cjs';
import { createService } from '../dist-server/service.js';
import { createBackup, inspectBackup } from '../dist-server/backup.js';

test('proxy choices persist locally, reject unsafe URLs and survive a checked backup',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-proxy-settings-'));
  const settingsPath=join(directory,'settings.json');
  const db=new RivuDatabase(join(directory,'rivu.db'));
  const token='proxy-token',headers={'x-rivu-token':token};
  let service=createService(db,token,settingsPath,directory);
  try{
    const initial=await service.app.inject({method:'GET',url:'/api/network/proxy',headers});
    assert.equal(initial.json().mode,'environment');
    const saved=await service.app.inject({method:'PATCH',url:'/api/network/proxy',headers,payload:{mode:'custom',httpProxy:'http://127.0.0.1:7897',httpsProxy:'http://127.0.0.1:7897',noProxy:'.example.com'}});
    assert.equal(saved.statusCode,200,saved.body);
    assert.equal(saved.json().httpsProxy,'http://127.0.0.1:7897');
    for(const payload of [{httpsProxy:'http://user:secret@127.0.0.1:7897'},{httpProxy:'file:///tmp/proxy'},{noProxy:'example.com\nAuthorization: secret'},{mode:'unknown'},{mode:['direct']}]){
      const response=await service.app.inject({method:'PATCH',url:'/api/network/proxy',headers,payload});
      assert.equal(response.statusCode,400,response.body);
      assert.equal(response.body.includes('secret'),false);
    }
    assert.equal(JSON.parse(readFileSync(settingsPath,'utf8')).proxy.mode,'custom');
    await service.stop();service=createService(db,token,settingsPath,directory);
    const restored=await service.app.inject({method:'GET',url:'/api/network/proxy',headers});
    assert.equal(restored.json().noProxy,'.example.com');
    const backup=join(directory,'proxy.zip');await createBackup(db,directory,backup);
    assert.equal((await inspectBackup(backup)).hasSettings,true);
    const invalid=join(directory,'invalid-proxy.zip'),zip=new AdmZip(backup);
    const settings=JSON.parse(zip.getEntry('settings.json').getData().toString());
    settings.proxy.httpsProxy='http://user:secret@127.0.0.1:7897';
    zip.updateFile('settings.json',Buffer.from(JSON.stringify(settings)));zip.writeZip(invalid);
    await assert.rejects(inspectBackup(invalid),/代理设置无效/);
    writeFileSync(settingsPath,JSON.stringify({...JSON.parse(readFileSync(settingsPath,'utf8')),proxy:{...saved.json(),httpsProxy:'http://user:review-secret@127.0.0.1:7897'}}));
    const sanitized=join(directory,'sanitized.zip');await createBackup(db,directory,sanitized);
    assert.equal((await inspectBackup(sanitized)).hasSettings,true);
    const sanitizedSettings=JSON.parse(new AdmZip(sanitized).getEntry('settings.json').getData().toString());
    assert.equal(sanitizedSettings.proxy,undefined);
    assert.equal(JSON.stringify(sanitizedSettings).includes('review-secret'),false);
    writeFileSync(settingsPath,'{broken settings');
    const direct=await service.app.inject({method:'PATCH',url:'/api/network/proxy',headers,payload:{mode:'direct'}});
    assert.equal(direct.statusCode,500,direct.body);
    assert.match(direct.json().error,/代理配置读取失败/);
    assert.equal(readdirSync(directory).some(name=>name.startsWith('settings.json.invalid-')),false);
    assert.equal(readFileSync(settingsPath,'utf8'),'{broken settings');
  }finally{await service.stop();db.close();rmSync(directory,{recursive:true,force:true});}
});
