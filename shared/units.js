(function(root,factory){
 'use strict';const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;else root.OrbitalUnits=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 // IAU 2015 B3 nominal GM_sun; SI speed of light is exact.
 const C_KM_S=299792.458,gmM3S2=10*1.3271244e20;
 const schwarzschildRadiusKm=2*gmM3S2/(C_KM_S*1000)**2/1000;
 const kmPerUnit=schwarzschildRadiusKm/66;
 const secondsPerUnit=Math.sqrt(2000000*(kmPerUnit*1000)**3/gmM3S2);
 const SCALE=Object.freeze({version:'nominal-10msun-v1',centralMassSolar:10,gmM3S2,
   schwarzschildRadiusKm,kmPerUnit,secondsPerUnit,kmSPerUnit:kmPerUnit/secondsPerUnit,
   assumed:true,description:'10 nominal solar masses; example calibration, not an observed black hole'});
 const toKm=(v,s=SCALE)=>v*s.kmPerUnit,fromKm=(v,s=SCALE)=>v/s.kmPerUnit;
 const toKmS=(v,s=SCALE)=>v*s.kmSPerUnit,fromKmS=(v,s=SCALE)=>v/s.kmSPerUnit;
 function telemetry(state,s=SCALE){
   const speed=Math.hypot(state.vx,state.vy),speedKmS=toKmS(speed,s);
   return {speed,speedKmS,vxKmS:toKmS(state.vx,s),vyKmS:toKmS(state.vy,s),
     xKm:toKm(state.x,s),yKm:toKm(state.y,s),radiusKm:toKm(Math.hypot(state.x,state.y),s),
     physicalElapsedSeconds:state.elapsedSeconds*s.secondsPerUnit,
     fractionOfC:speedKmS/C_KM_S,physicalSpeedValid:Number.isFinite(speedKmS)&&speedKmS<C_KM_S,
     approximation:'Paczynski-Wiita coordinate velocity; not a relativistic local measurement'};
 }
 // 1/2/5 ruler divisions, anchored in world units rather than screen pixels.
 function niceDistance(target){const power=10**Math.floor(Math.log10(Math.max(target,1e-20)));const n=target/power;return (n>=5?5:n>=2?2:1)*power;}
 function formatKm(km){const a=Math.abs(km);if(a>=1e9)return (km/1e9).toPrecision(3)+' 十亿 km';if(a>=1e6)return (km/1e6).toPrecision(3)+' 百万 km';return km.toLocaleString('zh-CN',{maximumFractionDigits:a<1?4:2})+' km';}
 function formatSpeed(state,s=SCALE){const t=telemetry(state,s);return t.physicalSpeedValid?'≈ '+t.speedKmS.toLocaleString('zh-CN',{maximumFractionDigits:2})+' km/s':'超出物理适用范围';}
 return Object.freeze({C_KM_S,SCALE,toKm,fromKm,toKmS,fromKmS,telemetry,niceDistance,formatKm,formatSpeed});
});
