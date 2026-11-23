import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { isRecoveredFeed, type RivuDatabase } from './database';
import { validateJsonMapping } from './custom-json';

export type OpmlItem={index:number;title:string;url:string;sourceCategory:string;status:'new'|'duplicate'|'invalid';reason?:string;jsonMapping?:string};
export type OpmlPreview={items:OpmlItem[];newCount:number;duplicateCount:number;invalidCount:number};
export type OpmlImportOptions={selected?:number[];categoryMap?:Record<string,string|null>};
export type OpmlImportResult={imported:number;skipped:number;failed:number;results:{index:number;status:'imported'|'skipped'|'failed';reason?:string}[]};
const canonicalUrl=(raw:string)=>{try{const url=new URL(raw);url.hash='';return url.href;}catch{return raw;}};

const escape=(text:string)=>text.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function exportOpml(db:RivuDatabase){const feeds=(db.feeds() as {title:string;url:string;category_name?:string;type:string;json_mapping?:string|null}[]).filter(feed=>feed.type!=='newsletter'&&!isRecoveredFeed(feed));const groups=new Map<string,typeof feeds>();for(const feed of feeds){const key=feed.category_name||'';groups.set(key,[...(groups.get(key)||[]),feed]);}let content='<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>Rivu subscriptions</title></head><body>\n';for(const [category,items] of groups){if(category)content+=`<outline text="${escape(category)}" title="${escape(category)}">\n`;for(const feed of items){const custom=feed.type==='custom_json';const mapping=custom?` rivuMapping="${escape(JSON.stringify(validateJsonMapping(JSON.parse(String(feed.json_mapping)))))}"`:'';content+=`<outline type="${custom?'rivu-json':'rss'}" text="${escape(feed.title)}" title="${escape(feed.title)}" xmlUrl="${escape(feed.url)}"${mapping}/>\n`;}if(category)content+='</outline>\n';}return content+'</body></opml>\n';}

export function previewOpml(db:RivuDatabase,xml:string):OpmlPreview{
  if(xml.length>2_000_000)throw Error('OPML 文件过大');
  const valid=XMLValidator.validate(xml);
  if(valid!==true)throw Error('OPML XML 格式无效');
  const parsed=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_'}).parse(xml);
  if(!parsed?.opml?.body)throw Error('不是有效 OPML 文件');
  const existing=new Set((db.feeds() as {url:string}[]).map(feed=>canonicalUrl(feed.url)));
  const seen=new Set<string>();
  const items:OpmlItem[]=[];
  const visit=(nodes:unknown,parents:string[])=>{
    for(const raw of Array.isArray(nodes)?nodes:[nodes]){
      if(!raw||typeof raw!=='object')continue;
      const node=raw as Record<string,unknown>;
      const label=String(node['@_title']||node['@_text']||'').trim();
      const value=node['@_xmlUrl'];
      if(value!==undefined){
        const item:OpmlItem={index:items.length,title:label||String(value),url:String(value),sourceCategory:parents.join(' / '),status:'new'};
        try{
          if(typeof value!=='string')throw Error('订阅地址无效');
          const url=new URL(value);
          if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('仅支持不含凭据的 HTTP/HTTPS 地址');
          item.url=canonicalUrl(url.href);
          if(isRecoveredFeed({url:item.url}))throw Error('此地址保留给历史文章恢复，不能作为新订阅');
          if(node['@_type']==='rivu-json'){
            if(typeof node['@_rivuMapping']!=='string')throw Error('自定义 JSON 来源缺少字段映射');
            item.jsonMapping=JSON.stringify(validateJsonMapping(JSON.parse(node['@_rivuMapping'])));
          }
          if(existing.has(item.url)||seen.has(item.url)){item.status='duplicate';item.reason='订阅已存在或在文件中重复';}
          else seen.add(item.url);
        }catch(error){item.status='invalid';item.reason=error instanceof Error?error.message:String(error);}
        items.push(item);
      }else if(node.outline)visit(node.outline,label?[...parents,label]:parents);
    }
  };
  visit(parsed.opml.body.outline||[],[]);
  return {items,newCount:items.filter(item=>item.status==='new').length,duplicateCount:items.filter(item=>item.status==='duplicate').length,invalidCount:items.filter(item=>item.status==='invalid').length};
}

export async function importOpml(db:RivuDatabase,xml:string,options:OpmlImportOptions={}):Promise<OpmlImportResult>{
  const preview=previewOpml(db,xml);
  const selected=new Set(options.selected??preview.items.filter(item=>item.status==='new').map(item=>item.index));
  if([...selected].some(index=>!Number.isInteger(index)||index<0||index>=preview.items.length))throw Error('OPML 选择范围无效');
  const categoryMap=options.categoryMap??{};
  const existingCategories=db.categories() as {id:string;name:string}[];
  for(const [source,target] of Object.entries(categoryMap)){
    if(!preview.items.some(item=>item.sourceCategory===source))throw Error('OPML 分类映射无效');
    if(target!==null&&!existingCategories.some(category=>category.id===target))throw Error('目标分类不存在');
  }
  const categoryIds=new Map<string,string|null>();
  const results:OpmlImportResult['results']=[];
  for(const item of preview.items){
    if(item.status!=='new'||!selected.has(item.index)){results.push({index:item.index,status:'skipped',reason:item.reason||'未选择'});continue;}
    try{
      let categoryId:string|null=null;
      if(item.sourceCategory){
        if(!categoryIds.has(item.sourceCategory)){
          const mapped=categoryMap[item.sourceCategory];
          if(mapped!==undefined)categoryIds.set(item.sourceCategory,mapped);
          else{
            const existing=existingCategories.find(category=>category.name===item.sourceCategory);
            categoryIds.set(item.sourceCategory,existing?.id??String((db.addCategory(item.sourceCategory) as {id:string}).id));
          }
        }
        categoryId=categoryIds.get(item.sourceCategory)??null;
      }
      db.addFeed({title:item.title,url:item.url,categoryId,type:item.jsonMapping?'custom_json':'rss',jsonMapping:item.jsonMapping});
      results.push({index:item.index,status:'imported'});
    }catch(error){results.push({index:item.index,status:'failed',reason:error instanceof Error?error.message:String(error)});}
  }
  return {imported:results.filter(result=>result.status==='imported').length,skipped:results.filter(result=>result.status==='skipped').length,failed:results.filter(result=>result.status==='failed').length,results};
}
