import {loadNativeImage} from './native-image';

export function observeArticleImages(root:HTMLElement,entryId:string){
  const active=new Map<HTMLImageElement,()=>void>(),visible=new Set<HTMLImageElement>();let disposed=false;
  const load=(image:HTMLImageElement)=>{const url=image.dataset.rivuUrl;if(!url)return;active.get(image)?.();active.set(image,loadNativeImage(image,entryId,url,{onStatus:status=>{
    // Preserve the responsive box when an offscreen image loses its intrinsic size.
    // Source width attributes remain authoritative; sanitized articles have no inline styles.
    if(status==='ready'&&image.naturalWidth>0&&image.naturalHeight>0){image.style.aspectRatio=`${image.naturalWidth} / ${image.naturalHeight}`;if(!image.hasAttribute('width'))image.style.width=`${image.naturalWidth}px`;}
  }}));};
  const observer=new IntersectionObserver(items=>{if(disposed)return;for(const item of items){const image=item.target as HTMLImageElement;if(item.isIntersecting){visible.add(image);if(!active.has(image))load(image);}else{visible.delete(image);active.get(image)?.();active.delete(image);}}},{root:root.closest('.reader-content'),rootMargin:'300px'});
  for(const image of root.querySelectorAll<HTMLImageElement>('img[data-rivu-url]'))observer.observe(image);
  const updated=()=>{if(disposed)return;for(const [image,release] of active){if(visible.has(image))load(image);else{release();active.delete(image);}}};
  window.addEventListener('rivu-image-cache-updated',updated);
  return ()=>{if(disposed)return;disposed=true;observer.disconnect();for(const release of active.values())release();active.clear();visible.clear();window.removeEventListener('rivu-image-cache-updated',updated);};
}
