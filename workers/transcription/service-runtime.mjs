import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { isAbsolute, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export function servicePaths(env = process.env) {
  const root = resolve(env.YUQU_ASR_SERVICE_HOME || join(env.LOCALAPPDATA || '', 'YuQuASRProd'));
  if (!env.YUQU_ASR_SERVICE_HOME && !env.LOCALAPPDATA) throw new Error('ASR_SERVICE_HOME_REQUIRED');
  if (env.YUQU_ASR_SERVICE_HOME && !isAbsolute(env.YUQU_ASR_SERVICE_HOME)) throw new Error('ASR_SERVICE_HOME_INVALID');
  return { root, state:join(root,'service-state.json'), enabled:join(root,'service-enabled.json'),
    stop:join(root,'stop-request.json'), workerPid:join(root,'worker.pid'), log:join(root,'service.log'),
    envFile:join(repositoryRoot,'.local','production','asr.env'), worker:join(repositoryRoot,'workers','transcription','remote.mjs') };
}
export const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid,0); return true; } catch(error) { return error.code !== 'ESRCH'; }
};
export async function readJson(path) { try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;} }
export async function atomicJson(path,value) {
  const temporary=`${path}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600});
  await rename(temporary,path);
}
export async function initializeRuntime(paths) { await mkdir(paths.root,{recursive:true,mode:0o700}); }
export async function serviceStatus(paths) {
  const state=await readJson(paths.state);
  if(state?.kind!=='yuqu-asr-service-v1')return {running:false};
  const running=state.phase!=='stopped' && alive(state.pid) && await new Promise(resolve=>{
    if(!Number.isInteger(state.servicePort)){resolve(false);return;}
    const socket=net.connect({host:'127.0.0.1',port:state.servicePort});let text='';
    const finish=value=>{socket.destroy();resolve(value);};
    socket.setTimeout(750,()=>finish(false));socket.on('error',()=>finish(false));
    socket.on('data',part=>{text+=part;if(text.length>8192)finish(false);});
    socket.on('end',()=>{try{const identity=JSON.parse(text);finish(identity.nonce===state.nonce&&identity.pid===state.pid);}catch{finish(false);}});
  });
  return {...state,running,workerAlive:alive(state.workerPid)};
}

/** Child inference receives an even smaller environment in process.mjs. */
export function serviceEnvironment(env=process.env) {
  const allowed=new Set(['path','systemroot','windir','comspec','temp','tmp','userprofile','localappdata','appdata',
    'programdata','programfiles','programfiles(x86)','systemdrive','number_of_processors','processor_architecture','cuda_path','cuda_path_v12_8']);
  return Object.fromEntries(Object.entries(env).filter(([name])=>allowed.has(name.toLowerCase())));
}
