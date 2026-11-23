import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('',{url:'https://app.invalid'});globalThis.window=dom.window;
const built=await build({stdin:{contents:"export * from './src/plain-paragraph-html';export {renderArticleFragment} from './src/article-html';import DOMPurify from 'dompurify';import {articleHtmlPolicy} from './shared/article-policy';export const control=source=>DOMPurify.sanitize(source,{...articleHtmlPolicy(),RETURN_DOM:true});",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false});
const {isPlainParagraphHtml,renderPlainParagraphFragment,renderArticleFragment,control}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
test.after(()=>{dom.window.close();delete globalThis.window;});
const snapshot=root=>({html:[...root.childNodes].map(node=>node.outerHTML??node.textContent).join(''),text:root.textContent,nodes:[...root.childNodes].map(node=>({type:node.nodeType,name:node.nodeName,namespace:node.namespaceURI??null}))});

test('eligible paragraphs exactly match existing sanitizer text and DOM semantics',()=>{
 const texts=['','plain 中文😀','&lt;img src=x onerror=bad()&gt;','&NewLine;&Tab;&nbsp;&amp;&#0;&#x3c;','{{template}} ${text} <not a tag>','\n\r\t\v\f\0','unpaired \ud800 tail','<script>bad()</script>','quotes " \' \\ > &unknown;','&#60;script&#62;bad()&#60;/script&#62;'];
 for(const text of texts){
  const source='<p>'+text+'</p><p>End</p>';
  if(text.includes('<')){assert.equal(isPlainParagraphHtml(source),false);continue;}
  assert.equal(isPlainParagraphHtml(source),true);
  const result=renderPlainParagraphFragment(source);assert.deepEqual(snapshot(result),snapshot(control(source)));
  assert.equal(result.querySelectorAll('script,img,a,[onerror]').length,0);
  assert.deepEqual(snapshot(renderArticleFragment(source,{kind:'reader'})),snapshot(control(source)));
 }
});

test('all additional tags, attributes, malformed tokens and document prefixes use full sanitizer',()=>{
 const rejected=['','plain',' <p>x</p>','<p>x</p> ','<P>x</P>','<p id=x>x</p>','<p\n>x</p>','<p/>','<p>x','<p><p>x</p></p>','<p>x</p></p>','<p>x</p><img src=x onerror=bad()>','<!doctype html><p>x</p>','<p><!--comment--></p>','<p><svg onload=bad()></svg></p>','<p><math><mtext></mtext></math></p>','<p>&lt;/p&gt;</p><script>bad()</script>','<p>text<\0/p>','<p is=x>x</p>'];
 for(const source of rejected){assert.equal(isPlainParagraphHtml(source),false,JSON.stringify(source));assert.equal(renderPlainParagraphFragment(source),null);}
 const actual=renderArticleFragment('<p id=x onclick="bad()">Text</p><img src="javascript:bad()"><script>bad()</script>',{kind:'reader'});
 assert.equal(actual.querySelectorAll('script,[id],[onclick],img[src]').length,0);
});

test('parser refusal falls back to sanitizer and archive mode retains its existing path',()=>{
 const original=window.DOMParser;window.DOMParser=class{parseFromString(){throw Error('Trusted Types refusal');}};
 try{assert.equal(renderPlainParagraphFragment('<p>text</p>'),null);}finally{window.DOMParser=original;}
 const source='<p>Archive &lt;img&gt;</p>';assert.deepEqual(snapshot(renderArticleFragment(source,{kind:'archive',assets:[]})),snapshot(control(source)));
});
