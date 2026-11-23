export function measureSettingsContrast(dialog){
    const color=value=>{const values=value.match(/[\d.]+/g)?.map(Number)||[0,0,0];return [...values.slice(0,3),values[3]??1];};
    const blend=(foreground,background)=>foreground.slice(0,3).map((value,index)=>value*foreground[3]+background[index]*(1-foreground[3]));
    const luminance=rgb=>rgb.map(value=>value/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
    const rows=[];
    for(const element of dialog.querySelectorAll('*')){
      let text=[...element.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent.trim()).filter(Boolean).join(' '),placeholder=false;
      if(element.matches('input:not([type=checkbox]):not([type=radio]):not([type=hidden]),textarea')){text=element.value||element.getAttribute('placeholder')||'';placeholder=!element.value&&!!text;}
      if(element.tagName==='SELECT')text=element.selectedOptions[0]?.textContent||'';
      if(!text||!element.getClientRects().length||element.closest(':disabled,[aria-hidden="true"]'))continue;
      const style=getComputedStyle(element,placeholder?'::placeholder':null);if(getComputedStyle(element).visibility!=='visible')continue;
      const ancestors=[];for(let current=element;current;current=current.parentElement)ancestors.push(current);
      let background=[255,255,255];for(const ancestor of ancestors.reverse())background=blend(color(getComputedStyle(ancestor).backgroundColor),background);
      const ink=color(style.color);ink[3]*=Number(style.opacity);const foreground=blend(ink,background),a=luminance(foreground),b=luminance(background),ratio=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05),size=parseFloat(style.fontSize),large=size>=24||size>=18.66&&Number(style.fontWeight)>=700;
      rows.push({text:text.slice(0,90),tag:element.tagName,class:element.className,placeholder,ratio,minimum:large?3:4.5,color:style.color,background});
    }
    return {checked:rows.length,failures:rows.filter(row=>row.ratio<row.minimum)};

}

