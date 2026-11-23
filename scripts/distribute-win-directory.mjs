import assert from 'node:assert/strict';
import {createReadStream,createWriteStream,mkdirSync,mkdtempSync,writeFileSync,renameSync,readFileSync,existsSync} from 'node:fs';
import {readdir,stat} from 'node:fs/promises';
import {dirname,resolve,join,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import yauzl from 'yauzl';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url);
const {version}=require(join(root,'package.json'));
assert.match(version,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
// A fresh sibling preserves every previous candidate, including failed builds.
const output=mkdtempSync(join(root,`release-directory-${version}-`));
console.log('Directory build:',output);
const runtimeArgs=[];
const localRuntime=process.env.RIVU_ELECTRON_DIST||join(dirname(require.resolve('electron/package.json')),'dist');
if(process.env.RIVU_ELECTRON_DIST||existsSync(join(localRuntime,'version'))){
 const local=resolve(localRuntime),installed=require('electron/package.json').version;
 assert.equal(readFileSync(join(local,'version'),'utf8').trim().replace(/^v/,''),installed,'Local runtime must match installed Electron');
 assert.ok(require('semver').satisfies(installed,require(join(root,'package.json')).devDependencies.electron),'Local runtime must satisfy project Electron range');
 const runtimeVersion=execFileSync(join(local,'electron.exe'),['--version'],{encoding:'utf8',timeout:30000,windowsHide:true}).trim();
 assert.equal(runtimeVersion,'v'+installed,'Local executable version mismatch');
 runtimeArgs.push(`--config.electronDist=${local}`,`--config.electronVersion=${installed}`);
 console.log('Explicit local runtime:',local,runtimeVersion);
}
execFileSync(process.execPath,[require.resolve('electron-builder/cli.js'),'--win','--x64','--dir','--publish','never',`--config.directories.output=${output}`,...runtimeArgs],{cwd:root,stdio:'inherit'});
const source=join(output,'win-unpacked'),extracted=join(output,'directory-verified'),archive=join(output,`Rivu-${version}-portable-win-x64.zip`);
execFileSync(process.execPath,[join(root,'scripts/package-directory.mjs'),source,archive],{cwd:root,stdio:'inherit'});
const expected=new Map();
async function collect(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await collect(path);else{assert.ok(entry.isFile());expected.set(relative(source,path).split(sep).join('/'),path);}}}
async function digest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex').toUpperCase();}
await collect(source);mkdirSync(extracted);const records=[],seen=new Set(),zip=await yauzl.openPromise(archive,{strictFileNames:true,validateEntrySizes:true});
try{
 for await(const entry of zip.eachEntry()){
  assert.ok(expected.has(entry.fileName)&&!seen.has(entry.fileName),`Unexpected ZIP entry: ${entry.fileName}`);seen.add(entry.fileName);
  const destination=resolve(extracted,entry.fileName),inside=relative(extracted,destination);assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside));mkdirSync(dirname(destination),{recursive:true});
  const hash=createHash('sha256'),hasher=new Transform({transform(chunk,_encoding,callback){hash.update(chunk);callback(null,chunk);}});
  await pipeline(await zip.openReadStreamPromise(entry),hasher,createWriteStream(destination,{flags:'wx'}));
  const checksum=hash.digest('hex').toUpperCase();assert.equal(checksum,await digest(expected.get(entry.fileName)),`Extracted bytes differ: ${entry.fileName}`);
  records.push({path:entry.fileName,bytes:entry.uncompressedSize,sha256:checksum});
 }
}finally{zip.close();}
assert.equal(seen.size,expected.size);assert.ok(seen.has('Rivu.exe'));
assert.ok(!(await readdir(output,{withFileTypes:true})).some(entry=>entry.isFile()&&/\.exe$/i.test(entry.name)),'No standalone EXE or installer may be produced');
const buildInfo=JSON.parse(readFileSync(join(root,'shared/build-info.json'),'utf8'));
assert.equal(buildInfo.appVersion,version);
const manifest={version,buildId:buildInfo.buildId,builtAt:buildInfo.buildDate,schemaVersion:buildInfo.schemaVersion,electronVersion:require('electron/package.json').version,directory:output,executablePath:join(extracted,'Rivu.exe'),zipPath:archive,fileCount:records.length,zipBytes:(await stat(archive)).size,sha256:await digest(archive),createdAt:new Date().toISOString()};
records.sort((a,b)=>a.path.localeCompare(b.path));writeFileSync(join(output,'FILE-SHA256.json'),JSON.stringify(records,null,2)+'\n');writeFileSync(join(output,'SHA256SUMS.txt'),manifest.sha256+'  '+archive.split(sep).at(-1)+'\n');writeFileSync(join(output,'release.json'),JSON.stringify(manifest,null,2)+'\n');
const artifacts=join(root,'artifacts');mkdirSync(artifacts,{recursive:true});const latest=join(artifacts,'rivu-directory-latest.json'),temporary=latest+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(manifest,null,2)+'\n');renameSync(temporary,latest);
console.log(JSON.stringify({...manifest,extractedFileParity:true,standaloneExe:false},null,2));
console.log(`PowerShell smoke target: $env:RIVU_TEST_EXE='${manifest.executablePath.replaceAll("'","''")}'`);
