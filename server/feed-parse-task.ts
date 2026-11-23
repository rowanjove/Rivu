import {parseFeedData,parsePageData} from './feeds';
import type {RssCandidate,RssFetched} from './feeds';
import {customJsonSourceAdapter,validateJsonMapping,type JsonCandidate,type JsonFetched} from './custom-json';
import {extractFullText} from './fulltext';
import {imageUrls} from './offline';
import {aiPlainText} from './ai-text';
import {bodyImages} from './media';
import {createHash} from 'node:crypto';
import {excerptParagraphs} from './ai-context';
import {decodeAIProviderResponse,type AIProviderKind} from './ai-provider-response';
export async function parseAIProviderResponse(response:RssFetched&{aiProviderKind:AIProviderKind}){return decodeAIProviderResponse(response.text,response.aiProviderKind);}
export async function hashAIText(response:RssFetched){return createHash('sha256').update(response.text).digest('hex');}
export async function parseArchiveImages(response:RssFetched){return bodyImages(response.text,response.url);}
export async function parseAIText(response:RssFetched){return aiPlainText(response.text);}
export async function parseAIContext(response:RssFetched){const body=aiPlainText(response.text);return {body,paragraphs:excerptParagraphs(body)};}
export {parseNewsletterBatch} from './newsletter';

export async function parseFeedResponse(response:RssFetched,candidate:RssCandidate){
  return parseFeedData(response,candidate);
}
export async function parseFeedPage(response:RssFetched){return parsePageData(response);}
export async function parseFullTextResponse(response:RssFetched){return extractFullText(response);}
export async function parseImageUrls(response:RssFetched,candidate:RssCandidate&{cover?:string}){return imageUrls({id:'',saved:0,url:candidate.url||undefined,content:response.text,cover:candidate.cover});}
export async function parseCustomJsonResponse(response:JsonFetched,candidate:JsonCandidate){
  const selected={...candidate,mapping:validateJsonMapping(candidate.mapping)};
  const parsed=await customJsonSourceAdapter.parse(response,selected);
  return customJsonSourceAdapter.normalize(parsed,selected);
}
