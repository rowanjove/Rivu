import type {Config} from 'dompurify';

export function articleHtmlPolicy(localMedia=false):Config {
  return {
    USE_PROFILES:{html:true},ALLOW_DATA_ATTR:false,
    FORBID_TAGS:['style','link','script','iframe','object','embed','form','input','button','textarea','select','option','template','noscript','meta','base',...(localMedia?[]:['source','video','audio'])],
    FORBID_CONTENTS:['style','script','iframe','object','embed','template','noscript'],
    FORBID_ATTR:['style','class','id','name','srcset','background','action','formaction','ping','autoplay',...(localMedia?[]:['poster'])],
  };
}
