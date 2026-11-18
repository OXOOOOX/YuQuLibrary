import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { alive, atomicJson, initializeRuntime, readJson, repositoryRoot, serviceEnvironment, servicePaths } from './service-runtime.mjs';
import { INFERENCE_DIAGNOSTIC_CODES } from './inference-diagnostics.mjs';

export const SERVICE_PORT=38173;
export const restartDelay=(failures)=>Math.min(60000,2000*2**Math.min(5,Math.max(0,failures-1)));
const phases=new Set(['starting','idle','working','waiting','stopping']);
const errorCodes=new Set([...INFERENCE_DIAGNOSTIC_CODES,'ASR_ABORTED','ASR_TIMEOUT','ASR_NETWORK','ASR_UNAUTHORIZED',
  'ASR_LEASE_LOST','ASR_HTTP_STATUS','ASR_REDIRECT_REJECTED','ASR_RESPONSE_INVALID','ASR_RESPONSE_TOO_LARGE',
  'ASR_TASK_INVALID','ASR_MEDIA_STORAGE','ASR_MEDIA_LENGTH','ASR_MEDIA_HASH','ABORTED','INFERENCE_FAILED']);
export async function supervise({paths=servicePaths(),port=SERVICE_PORT,workerCommand,spawnChild=spawn,
  retryDelay=restartDelay,heartbeatMs=45000,stopGraceMs=20000,externalSignal}={}) {
  await initializeRuntime(paths);
  // An OS-owned listener releases automatically on process death; no stale lock directory to guess at.
  const nonce=randomUUID(),startedAt=new Date().toISOString();
  const mutex=net.createServer(socket=>socket.end(JSON.stringify({nonce,pid:process.pid})));
  await new Promise((resolve,reject)=>{mutex.once('error',reject);mutex.listen({host:'127.0.0.1',port,exclusive:true},resolve);});
  let worker,stopping=false,timer,failures=0,restarts=0,logTail=Promise.resolve(),initialized=false,stateFailure;
  let current={kind:'yuqu-asr-service-v1',pid:process.pid,nonce,startedAt,servicePort:mutex.address().port,phase:'starting',workerPid:null,restarts:0};
  let writes=Promise.resolve();
  const publish=changes=>{current={...current,...changes,updatedAt:new Date().toISOString()};const snapshot={...current};writes=writes.then(()=>atomicJson(paths.state,snapshot)).catch(error=>{stateFailure??=error;stopping=true;if(worker?.connected)worker.send({type:'stop'},()=>{});});return writes;};
  const log=(event,details={})=>{
    const line=JSON.stringify({at:new Date().toISOString(),event,...details})+'\n';
    logTail=logTail.then(async()=>{
      const size=await stat(paths.log).then(s=>s.size).catch(()=>0);
      if(size>2*1024*1024){await unlink(paths.log+'.2').catch(()=>{});await rename(paths.log+'.1',paths.log+'.2').catch(()=>{});await rename(paths.log,paths.log+'.1');}
      await appendFile(paths.log,line,{mode:0o600});
    }).catch(()=>{});
  };
  const stop=()=>{if(stopping)return;stopping=true;void publish({phase:'stopping'});if(worker?.connected)worker.send({type:'stop'},()=>{});};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  externalSignal?.addEventListener('abort',stop,{once:true});
  try {
    const previous=await readJson(paths.state);
    const oldPid=Number(await readFile(paths.workerPid,'utf8').catch(()=>''));
    if(alive(oldPid)){
      // A surviving child of a dead managed supervisor gets time to finish its disconnect cleanup.
      if(previous?.kind!=='yuqu-asr-service-v1'||previous.workerPid!==oldPid||alive(previous.pid))throw new Error('ASR_UNMANAGED_WORKER_RUNNING');
      for(let wait=0;wait<60&&alive(oldPid);wait++)await delay(500);
      if(alive(oldPid))throw new Error('ASR_PREVIOUS_WORKER_STOPPING');
    }
    initialized=true;await publish({phase:'starting'});
    if(externalSignal?.aborted)stop();
    let checking=false;
    timer=setInterval(()=>{
      if(checking)return;checking=true;
      void Promise.all([readJson(paths.stop),readJson(paths.enabled)]).then(([request,enabled])=>{if(request?.nonce===nonce||enabled?.enabled!==true)stop();}).catch(()=>stop()).finally(()=>{checking=false;});
    },500);
    while(!stopping){
      if((await readJson(paths.enabled))?.enabled!==true){stop();break;}
      const began=Date.now();let lastHeartbeat=began,stopSentAt=0,watchdog,killed=false,registration=Promise.resolve();
      const command=workerCommand??[process.execPath,[`--env-file=${paths.envFile}`,paths.worker]];
      const outcome=await new Promise(resolve=>{
        let settled=false;
        const finish=code=>{if(!settled){settled=true;resolve(code);}};
        worker=spawnChild(command[0],command[1],{cwd:repositoryRoot,windowsHide:true,shell:false,
          stdio:['ignore','pipe','pipe','ipc'],env:serviceEnvironment()});
        worker.once('spawn',()=>{
          registration=writeFile(paths.workerPid,String(worker.pid),{mode:0o600}).then(()=>publish({phase:'starting',workerPid:worker.pid,restarts,nextRetryAt:null})).catch(error=>{stateFailure??=error;stop();});
          log('worker_started',{pid:worker.pid});
          if(stopping&&worker.connected)worker.send({type:'stop'},()=>{});
        });
        // Drain output without copying arbitrary exception text or environment values into service logs.
        worker.stdout?.on('data',()=>{});worker.stderr?.on('data',()=>{});
        worker.on('message',message=>{
          if(!message||message.type!=='status'||!phases.has(message.phase))return;
          lastHeartbeat=Date.now();
          const safe={phase:stopping?'stopping':message.phase,lastWorkerSeenAt:new Date().toISOString()};
          if(message.jobId===null||typeof message.jobId==='string'&&/^[0-9a-f-]{36}$/.test(message.jobId))safe.jobId=message.jobId;
          for(const key of ['completedMs','durationMs'])if(Number.isSafeInteger(message[key])&&message[key]>=0&&message[key]<=14400000)safe[key]=message[key];
          if(message.lastErrorCode===null)safe.lastErrorCode=null;
          else if(errorCodes.has(message.lastErrorCode)){
            safe.lastErrorCode=message.lastErrorCode;
            if(current.lastErrorCode!==message.lastErrorCode)log('task_interrupted',{jobId:safe.jobId??null,errorCode:message.lastErrorCode});
          }
          void publish(safe);
        });
        worker.once('error',()=>finish(1));worker.once('exit',code=>finish(code??1));
        watchdog=setInterval(()=>{
          if(!stopping&&Date.now()-lastHeartbeat<=heartbeatMs)return;
          if(!stopSentAt){stopSentAt=Date.now();if(worker.connected)worker.send({type:'stop'},()=>{});log('worker_stop_requested',{reason:stopping?'user':'heartbeat'});}
          if(!killed&&Date.now()-stopSentAt>stopGraceMs){killed=true;worker.kill();log('worker_terminated',{reason:'stop_timeout'});}
        },250);
      });
      clearInterval(watchdog);await registration;worker=undefined;
      await unlink(paths.workerPid).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await publish({workerPid:null});
      log('worker_exited',{code:outcome});
      if(stopping)break;
      failures=Date.now()-began>60000?1:failures+1;restarts++;
      const waitMs=retryDelay(failures);
      await publish({phase:'backoff',restarts,nextRetryAt:new Date(Date.now()+waitMs).toISOString()});
      log('worker_restart_scheduled',{waitMs});
      const until=Date.now()+waitMs;
      while(!stopping&&Date.now()<until)await delay(Math.min(250,until-Date.now()));
    }
  } finally {
    clearInterval(timer);process.off('SIGINT',stop);process.off('SIGTERM',stop);externalSignal?.removeEventListener('abort',stop);
    if(initialized)await publish({phase:'stopped',workerPid:null});await logTail;
    await new Promise(resolve=>mutex.close(resolve));
  }
  if(stateFailure)throw new Error('ASR_STATE_WRITE_FAILED');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  supervise().catch(error=>{console.error(['ASR_UNMANAGED_WORKER_RUNNING','ASR_PREVIOUS_WORKER_STOPPING','EADDRINUSE'].includes(error.code??error.message)?error.code??error.message:'ASR_SERVICE_FAILED');process.exitCode=1;});
}
