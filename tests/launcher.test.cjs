'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {existsSync,mkdirSync,mkdtempSync,copyFileSync,writeFileSync,readFileSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {spawnSync}=require('node:child_process');
const net=require('node:net');

const root=join(__dirname,'..'),launcher=join(root,'ORBITAL.exe');
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(error=>error?reject(error):resolve(port));});});

test('Windows launcher starts the adjacent project once and reuses the healthy service',{skip:process.platform!=='win32',timeout:30000},async()=>{
  const fixture=mkdtempSync(join(tmpdir(),'orbital-launcher-')),serverDir=join(fixture,'server'),dataDir=join(fixture,'data');
  let pid=null;
  try{
    assert.equal(existsSync(launcher),true,'ORBITAL.exe must be built before the launcher test');
    mkdirSync(serverDir);mkdirSync(dataDir);copyFileSync(launcher,join(fixture,'ORBITAL.exe'));
    writeFileSync(join(serverDir,'index.js'),`'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const lock=path.join(__dirname,'..','data','server.lock');
fs.writeFileSync(lock,JSON.stringify({pid:process.pid}));
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(req.url==='/health'?JSON.stringify({status:'running'}):'{}');});
const stop=()=>server.close(()=>{try{fs.unlinkSync(lock);}catch{}process.exit(0);});
process.on('SIGTERM',stop);process.on('SIGINT',stop);server.listen(Number(process.env.PORT),'127.0.0.1');
`);
    const port=await freePort(),env={...process.env,PORT:String(port),ORBITAL_NODE_EXE:process.execPath};
    const firstStarted=Date.now(),first=spawnSync(join(fixture,'ORBITAL.exe'),['--no-browser'],{env,stdio:'ignore',timeout:15000,windowsHide:true}),firstDuration=Date.now()-firstStarted;
    if(existsSync(join(dataDir,'server.lock')))pid=JSON.parse(readFileSync(join(dataDir,'server.lock'),'utf8')).pid;
    assert.equal(first.error,undefined,first.error?.message);
    assert.equal(first.status,0,`launcher exit ${first.status}`);
    assert.ok(firstDuration<5000,`launcher held the caller open for ${firstDuration}ms`);
    const second=spawnSync(join(fixture,'ORBITAL.exe'),['--no-browser'],{env,stdio:'ignore',timeout:15000,windowsHide:true});
    assert.equal(second.status,0,second.error?.message||`launcher exit ${second.status}`);
    assert.equal(JSON.parse(readFileSync(join(dataDir,'server.lock'),'utf8')).pid,pid,'a healthy service must not be started twice');
  }finally{
    if(pid)try{process.kill(pid,'SIGTERM');}catch{}
    await new Promise(resolve=>setTimeout(resolve,300));
    rmSync(fixture,{recursive:true,force:true});
  }
});
