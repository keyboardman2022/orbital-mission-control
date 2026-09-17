'use strict';
// The same projection drives rendering and pointer-to-world launch positions.
const OrbitalCamera=(()=>{
  const angle=-.48,tilt=.66,cos=Math.cos(angle),sin=Math.sin(angle);
  function view(width,height,zoom=1,offset={x:0,y:0}){
    const size=Math.min(width*1.22,height*1.49)*zoom;
    return {cx:width*.54+offset.x,cy:height*.49+offset.y,size,scale:size/1100};
  }
  function zoomAt(view,nextScale,anchor){
    const ratio=nextScale/view.scale;
    return {...view,cx:anchor.x+(view.cx-anchor.x)*ratio,
      cy:anchor.y+(view.cy-anchor.y)*ratio,size:view.size*ratio,scale:nextScale};
  }
  function pan(view,dx,dy){return {...view,cx:view.cx+dx,cy:view.cy+dy};}
  function followAt(view,point,target){const p=toScreen(point.x,point.y,view);return pan(view,target.x-p.x,target.y-p.y);}
  function originMarker(view,width,height){
    const x=Math.max(18,Math.min(width-100,view.cx)),y=Math.max(210,Math.min(height-230,view.cy));
    return {x,y,inView:x===view.cx&&y===view.cy,angle:Math.atan2(view.cy-y,view.cx-x)};
  }
  function toWorld(x,y,view){
    const dx=x-view.cx,dy=y-view.cy;
    return {x:(dx*cos+dy*sin)/view.scale,y:(-dx*sin+dy*cos)/(view.scale*tilt)};
  }
  function toScreen(x,y,view){
    return {x:view.cx+view.scale*(x*cos-y*tilt*sin),y:view.cy+view.scale*(x*sin+y*tilt*cos)};
  }
  return {view,toWorld,toScreen,zoomAt,pan,followAt,originMarker};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=OrbitalCamera;
