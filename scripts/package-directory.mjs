import assert from 'node:assert/strict';
import {createWriteStream} from 'node:fs';
import {readdir,stat,rename,rm} from 'node:fs/promises';
import {resolve,join,relative,sep,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import yazl from 'yazl';

const [sourceArgument,destinationArgument]=process.argv.slice(2);
assert.ok(sourceArgument&&destinationArgument,'Usage: node scripts/package-directory.mjs win-unpacked output.zip');
const source=resolve(sourceArgument),destination=resolve(destinationArgument);
const outputRelative=relative(source,destination);
assert.ok(outputRelative==='..'||outputRelative.startsWith('..'+sep)||isAbsolute(outputRelative),'ZIP destination must be outside the application directory');
for(const required of ['Rivu.exe','resources/app.asar','resources/app.asar.unpacked/dist-electron/archive-export-worker.cjs','resources/app.asar.unpacked/dist-electron/archive-read-worker.cjs','resources/app.asar.unpacked/dist-electron/ai-scan-worker.cjs','resources/app.asar.unpacked/dist-electron/entry-read-worker.cjs'])assert.ok((await stat(join(source,required))).isFile(),`Missing packaged file: ${required}`);
const files=[];
async function walk(directory){for(const item of await readdir(directory,{withFileTypes:true})){const path=join(directory,item.name);if(item.isDirectory())await walk(path);else{assert.ok(item.isFile(),`Unsupported file type: ${path}`);files.push(path);}}}
await walk(source);files.sort();const zip=new yazl.ZipFile(),temporary=`${destination}.${randomUUID()}.tmp`;let committed=false;
zip.on('error',error=>zip.outputStream.destroy(error));
const completion=pipeline(zip.outputStream,createWriteStream(temporary));completion.catch(()=>{});
try{
  let sourceBytes=0;
  for(const path of files){sourceBytes+=(await stat(path)).size;zip.addFile(path,relative(source,path).split(sep).join('/'));}
  zip.end();await completion;await rename(temporary,destination);committed=true;
  console.log(JSON.stringify({destination,files:files.length,sourceBytes,zipBytes:(await stat(destination)).size},null,2));
}catch(error){zip.outputStream.destroy(error);await completion.catch(()=>{});throw error;}
finally{if(!committed)await rm(temporary,{force:true});}
