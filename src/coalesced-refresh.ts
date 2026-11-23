/** Share concurrent refreshes; a change arriving during a pass requires a fresh pass. */
export function createCoalescedRefresh(action:()=>Promise<void>){
  let requested=0,active:Promise<void>|undefined;
  return ()=>{
    requested++;
    if(!active){
      const run=Promise.resolve().then(async()=>{
        try{
          let observed:number;
          do{observed=requested;await action();}while(observed!==requested);
        }finally{if(active===run)active=undefined;}
      });
      active=run;
    }
    return active;
  };
}
