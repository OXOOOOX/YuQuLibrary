import { spawn,execFile } from 'node:child_process';
import { access,open,readFile,writeFile,stat,rename,unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { alive,atomicJson,initializeRuntime,readJson,repositoryRoot,serviceEnvironment,servicePaths,serviceStatus } from '../workers/transcription/service-runtime.mjs';

const paths=servicePaths(),action=process.argv[2]??'status';
async function start(explicit){
  await initializeRuntime(paths);
  if(explicit)await atomicJson(paths.enabled,{enabled:true});
  if(!explicit&&(await readJson(paths.enabled))?.enabled!==true)return;
  if((await serviceStatus(paths)).running)return;
  const legacy=Number(await readFile(paths.workerPid,'utf8').catch(()=>''));
  const former=await readJson(paths.state);
  if(alive(legacy)&&former?.workerPid!==legacy)throw new Error('检测到未托管的转写进程，请先停止旧实例。');
  await access(paths.envFile);
  const launcherLog=join(paths.root,'launcher.log');
  if(await stat(launcherLog).then(info=>info.size>1024*1024).catch(()=>false)){
    await unlink(launcherLog+'.1').catch(()=>{});await rename(launcherLog,launcherLog+'.1').catch(()=>{});
  }
  const output=await open(launcherLog,'a',0o600);
  try{
    const child=spawn(process.execPath,[join(repositoryRoot,'workers','transcription','service-supervisor.mjs')],{
      cwd:repositoryRoot,detached:true,windowsHide:true,shell:false,stdio:['ignore',output.fd,output.fd],
      env:{...serviceEnvironment(),YUQU_ASR_SERVICE_HOME:paths.root}});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
  }finally{await output.close();}
  for(let i=0;i<40;i++){const status=await serviceStatus(paths);if(status.running&&['idle','working','waiting','backoff'].includes(status.phase))return;await delay(250);}
  throw new Error('转写服务尚未就绪，请查看服务状态；没有重复启动。');
}
async function stop(){
  await initializeRuntime(paths);await atomicJson(paths.enabled,{enabled:false});
  const status=await serviceStatus(paths);if(!status.running)return;
  await atomicJson(paths.stop,{nonce:status.nonce,at:new Date().toISOString()});
  for(let i=0;i<60;i++){if(!alive(status.pid))return;await delay(500);}
  throw new Error('转写服务正在退出，请稍后查询状态。');
}
async function install(){
  if(process.platform!=='win32')throw new Error('此自启动安装入口仅适用于 Windows。');
  await initializeRuntime(paths);
  const launcher=join(paths.root,'start-service.vbs');
  const quoted=value=>'"'+value.replaceAll('"','""')+'"';
  const command=`"${process.execPath}" "${join(repositoryRoot,'scripts','asr-service.mjs')}" ensure`;
  await writeFile(launcher,`Set shell = CreateObject("WScript.Shell")\r\nshell.Environment("Process")("YUQU_ASR_SERVICE_HOME") = ${quoted(paths.root)}\r\nWScript.Quit shell.Run(${quoted(command)}, 0, True)\r\n`,'utf8');
  await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(repositoryRoot,'scripts','install-asr-autostart.ps1'),'-Launcher',launcher],{windowsHide:true});
  await start(true);
}
try{
  if(action==='start')await start(true);
  else if(action==='ensure')await start(false);
  else if(action==='stop')await stop();
  else if(action==='install-autostart')await install();
  else if(action!=='status')throw new Error('命令应为 start、stop、status 或 install-autostart。');
  if(action!=='ensure')console.log(JSON.stringify(await serviceStatus(paths),null,2));
}catch(error){console.error(error.code==='ENOENT'?'转写运行配置尚未就绪。':error.message);process.exitCode=1;}
