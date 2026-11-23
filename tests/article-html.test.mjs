import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const directory=mkdtempSync(join(tmpdir(),'rivu-html-unit-')),file=join(directory,'html.mjs'),dom=new JSDOM('<aside class="sidebar">App</aside>',{url:'https://app.invalid/'});
globalThis.window=dom.window;globalThis.DOMParser=dom.window.DOMParser;
await build({entryPoints:['src/article-html.ts'],bundle:true,format:'esm',platform:'node',outfile:file});const {renderArticleHtml}=await import(pathToFileURL(file).href);
test.after(()=>{dom.window.close();delete globalThis.window;delete globalThis.DOMParser;const scope=relative(resolve(tmpdir()),resolve(directory));assert.ok(scope.startsWith('rivu-html-unit-')&&!scope.startsWith('..')&&!isAbsolute(scope));rmSync(directory,{recursive:true,force:true});});
const parse=html=>new dom.window.DOMParser().parseFromString(html,'text/html');

test('source styling, app namespaces and interactive containers are removed without losing semantic text',()=>{
  const html=renderArticleHtml('<div class="overlay" id="root" data-theme="dark"><style>.sidebar{opacity:.37}</style><h2>中文 😀</h2><p style="color:red">Text &amp; entity</p><blockquote>Quote</blockquote><table><tr><td>Cell</td></tr></table><pre><code class="language-js">&lt;script&gt;example&lt;/script&gt;</code></pre><form action="https://other.invalid/"><p>Form paragraph</p><input><button>Static button label</button></form><iframe src="https://other.invalid/"></iframe><video poster="https://other.invalid/"><source src="https://other.invalid/"></video></div>',{kind:'reader'});
  const root=parse(html).body;assert.equal(root.querySelectorAll('style,script,form,input,button,iframe,video,source,[style],[id],[class],[data-theme]').length,0);
  for(const value of ['中文 😀','Text & entity','Quote','Cell','<script>example</script>','Form paragraph'])assert.ok(root.textContent.includes(value),value);
  assert.ok(!root.textContent.includes('opacity'));assert.equal(root.querySelectorAll('td').length,1);
});

test('reader image markers only derive from valid src; links normalize and hostile schemes never dispatch',()=>{
  const root=parse(renderArticleHtml('<img data-rivu-url="https://other.invalid/fake" data-archive-asset="fake"><img src="/valid.png" data-rivu-url="https://other.invalid/fake" srcset="/other.png 2x"><a href="../page">link</a><a href="javascript:alert(1)">bad</a><img src="file:///private.png"><img src="data:image/png;base64,AAAA"><img src=""><img src="   ">',{kind:'reader',baseUrl:'https://source.invalid/dir/post'})).body;
  assert.deepEqual([...root.querySelectorAll('[data-rivu-url]')].map(e=>e.getAttribute('data-rivu-url')),['https://source.invalid/valid.png']);
  assert.equal(root.querySelectorAll('[src],[srcset],[data-archive-asset]').length,0);assert.equal(root.querySelector('a').getAttribute('href'),'https://source.invalid/page');assert.ok(!root.querySelectorAll('a')[1].hasAttribute('href'));
});

test('archive image markers can only come from the supplied current image assets',()=>{
  const root=parse(renderArticleHtml('<img src="/valid.png" data-archive-asset="forged"><img src="/missing.png"><img src="/audio.png"><img data-archive-asset="valid" data-rivu-url="https://other.invalid/fake"><a href="/page">link</a>',{kind:'archive',baseUrl:'https://source.invalid/post',assets:[{id:'valid',kind:'image',url:'https://source.invalid/valid.png'},{id:'audio',kind:'audio',url:'https://source.invalid/audio.png'}]})).body;
  assert.deepEqual([...root.querySelectorAll('[data-archive-asset]')].map(e=>e.getAttribute('data-archive-asset')),['valid']);assert.equal(root.querySelectorAll('[src],[data-rivu-url]').length,0);assert.equal(root.querySelector('a').getAttribute('href'),'https://source.invalid/page');
});

test('single sanitized DOM retains leading whitespace, entities and preformatted content',()=>{
 const source='  \n<p>中文 &amp; emoji 😀</p><pre>\n\n  literal &lt;tag&gt;\n</pre>tail';
 const template=dom.window.document.createElement('template');template.innerHTML=source;
 for(const kind of ['reader','archive']){const output=renderArticleHtml(source,{kind,assets:[]}),actual=dom.window.document.createElement('template');actual.innerHTML=output;assert.equal(actual.content.textContent,template.content.textContent);assert.ok(output.startsWith('  \n'));}
});

test('direct sanitized DOM rejects malformed namespace payloads and event attributes before URL rewriting',()=>{
 const vectors=['<svg><g/onload=alert(1)></svg>','<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">','<table><caption><svg><title><style><img src=x onerror=alert(1)>','<a href="jav&#x61;script:alert(1)" onclick="alert(1)">Unsafe</a><img src="data:text/html,bad" onerror="alert(1)">','<form id=reader><button formaction="https://other.invalid/">Source label</button></form>'];
 for(const vector of vectors)for(const kind of ['reader','archive']){const root=parse(renderArticleHtml('<p>Kept text 中文 😀</p>'+vector,{kind,baseUrl:'https://source.invalid/post',assets:[]})).body;assert.equal(root.querySelectorAll('svg,math,script,style,form,button,iframe,object,[src],[onclick],[onload],[onerror],[formaction],[id]').length,0);assert.ok(root.textContent.includes('Kept text 中文 😀'));for(const a of root.querySelectorAll('a[href]'))assert.match(a.getAttribute('href'),/^https?:\/\//);}
});

test('long mixed article keeps complete semantic text and controlled image markers for reader and archive',()=>{
 const source='<blockquote>Quote &amp; author</blockquote>'+Array.from({length:700},(_,i)=>`<p>段落 ${i} 中文 😀 &amp; ${'complete text '.repeat(6)}<a href="../page">Link</a></p>`).join('')+'<table><tr><td>Last cell</td></tr></table><img src="/image.png" data-rivu-url="forged" data-archive-asset="forged">';
 const template=dom.window.document.createElement('template');template.innerHTML=source;
 for(const kind of ['reader','archive']){const output=renderArticleHtml(source,{kind,baseUrl:'https://source.invalid/dir/post',assets:[{id:'current',kind:'image',url:'https://source.invalid/image.png'}]}),actual=dom.window.document.createElement('template');actual.innerHTML=output;assert.equal(actual.content.textContent,template.content.textContent);assert.equal(actual.content.querySelectorAll('p').length,700);assert.equal(actual.content.querySelector('img').getAttribute(kind==='reader'?'data-rivu-url':'data-archive-asset'),kind==='reader'?'https://source.invalid/image.png':'current');assert.equal(actual.content.querySelectorAll('[src],[onerror]').length,0);}
});
