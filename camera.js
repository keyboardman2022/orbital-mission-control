'use strict';
// The same projection drives rendering and pointer-to-world launch positions.
const OrbitalCamera=(()=>{
  const angle=-.48,tilt=.66,cos=Math.cos(angle),sin=Math.sin(angle);
  const MAX_ZOOM=64;
  function zoomFromSlider(value,min){return min*(MAX_ZOOM/min)**(value/1000);}
  function zoomToSlider(zoom,min){return min===MAX_ZOOM?1000:Math.round(Math.log(zoom/min)/Math.log(MAX_ZOOM/min)*1000);}
  function wheelZoom(zoom,deltaY,deltaMode,height){
    const delta=deltaY*(deltaMode===1?16:deltaMode===2?height:1);
    return zoom*Math.exp(-delta*.001);
  }
  function view(width,height,zoom=1,offset={x:0,y:0}){
    const size=Math.min(width*1.22,height*1.49)*zoom;
    return {cx:width*.54+offset.x,cy:height*.49+offset.y,size,scale:size/1100};
  }
  function zoomAt(view,nextScale,anchor){
    const ratio=nextScale/view.scale;
    return {...view,cx:anchor.x+(view.cx-anchor.x)*ratio,
      cy:anchor.y+(view.cy-anchor.y)*ratio,size:view.size*ratio,scale:nextScale};
  }
  function minimumZoom(width,height,radius){
    const base=view(width,height);
    return Math.max(...[[0,0],[width,0],[0,height],[width,height]].map(([x,y])=>{
      const point=toWorld(x,y,base);return Math.hypot(point.x,point.y)/radius;
    }));
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
  function sphereSilhouette({horizontal,vertical,distance},radius,view,focalLength){
    if(Math.hypot(horizontal,vertical,distance)<=radius)return {inside:true};
    if(distance<=0)return null;
    // Project the tangent cone as an ellipse. As it reaches the camera plane,
    // cap the radius for a finite contour that can still be clipped by the canvas.
    const visibleRadius=Math.min(radius,distance*.999);
    const axial=distance**2-visibleRadius**2;
    const side=Math.hypot(horizontal,vertical);
    const shift=focalLength*distance/axial;
    return {x:view.cx+horizontal*shift,y:view.cy+vertical*shift,
      along:focalLength*visibleRadius*Math.sqrt(axial+side**2)/axial,
      across:focalLength*visibleRadius/Math.sqrt(axial),angle:Math.atan2(vertical,horizontal)};
  }
  function orbitTarget(center,pivot,from,to){
    const x=center.x-pivot.x,y=center.y-pivot.y,z=(center.z??0)-(pivot.z??0);
    const horizontal=x*Math.cos(from.yaw)-y*Math.sin(from.yaw);
    const forward=x*Math.sin(from.yaw)+y*Math.cos(from.yaw);
    const vertical=forward*Math.sin(from.pitch)-z*Math.cos(from.pitch);
    const depth=forward*Math.cos(from.pitch)+z*Math.sin(from.pitch);
    const rotatedForward=vertical*Math.sin(to.pitch)+depth*Math.cos(to.pitch);
    return {
      x:pivot.x+horizontal*Math.cos(to.yaw)+rotatedForward*Math.sin(to.yaw),
      y:pivot.y+rotatedForward*Math.cos(to.yaw)-horizontal*Math.sin(to.yaw),
      z:(pivot.z??0)+depth*Math.sin(to.pitch)-vertical*Math.cos(to.pitch)
    };
  }
  function createPinchGesture({start,zoom}){
    const touches=new Map();
    let pinching=false;
    function measure(){
      const [first,second]=touches.values();
      if(!second)return null;
      return {distance:Math.hypot(first.x-second.x,first.y-second.y),
        clientX:(first.x+second.x)/2,clientY:(first.y+second.y)/2};
    }
    function remember(event){touches.set(event.pointerId,{x:event.clientX,y:event.clientY});}
    return {
      down(event){
        if(event.pointerType!=='touch')return false;
        remember(event);
        if(!pinching&&touches.size===2){pinching=true;start();}
        return pinching;
      },
      move(event){
        if(!touches.has(event.pointerId))return false;
        const before=measure();
        remember(event);
        const after=measure();
        if(before?.distance&&after?.distance&&before.distance!==after.distance){
          zoom(after.distance/before.distance,after);
        }
        return pinching;
      },
      end(event){
        if(!touches.delete(event.pointerId))return false;
        const consumed=pinching;
        if(!touches.size)pinching=false;
        return consumed;
      }
    };
  }
  return {view,toWorld,toScreen,sphereSilhouette,orbitTarget,zoomAt,pan,followAt,originMarker,minimumZoom,MAX_ZOOM,zoomFromSlider,zoomToSlider,wheelZoom,createPinchGesture};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=OrbitalCamera;
