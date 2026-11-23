const extensions:Record<string,string>={
  'image/avif':'avif','image/webp':'webp','image/png':'png','image/jpeg':'jpg','image/gif':'gif',
  'audio/mpeg':'mp3','audio/mp4':'m4a','audio/aac':'aac','audio/ogg':'ogg','audio/opus':'opus','audio/flac':'flac','audio/wav':'wav','audio/x-wav':'wav','audio/webm':'webm',
  'video/mp4':'mp4','video/webm':'webm','video/ogg':'ogv','video/mpeg':'mpeg','video/quicktime':'mov',
};
export function archiveAssetExtension(kind:string,mime:string):string {
  if(kind==='snapshot')return 'html'; // Snapshots always pass through the read-only HTML wrapper.
  const type=mime.split(';')[0].trim().toLowerCase();
  return type.startsWith(kind+'/')?extensions[type]||'bin':'bin';
}
