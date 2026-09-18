'use strict';
const http=require('node:http');
const {Worker}=require('node:worker_threads');
const {join,resolve,basename}=require('node:path');
const {mkdirSync,openSync,writeFileSync,closeSync,readFileSync,unlinkSync,existsSync,statSync,createReadStream,readdirSync}=require('node:fs');
const {timingSafeEqual}=require('node:crypto');
const {createStreamState,buildSnapshot}=require('./stream-snapshot.js');
const ROOT=resolve(__dirname,'..');
const HELD_LOCKS=new Set();
const FILES=new Set(['index.html','style.css','app.js','interactions.js','physics.js','camera.js','mission.html','mission.css','mission.js','preview-worker.js','orbital-visuals.js','shared/simulation.js','shared/units.js','shared/history-window.js','shared/map-sweep.js']);
const TYPES={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',json:'application/json; charset=utf-8',csv:'text/csv; charset=utf-8'};
const error=(status,message)=>Object.assign(new Error(message),{status});
function acquireLock(dataDir){
  const path=join(dataDir,'server.lock');
  if(HELD_LOCKS.has(path))throw new Error('该数据目录已有运行中的服务');
  if(existsSync(path)){
    let pid;try{pid=JSON.parse(readFileSync(path,'utf8')).pid;}catch{throw new Error('数据目录锁文件损坏，请检查是否有实例运行');}
    if(pid!==process.pid)try{process.kill(pid,0);throw new Error('该数据目录已有运行中的服务');}catch(e){if(e.code!=='ESRCH')throw e;}
    unlinkSync(path);
  }
  const fd=openSync(path,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid}));closeSync(fd);HELD_LOCKS.add(path);return ()=>{HELD_LOCKS.delete(path);try{unlinkSync(path);}catch{}};
}
async function startServer({port=Number(process.env.PORT||4174),host=process.env.HOST||'127.0.0.1',dataDir=process.env.ORBITAL_DATA_DIR||join(ROOT,'data'),publicOrigin=process.env.PUBLIC_ORIGIN,maxActive=Number(process.env.ORBITAL_MAX_ACTIVE||1000),velocityRelativeTolerance=Number(process.env.ORBITAL_VELOCITY_RELATIVE_TOLERANCE??'.001')}={}){
  if(!Number.isSafeInteger(maxActive)||maxActive<1)throw new Error('ORBITAL_MAX_ACTIVE 必须为正整数');
  dataDir=resolve(dataDir);mkdirSync(dataDir,{recursive:true});const exportsDir=join(dataDir,'exports');mkdirSync(exportsDir,{recursive:true});
  const unlock=acquireLock(dataDir),filename=join(dataDir,'orbital.sqlite');
  const worker=new Worker(join(__dirname,'simulation-worker.js'),{workerData:{filename,maxActive,velocityRelativeTolerance}});
  let rpcId=0,alive=true,closing=false;const pending=new Map(),streams=new Set(),exportWorkers=new Set(),exportQueue=[];
  const rpc=(method,...args)=>new Promise((resolve,reject)=>{
    if(!alive)return reject(error(503,'模拟服务暂不可用'));
    if(pending.size>=1000)return reject(error(503,'请求队列已满，请稍后重试'));
    const id=++rpcId,timeout=setTimeout(()=>{pending.delete(id);reject(error(503,'服务器忙，请稍后重试'));},30000);
    pending.set(id,{resolve,reject,timeout});worker.postMessage({id,method,args});
  });
  const ready=new Promise((resolve,reject)=>{
    worker.on('message',message=>{
      if(message.type==='ready')resolve();
      if(message.type==='fatal'){alive=false;reject(new Error(message.message));console.error('模拟服务停止：',message.message);worker.terminate();}
      const p=pending.get(message.id);if(p){clearTimeout(p.timeout);pending.delete(message.id);message.error?p.reject(error(message.error.status,message.error.message)):p.resolve(message.result);}
    });
    worker.on('error',e=>{alive=false;reject(e);for(const p of pending.values()){clearTimeout(p.timeout);p.reject(error(503,'模拟服务异常'));}pending.clear();});
    worker.on('exit',()=>{alive=false;for(const p of pending.values()){clearTimeout(p.timeout);p.reject(error(503,'模拟服务已停止'));}pending.clear();});
  });
  try{await ready;}catch(e){await worker.terminate();unlock();throw e;}
  function json(res,status,value){res.writeHead(status,{'Content-Type':TYPES.json,'Cache-Control':'no-store'});res.end(JSON.stringify(value));}
  async function body(req){
    if(!String(req.headers['content-type']||'').startsWith('application/json'))throw error(415,'请求必须为 JSON');
    let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>16384)throw error(413,'请求内容过大');chunks.push(chunk);}
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw error(400,'JSON 格式不正确');}
    if(!result||typeof result!=='object'||Array.isArray(result))throw error(422,'请求必须是一个对象');return result;
  }
  const tokenOf=req=>{const entry=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('orbital_session='));return entry?.slice('orbital_session='.length);};
  const cookie=(res,token,clear=false)=>res.setHeader('Set-Cookie',`orbital_session=${token||''}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear?0:2592000}${publicOrigin?.startsWith('https:')?'; Secure':''}`);
  function checkOrigin(req){
    const origin=req.headers.origin,expected=publicOrigin||`http://${req.headers.host}`;
    if(req.headers['sec-fetch-site']==='cross-site'||(origin&&origin!==expected))throw error(403,'不允许跨站修改数据');
  }
  function checkCsrf(req,auth){const actual=Buffer.from(String(req.headers['x-csrf-token']||'')),wanted=Buffer.from(auth.csrfToken);if(actual.length!==wanted.length||!timingSafeEqual(actual,wanted))throw error(403,'会话校验失败，请重新连接');}
  const rates=new Map();
  function rate(req,key,max){const id=(req.socket.remoteAddress||'local')+':'+key,now=Date.now(),old=rates.get(id);const r=old&&now-old.start<60000?old:{start:now,n:0};r.n++;rates.set(id,r);if(r.n>max)throw error(429,'操作过于频繁，请一分钟后重试');}
  function publicExport(record){const {satellite,model,...out}=record;return {...out,downloadUrl:record.status==='ready'?`/api/exports/${record.id}/download`:null};}
  function startExport(){
    if(closing||exportWorkers.size>=2||!exportQueue.length)return;
    const record=exportQueue.shift(),target=join(exportsDir,record.id+'.'+record.format);
    const ew=new Worker(join(__dirname,'export-worker.js'),{workerData:{filename,target,record}});exportWorkers.add(ew);let reported=false;
    ew.on('message',async result=>{reported=true;try{await rpc('finishExport',record.id,result);}catch{}});
    ew.on('error',async()=>{reported=true;try{await rpc('finishExport',record.id,{status:'failed',message:'导出失败，请重试'});}catch{}});
    ew.on('exit',async()=>{exportWorkers.delete(ew);if(!reported)try{await rpc('finishExport',record.id,{status:'failed',message:'导出中断，请重试'});}catch{}startExport();});
    startExport();
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try{
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      if(path==='/health'){const health=await rpc('health');return json(res,health.status==='clock_error'?503:200,{ok:health.status==='running',...health});}
      if(!path.startsWith('/api/')){
        if(!['GET','HEAD'].includes(req.method))throw error(405,'不支持该请求方法');
        const file=path==='/'?'index.html':path.slice(1);if(!FILES.has(file)||!existsSync(join(ROOT,file)))throw error(404,'页面不存在');
        res.writeHead(200,{'Content-Type':TYPES[file.split('.').at(-1)]||'application/octet-stream','Cache-Control':'no-cache'});
        if(req.method==='HEAD')return res.end();return createReadStream(join(ROOT,file)).on('error',()=>res.destroy()).pipe(res);
      }
      const mutating=!['GET','HEAD'].includes(req.method);if(mutating)checkOrigin(req);
      if(path==='/api/session/guest'&&req.method==='POST'){
        rate(req,'guest',30);await body(req);const result=await rpc('guest',tokenOf(req));cookie(res,result.token);const {token,...safe}=result;return json(res,200,safe);
      }
      if(path==='/api/model'&&req.method==='GET')return json(res,200,await rpc('model'));
      const token=tokenOf(req),auth=await rpc('authenticate',token);if(mutating)checkCsrf(req,auth);
      if(path==='/api/session/recover'&&req.method==='POST'){
        rate(req,'recovery',10);const input=await body(req),result=await rpc('recover',input.recoveryKey);await rpc('logout',token);cookie(res,result.token);const {token:secret,...safe}=result;return json(res,200,safe);
      }
      if(path==='/api/session/recovery-key'&&req.method==='POST'){rate(req,'recovery',10);await body(req);return json(res,200,await rpc('rotateRecovery',auth.userId));}
      if(path==='/api/session'&&req.method==='DELETE'){await rpc('logout',token);cookie(res,'',true);for(const s of streams)if(s.token===token)s.res.end();return json(res,200,{ok:true});}
      if(path==='/api/stream'&&req.method==='GET'){
        if([...streams].filter(s=>s.userId===auth.userId).length>=5)throw error(429,'实时连接过多，请关闭多余页面');
        const selectedId=url.searchParams.get('satelliteId');if(selectedId)await rpc('get',auth.userId,selectedId);
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('retry: 2000\n\n');
        const stream={res,token,userId:auth.userId,selectedId,snapshot:createStreamState()};streams.add(stream);res.on('close',()=>streams.delete(stream));return;
      }
      if(path==='/api/satellites'&&req.method==='GET')return json(res,200,await rpc('list',auth.userId,Object.fromEntries(url.searchParams)));
      if(path==='/api/satellites'&&req.method==='POST'){
        rate(req,'launch',120);return json(res,201,{satellite:await rpc('launch',auth.userId,await body(req))});
      }
      if(path==='/api/satellites/active'&&req.method==='GET')return json(res,200,await rpc('active',auth.userId));
      if(path==='/api/satellites/terminate-many'&&req.method==='POST'){
        rate(req,'sweep',120);const input=await body(req);return json(res,200,await rpc('terminateMany',auth.userId,input.ids));
      }
      const sat=path.match(/^\/api\/satellites\/([a-f0-9-]{36})(?:\/(trajectory|terminate|exports))?$/);
      if(sat){
        const [,id,action]=sat;
        if(!action&&req.method==='GET')return json(res,200,{satellite:await rpc('get',auth.userId,id)});
        if(action==='trajectory'&&req.method==='GET')return json(res,200,await rpc('trajectory',auth.userId,id,Object.fromEntries(url.searchParams)));
        if(action==='terminate'&&req.method==='POST'){await body(req);return json(res,200,{satellite:await rpc('terminate',auth.userId,id)});}
        if(action==='exports'&&req.method==='POST'){
          rate(req,'export',20);if(exportQueue.length>=20)throw error(503,'导出队列已满，请稍后重试');
          const input=await body(req),record=await rpc('prepareExport',auth.userId,id,input.format);exportQueue.push(record);startExport();return json(res,202,{export:publicExport(record)});
        }
      }
      const exp=path.match(/^\/api\/exports\/([a-f0-9-]{36})(?:\/(download))?$/);
      if(exp&&req.method==='GET'){
        const record=await rpc('getExport',auth.userId,exp[1]);
        if(!exp[2])return json(res,200,{export:publicExport(record)});
        if(new Date(record.expiresAt)<new Date())throw error(410,'导出文件已过期，请重新生成');
        if(record.status!=='ready')throw error(409,'导出尚未完成');const file=join(exportsDir,record.id+'.'+record.format);if(!existsSync(file))throw error(410,'导出文件不可用，请重新生成');
        res.writeHead(200,{'Content-Type':TYPES[record.format],'Content-Disposition':`attachment; filename="orbital-${record.satelliteId}.${record.format}"`,'Content-Length':statSync(file).size,'Cache-Control':'private, no-store'});return createReadStream(file).on('error',()=>res.destroy()).pipe(res);
      }
      throw error(404,'接口不存在');
    }catch(e){if(res.headersSent)return res.destroy();json(res,e.status||500,{error:{code:e.status||500,message:e.status?e.message:'服务器内部错误，请稍后重试'}});if(!e.status)console.error(e.message);}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  let broadcasting=false;
  const push=setInterval(async()=>{
    if(broadcasting||closing||!streams.size)return;broadcasting=true;
    try{
      const cache=new Map();for(const s of streams){
        try{await rpc('authenticate',s.token);if(!cache.has(s.userId))cache.set(s.userId,await rpc('list',s.userId,{limit:100}));let data=cache.get(s.userId);if(s.selectedId&&!data.satellites.some(p=>p.id===s.selectedId))data={...data,satellites:[...data.satellites,await rpc('get',s.userId,s.selectedId)]};if(s.res.writableLength>1024*1024){s.res.destroy();continue;}s.res.write('event: snapshot\ndata: '+JSON.stringify(buildSnapshot(s.snapshot,data,{selectedId:s.selectedId}))+'\n\n');}catch{s.res.end();}
      }
    }finally{broadcasting=false;}
  },200);
  const cleanup=setInterval(()=>{
    const now=Date.now();for(const [key,r] of rates)if(now-r.start>60000)rates.delete(key);
    for(const file of readdirSync(exportsDir)){if(!/^[a-f0-9-]{36}\.(csv|json)(\.partial)?$/.test(file))continue;const path=join(exportsDir,file);try{if(now-statSync(path).mtimeMs>7*86400000)unlinkSync(path);}catch{}}
  },60000);cleanup.unref();
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});}catch(e){clearInterval(push);clearInterval(cleanup);await worker.terminate();unlock();throw e;}
  const url=`http://${host==='0.0.0.0'?'127.0.0.1':host}:${server.address().port}`;
  async function close(){
    if(closing)return;closing=true;clearInterval(push);clearInterval(cleanup);for(const s of streams)s.res.end();streams.clear();
    const stopped=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();
    for(const ew of exportWorkers)await ew.terminate();
    try{await rpc('close');}catch{}await worker.terminate();await stopped;unlock();
  }
  return {server,url,close,worker};
}
if(require.main===module){startServer().then(app=>{
 console.log('ORBITAL listening '+app.url+'/mission.html');
 let stopping=false;
 app.worker.on('exit',()=>{if(!stopping){stopping=true;app.close().finally(()=>process.exit(1));}});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;app.close().then(()=>process.exit(0));});
}).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={startServer};
