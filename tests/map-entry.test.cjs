'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {runInNewContext}=require('node:vm');

const script=readFileSync(join(__dirname,'../map-3d.js'),'utf8');
const seed='a'.repeat(64),other='b'.repeat(64);
const entry='http://localhost:4174/map-3d.html';

async function openMap(address,storage,{missingWorld}={}){
  let url=new URL(address);
  const nodes=new Map(),requests=[];
  await runInNewContext(script,{
    document:{getElementById(id){
      if(!nodes.has(id))nodes.set(id,id==='scene'?{getContext:()=>null}:{});
      return nodes.get(id);
    }},
    location:url,history:{replaceState(_state,_title,updated){url=new URL(updated,url);}},
    URL,URLSearchParams,OrbitalUnits:{},OrbitalCamera:{},
    localStorage:{
      getItem:key=>storage.get(key)??null,
      setItem:(key,value)=>storage.set(key,value),
      removeItem:key=>storage.delete(key)
    },
    async fetch(path){
      requests.push(path);
      const id=new URL(path,url).searchParams.get('worldId');
      const status=id===missingWorld?404:200;
      return {ok:status===200,status,json:async()=>({})};
    }
  });
  return {url,requests};
}

test('the default map entry restores the most recently opened seed and keeps the launch-panel anchor',async()=>{
  const storage=new Map();
  await openMap(entry+'?worldId='+seed,storage);
  await openMap(entry+'?worldId='+other,storage);
  const restored=await openMap(entry+'#launch-panel',storage);
  assert.deepEqual(restored.requests,['/api/model?worldId='+other]);
  assert.equal(restored.url.searchParams.get('worldId'),other);
  assert.equal(restored.url.hash,'#launch-panel');
});

test('explicit classic navigation clears the previous seed',async()=>{
  const storage=new Map();
  await openMap(entry+'?worldId='+seed,storage);
  const classic=await openMap(entry+'?worldId=',storage);
  assert.deepEqual(classic.requests,['/api/model']);
  assert.deepEqual((await openMap(entry,storage)).requests,['/api/model']);
});

test('an unavailable remembered seed falls back once and is forgotten',async()=>{
  const storage=new Map();
  await openMap(entry+'?worldId='+seed,storage);
  const restored=await openMap(entry,storage,{missingWorld:seed});
  assert.deepEqual(restored.requests,['/api/model?worldId='+seed,'/api/model']);
  assert.equal(restored.url.search,'');
  assert.deepEqual((await openMap(entry,storage)).requests,['/api/model']);
});
