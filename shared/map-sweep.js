'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.OrbitalSweep=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function create({ids,origin}){
    const extent=1200;
    return {origin:{...origin},extent,age:0,duration:8,remaining:new Set(ids),
      get progress(){return Math.min(1,this.age/this.duration);},
      get radius(){return this.extent*this.progress;},
      get done(){return this.age>=this.duration+.6;},
      advance(seconds){this.age+=Math.max(0,seconds);},
      hits(positions){const hits=[];for(const id of this.remaining){const p=positions.get(id);if(this.progress>=1||(p&&Math.hypot(p.x-this.origin.x,p.y-this.origin.y)<=this.radius)){hits.push(id);this.remaining.delete(id);}}return hits;}
    };
  }
  return {create};
});
