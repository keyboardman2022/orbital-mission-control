'use strict';
// Paczynski-Wiita test-particle dynamics, in dimensionless scene units.
// Phi(r) = -GM / (r - rs). This is NOT a relativistic geodesic solver.
const OrbitalPhysics = (() => {
  const MU=2000000, RS=66, CAPTURE_RADIUS=RS*1.05, ESCAPE_RADIUS=1200, STEP=1/240;
  function acceleration(x,y){
    const r=Math.hypot(x,y);
    if(r<=CAPTURE_RADIUS)return {x:0,y:0};
    const factor=-MU/(r*(r-RS)*(r-RS));
    return {x:x*factor,y:y*factor};
  }
  function circularSpeed(radius){return Math.sqrt(MU*radius)/(radius-RS);}
  function angularSpeed(radius){return circularSpeed(radius)/radius;}
  function energy(p){return .5*(p.vx*p.vx+p.vy*p.vy)-MU/(Math.hypot(p.x,p.y)-RS);}
  function angularMomentum(p){return p.x*p.vy-p.y*p.vx;}
  function createParticle(x,y,mode='infall',mass=1){
    const r=Math.hypot(x,y),safeRadius=Math.max(r,CAPTURE_RADIUS);
    const tx=r?-y/r:0,ty=r?x/r:1;
    const vc=circularSpeed(safeRadius);
    const velocity=mode==='escape'?1.1*Math.sqrt(2*MU/(safeRadius-RS)):mode==='orbit'?vc:vc*.5;
    return {x,y,vx:tx*velocity,vy:ty*velocity,mass,escapeRadius:Math.max(ESCAPE_RADIUS,r*3),status:r<=CAPTURE_RADIUS?'captured':'active',trail:[[x,y]],trailTime:0};
  }
  function segmentHitsCapture(x,y,nx,ny){
    const dx=nx-x,dy=ny-y,length2=dx*dx+dy*dy;
    const u=length2?Math.max(0,Math.min(1,-(x*dx+y*dy)/length2)):0;
    return Math.hypot(x+u*dx,y+u*dy)<=CAPTURE_RADIUS;
  }
  // Kick-drift-kick velocity Verlet: fixed steps preserve central-force invariants.
  function step(p,dt=STEP){
    if(p.status!=='active'||dt===0)return;
    const a=acceleration(p.x,p.y),vx=p.vx+a.x*dt/2,vy=p.vy+a.y*dt/2;
    const nx=p.x+vx*dt,ny=p.y+vy*dt;
    if(segmentHitsCapture(p.x,p.y,nx,ny)){p.status='captured';return;}
    p.x=nx;p.y=ny;
    const b=acceleration(nx,ny);p.vx=vx+b.x*dt/2;p.vy=vy+b.y*dt/2;
    if(Math.hypot(nx,ny)>(p.escapeRadius??ESCAPE_RADIUS)&&nx*p.vx+ny*p.vy>0&&energy(p)>0)p.status='escaped';
    p.trailTime+=dt;
    if(p.trailTime>=1/30){p.trailTime-=1/30;p.trail.push([nx,ny]);if(p.trail.length>70)p.trail.shift();}
  }
  class Simulation {
    constructor(){this.particles=[];this.accumulator=0;}
    advance(elapsed){
      if(!Number.isFinite(elapsed)||elapsed<=0)return [];
      this.accumulator+=elapsed;const removed=[];
      while(this.accumulator+1e-12>=STEP){
        for(let i=this.particles.length-1;i>=0;i--){
          const p=this.particles[i];step(p);
          if(p.status!=='active'){removed.push(p);this.particles.splice(i,1);}
        }
        this.accumulator=Math.max(0,this.accumulator-STEP);
      }
      return removed;
    }
    clear(){this.particles.length=0;this.accumulator=0;}
  }
  return {MU,RS,CAPTURE_RADIUS,ESCAPE_RADIUS,STEP,acceleration,circularSpeed,angularSpeed,energy,angularMomentum,createParticle,step,Simulation};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=OrbitalPhysics;
