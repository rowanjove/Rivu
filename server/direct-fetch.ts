import { Agent, fetch as checkedFetch } from 'undici';

const directDispatcher=new Agent();

export function directFetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>{
  // Use the patched package implementation, not Electron/Node's independently
  // versioned global fetch. Keep all AI/local API traffic off ambient proxies.
  return checkedFetch(input as Parameters<typeof checkedFetch>[0],{
    ...init,dispatcher:directDispatcher,
  } as Parameters<typeof checkedFetch>[1]) as unknown as Promise<Response>;
}
