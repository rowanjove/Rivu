import { parentPort, workerData } from 'node:worker_threads';

const {databasePath,modulePath}=workerData as {databasePath:string;modulePath:string};

void (async()=>{try {
  const {RivuDatabase}=require(modulePath) as typeof import('../server/database');
  const db=await RivuDatabase.open(databasePath,phase=>parentPort?.postMessage({phase}));
  db.close();
  parentPort?.postMessage({done:true});
} catch(error) {
  parentPort?.postMessage({error:error instanceof Error?error.message:String(error)});
}})();
