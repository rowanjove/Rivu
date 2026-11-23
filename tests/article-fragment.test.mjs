import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('',{url:'https://app.invalid/'});globalThis.window=dom.window;
// No emitted bundle, temporary database or application profile.
const result=await build({entryPoints:['src/article-html.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {renderArticleHtml,renderArticleFragment}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
test.after(()=>{dom.window.close();delete globalThis.window;});
const mount=fragment=>{const root=dom.window.document.createElement('div');root.appendChild(fragment.cloneNode(true));return root;};

test('direct fragment retains full long text and leading pre whitespace across repeated mounts',()=>{
 const source='  \n<pre>\n\n  literal &lt;tag&gt;\n</pre>'+Array.from({length:1200},(_,i)=>`<p>${i} 中文 😀 &amp; ${'complete text '.repeat(40)}</p>`).join('');
 const fragment=renderArticleFragment(source,{kind:'reader'}),legacy=dom.window.document.createElement('div');legacy.innerHTML=renderArticleHtml(source,{kind:'reader'});
 for(let i=0;i<2;i++){const root=mount(fragment);assert.equal(root.textContent,legacy.textContent);assert.equal(root.querySelectorAll('p').length,1200);assert.equal(root.querySelector('pre').textContent,'\n  literal <tag>\n');}
 assert.equal(fragment.querySelectorAll('p').length,1200);
});

test('direct fragment preserves sanitization, URL policy and controlled image markers without app namespaces',()=>{
 const vectors=['<svg><g/onload=alert(1)></svg>','<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">','<table><caption><svg><title><style><img src=x onerror=alert(1)>','<a href="jav&#x61;script:alert(1)" onclick="alert(1)">Bad</a><img src="data:text/html,bad" onerror="alert(1)">'];
 for(const vector of vectors)for(const kind of ['reader','archive']){
  const options={kind,baseUrl:'https://source.invalid/post',assets:[{kind:'image',url:'https://source.invalid/good.png',id:'current'}]};
  const source='<p class="overlay" id="root" style="color:red">Kept 中文</p><img src="/good.png" data-rivu-url="forged" data-archive-asset="forged"><a href="/page">Link</a>'+vector;
  const root=mount(renderArticleFragment(source,options));
  assert.equal(root.querySelectorAll('svg,math,script,style,form,iframe,object,[src],[onerror],[onclick],[onload],[id],[class],[style]').length,0);
  assert.ok(root.textContent.includes('Kept 中文'));assert.equal(root.querySelector('img').getAttribute(kind==='reader'?'data-rivu-url':'data-archive-asset'),kind==='reader'?'https://source.invalid/good.png':'current');
  for(const a of root.querySelectorAll('a[href]'))assert.match(a.getAttribute('href'),/^https?:\/\//);
 }
});
