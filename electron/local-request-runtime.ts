import {createRequire} from 'node:module';

// Fastify lazily loads its injection runtime on the first desktop IPC request.
// Initialize that exact dependency before showing the window, without issuing
// a request or reading an article. Resolve from Fastify to share its cache even
// when a dependency manager installs a separate nested version.
export function prepareLocalRequestRuntime(moduleFilename:string):void {
  const runtimeRequire=createRequire(moduleFilename);
  const fastifyRequire=createRequire(runtimeRequire.resolve('fastify'));
  fastifyRequire('light-my-request');
}
