import {AsyncLocalStorage} from 'node:async_hooks';
export type MainWriteAccess=<T>(action:()=>T|Promise<T>)=>Promise<T>;
type MainLease={pause:()=>boolean;resume:()=>Promise<void>};

// WAL readers do not need a lease. Main-connection writers may share one another's
// event loop, but must never run while the separate worker owns SQLite's write lock.
export class WriteCoordinator{
  private mainUsers=0;
  private workerActive=false;
  private mainWaiters:(()=>void)[]=[];
  private workerWaiters:{ready:()=>void;queuedAt:number}[]=[];
  private leases=new WeakMap<()=>void,MainLease>();
  private context=new AsyncLocalStorage<MainLease|undefined>();
  constructor(private mainGraceMs=100,private now:()=>number=()=>performance.now()){}
  async enterMain():Promise<()=>void>{
    await this.acquireMain();
    let active=true,closed=false,paused=false;
    const release=()=>{if(closed)return;closed=true;if(active){active=false;this.mainUsers--;this.drain();}};
    const lease:MainLease={pause:()=>{if(closed)return false;if(paused)throw Error('同一主连接许可不能并行暂停');paused=true;active=false;this.mainUsers--;this.drain();return true;},resume:async()=>{if(!closed){await this.acquireMain();if(closed){this.mainUsers--;this.drain();}else active=true;}paused=false;}};
    this.leases.set(release,lease);return release;
  }
  private async acquireMain(){
    if(this.workerActive||(this.workerWaiters.length>0&&this.now()-this.workerWaiters[0].queuedAt>=this.mainGraceMs))await new Promise<void>(resolve=>this.mainWaiters.push(resolve));
    else this.mainUsers++;
  }
  withLeaseContext<T>(release:(()=>void)|undefined,action:()=>T){return this.context.run(release?this.leases.get(release):undefined,action);}
  readonly withMain:MainWriteAccess=async action=>{const release=await this.enterMain();try{return await this.withLeaseContext(release,action);}finally{release();}};
  // Only the awaited non-database operation belongs here. Resume the same logical
  // permit before callers validate or write their result. Contexts do not inherit
  // outer permits: background jobs must own their own withMain scope.
  readonly waitWithoutMain=async<T>(action:()=>Promise<T>):Promise<T>=>{const lease=this.context.getStore(),paused=lease?.pause();try{return await action();}finally{if(paused)await lease!.resume();}};
  async withWorker<T>(action:()=>Promise<T>):Promise<T>{
    await new Promise<void>(resolve=>{this.workerWaiters.push({ready:resolve,queuedAt:this.now()});this.drain();});
    try{return await action();}finally{this.workerActive=false;this.drain(true);}
  }
  private drain(preferMain=false){
    if(this.workerActive||this.mainUsers>0)return;
    const wakeMain=()=>{const waiters=this.mainWaiters.splice(0);this.mainUsers+=waiters.length;for(const resolve of waiters)resolve();};
    // Alternate pending main groups and worker batches. Stop admitting fresh main
    // tasks after a bounded grace period; already accepted work is always drained.
    if(preferMain&&this.mainWaiters.length){wakeMain();return;}
    if(this.workerWaiters.length){this.workerActive=true;this.workerWaiters.shift()!.ready();}
    else if(this.mainWaiters.length)wakeMain();
  }
}
