type Row={signature:string;json:Uint8Array;cost:number;imageHint:boolean};
export class EntryJsonCache{
  private rows=new Map<string,Row>();
  private retained=0;
  constructor(private maxBytes=16*1024*1024,private maxEntries=256){
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>256)throw Error('文章缓存预算无效');
  }
  get bytes(){return this.retained;}
  clear(){this.rows.clear();this.retained=0;}
  private remove(key:string){const row=this.rows.get(key);if(row){this.retained-=row.cost;this.rows.delete(key);}}
  get(key:string,signature:string):Uint8Array|undefined{
    const row=this.rows.get(key);if(!row)return;
    if(row.signature!==signature){this.remove(key);return;}
    this.rows.delete(key);this.rows.set(key,row);return row.json.slice();
  }
  imageHint(key:string,signature:string){const row=this.rows.get(key);return row?.signature===signature?row.imageHint:undefined;}
  put(key:string,signature:string,json:Uint8Array,imageHint=false){
    this.remove(key);const cost=256+2*(key.length+signature.length)+json.byteLength;
    if(cost>this.maxBytes)return;
    while(this.rows.size>=this.maxEntries||this.retained+cost>this.maxBytes)this.remove(this.rows.keys().next().value!);
    this.rows.set(key,{signature,json:json.slice(),cost,imageHint});this.retained+=cost;
  }
  delete(key:string){this.remove(key);}
}
