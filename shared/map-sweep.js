'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.OrbitalSweep=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function viewportExtent(view,width,height,camera){return Math.max(...[[0,0],[width,0],[0,height],[width,height]].map(([x,y])=>{const p=camera.toWorld(x,y,view);return Math.hypot(p.x,p.y);}))*1.05;}
  function create({ids,origin,extent=1200}){
    const speed=150;
    return {origin:{...origin},extent,age:0,duration:extent/speed,speed,_radius:0,cancelled:false,remaining:new Set(ids),
      get progress(){return Math.min(1,this.radius/this.extent);},
      get radius(){return this._radius;},
      get done(){return this.cancelled||this.age>=this.duration+.6;},
      advance(seconds){if(this.cancelled)return;const dt=Math.max(0,seconds);this.age+=dt;this._radius=Math.min(this.extent,this._radius+this.speed*dt);},
      extendTo(distance){if(distance<=this.extent*(1+1e-6)||this.cancelled)return;this.extent=distance;this.duration=this.age+(distance-this.radius)/this.speed;},
      cancel(){this.cancelled=true;},
      hits(positions){const hits=[];for(const id of this.remaining){const p=positions.get(id);if(this.progress>=1||(p&&Math.hypot(p.x-this.origin.x,p.y-this.origin.y)<=this.radius)){hits.push(id);this.remaining.delete(id);}}return hits;}
    };
  }
  return {create,viewportExtent};
});
