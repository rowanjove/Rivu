/** Source stages do not persist articles. The caller owns scheduling, rules and commits. */
export interface SourceAdapter<Input, Candidate, Fetched, Parsed, Result> {
  readonly id:string;
  discover(input:Input):Promise<Candidate[]>;
  fetch(candidate:Candidate):Promise<Fetched>;
  parse(fetched:Fetched,candidate:Candidate):Promise<Parsed>;
  normalize(parsed:Parsed,candidate:Candidate):Result;
}

/** Run an already selected candidate without repeating discovery or authorization. */
export async function readSourceCandidate<I,C,F,P,R>(adapter:SourceAdapter<I,C,F,P,R>,candidate:C):Promise<R>{
  const fetched=await adapter.fetch(candidate);
  const parsed=await adapter.parse(fetched,candidate);
  return adapter.normalize(parsed,candidate);
}

export async function discoverSource<I,C,F,P,R>(adapter:SourceAdapter<I,C,F,P,R>,input:I):Promise<R[]>{
  const candidates=await adapter.discover(input);
  const results:R[]=[];
  for(const candidate of candidates)results.push(await readSourceCandidate(adapter,candidate));
  return results;
}
