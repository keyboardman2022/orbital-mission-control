'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const historyGL=require('../history-webgl.js');

const point=seq=>({seq,tick:seq*240,elapsedSeconds:seq,x:4.47e8+seq*.125,y:-2.1e8+seq*.25});

test('store retains four hundred thousand exact points without resampling',()=>{
  const store=historyGL.createStore({maxPoints:409600});
  for(let start=1;start<=400000;start+=5000){
    store.append(Array.from({length:Math.min(5000,400001-start)},(_,i)=>point(start+i)));
  }
  assert.equal(store.pointCount,400000);
  assert.equal(store.chunks.length,80);
  assert.deepEqual(store.segments,[{start:0,count:400000}]);
  assert.deepEqual([store.pointAt(0).seq,store.pointAt(199999).seq,store.pointAt(399999).seq],[1,200000,400000]);
});

test('store starts a separate segment at every sequence gap',()=>{
  const store=historyGL.createStore({maxPoints:20});
  store.append([point(10),point(11),point(14)]);
  store.append([point(15),point(21)]);
  assert.deepEqual(store.segments,[{start:0,count:2},{start:2,count:2},{start:4,count:1}]);
  assert.deepEqual(store.visibleRanges(14),[{start:0,count:2}]);
  assert.deepEqual(store.visibleRanges(100),store.segments.filter(segment=>segment.count>1));
});

test('store rejects duplicate, backwards, invalid and excessive points without mutating the accepted prefix',()=>{
  const store=historyGL.createStore({maxPoints:3});
  store.append([point(1),point(2)]);
  for(const bad of [point(2),point(1),{...point(3),x:Infinity},{...point(3),seq:3.5}]){
    assert.throws(()=>store.append([bad]));
    assert.equal(store.pointCount,2);
  }
  assert.throws(()=>store.append([point(3),point(4)]),/409600|上限|maximum/i);
  assert.equal(store.pointCount,2);
});

test('single point and empty stores never invent a line',()=>{
  const empty=historyGL.createStore({maxPoints:5});
  assert.deepEqual(empty.visibleRanges(100),[]);
  empty.append([point(7)]);
  assert.deepEqual(empty.visibleRanges(100),[]);
});
