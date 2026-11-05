'use strict';
// Procedural stellar surfaces, shared by all bodies in the mission's 2D scene.
const OrbitalStellar=(()=>{
  const profiles={
    ember:[[1,.40,.105],0],aurora:[[1,.61,.20],0],cyan:[[.56,.76,1],1],
    giant:[[1,.29,.075],2],ivory:[[.78,.86,1],1],cinder:[[1,.24,.055],2],
    sapphire:[[.37,.59,1],1],helios:[[1,.72,.32],0],colossus:[[1,.18,.055],2]
  };
  function profile(id){const [color,kind]=profiles[id]||profiles.aurora;return {color:[...color],kind};}
  const vertex='attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}';
  const fragment=`precision highp float;
uniform vec2 center;uniform float radius;uniform float time;uniform vec3 base;uniform float kind;uniform float opacity;
const float PI=3.14159265359;
float hash(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.03+vec3(7.3,1.6,4.9);a*=.5;}return v;}
vec2 hash2(vec2 p){return vec2(hash(vec3(p,1.)),hash(vec3(p,3.)));}
vec2 cells(vec2 p){vec2 i=floor(p),f=fract(p);float d1=10.,d2=10.;for(int y=-1;y<=1;y++){for(int x=-1;x<=1;x++){vec2 g=vec2(float(x),float(y));vec2 h=hash2(i+g);vec2 q=g+.5+.30*sin(6.2831*h+time*.12)-f;float d=dot(q,q);if(d<d1){d2=d1;d1=d;}else{d2=min(d2,d);}}}return vec2(sqrt(d1),sqrt(d2)-sqrt(d1));}
float wrap(float a){return atan(sin(a),cos(a));}
void main(){
 vec2 p=(gl_FragCoord.xy-center)/radius;float r=length(p),angle=atan(p.y,p.x);if(r>2.8){gl_FragColor=vec4(0.);return;}
 float t=time*.04;vec3 color=vec3(0.);float alpha=0.;
 if(r<=1.){
   vec3 n=vec3(p,sqrt(max(0.,1.-r*r)));float rot=t*.37;vec3 s=vec3(n.x*cos(rot)+n.z*sin(rot),n.y,-n.x*sin(rot)+n.z*cos(rot));
   float convection=fbm(s*(kind>1.5?5.8:9.)+vec3(t*.12,t*.07,0.));
   vec2 uv=vec2(atan(s.x,s.z),asin(s.y));float density=kind>1.5?16.:35.;
   vec2 grain=cells(uv*density+vec2(convection*2.,convection*1.3));
   float interstice=smoothstep(.015,.16,grain.y);float fine=noise(s*220.+t*.15);
   float heat=.24+.48*interstice+.25*convection+.05*fine;
   if(kind>.5&&kind<1.5)heat=.58+.20*interstice+.18*convection;
   float spot=0.;
   if(kind<.5){float a=length(s-normalize(vec3(-.30,.20,.94))),b=length(s-normalize(vec3(.36,-.24,.91)));spot=(1.-smoothstep(.025,.095,a))*.67+(1.-smoothstep(.018,.06,b))*.48;}
   float limb=.28+.72*pow(n.z,.48);float broad=kind>1.5?(.58+convection*.8):1.;
   vec3 hot=kind>.5&&kind<1.5?vec3(.93,.98,1.):mix(base,vec3(1.,.86,.49),kind>1.5?.17:.48);
   color=mix(base*.38,hot,pow(clamp(heat,0.,1.),1.05))*limb*broad*(1.-spot);
   color+=base*.06*pow(n.z,3.);alpha=1.;
 }else{
   float h=r-1.,filament=fbm(vec3(p*8.,t*.13));float rays=pow(.5+.5*sin(angle*57.+filament*8.+t*.15),3.);
   float brightness=exp(-h*36.)*.38+exp(-h*9.)*(.07+.09*rays)+exp(-h*3.)*.014;
   float loops=0.;
   for(int i=0;i<7;i++){float k=float(i),a=k*2.39996+.25*sin(k*5.)+t*.07;float halfWidth=.075+.018*sin(k*3.1);float u=wrap(angle-a)/halfWidth;
     if(abs(u)<1.){float life=.4+.6*pow(.5+.5*sin(time*.12+k*2.),2.);float curve=1.+(.10+.14*fract(k*.37))*pow(cos(u*PI*.5),.7)*life;float d=abs(r-curve);loops+=(exp(-d*radius*.6)*.16+exp(-d*radius*1.9)*.36)*life;}
   }
   brightness+=loops*(kind>.5&&kind<1.5?.36:1.);alpha=clamp(brightness,0.,.92);
   color=mix(base,vec3(1.,.83,.48),kind>.5&&kind<1.5?0.:.22);
 }
 alpha*=opacity;gl_FragColor=vec4(color*alpha,alpha);
}`;
  function createRenderer(canvas){
    let gl=null,program=null,buffer=null,shaders=[],uniforms={},available=false,destroyed=false;
    function release(){
      if(gl&&!gl.isContextLost()){if(buffer)gl.deleteBuffer(buffer);if(program)gl.deleteProgram(program);for(const shader of shaders)gl.deleteShader(shader);}
      buffer=null;program=null;shaders=[];available=false;
    }
    function compile(type,source){
      const shader=gl.createShader(type);shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error('Stellar shader compilation failed');return shader;
    }
    function initialize(){
      if(destroyed)return;release();
      try{
        gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true});if(!gl)return;
        program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);
        if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Stellar shader link failed');
        gl.useProgram(program);buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
        const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
        uniforms=Object.fromEntries(['center','radius','time','base','kind','opacity'].map(name=>[name,gl.getUniformLocation(program,name)]));
        gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);available=true;
      }catch{release();}
    }
    const lost=event=>{event.preventDefault();available=false;};
    const restored=()=>{program=null;buffer=null;shaders=[];initialize();};
    canvas.addEventListener?.('webglcontextlost',lost);canvas.addEventListener?.('webglcontextrestored',restored);initialize();
    return {
      get available(){return available&&!destroyed;},
      render({bodies,width,height,dpr=1,time=0}){
        if(!available||destroyed||gl.isContextLost()||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return false;
        dpr=Number.isFinite(dpr)?Math.max(1,Math.min(2,dpr)):1;
        try{
          const w=Math.max(1,Math.round(width*dpr)),h=Math.max(1,Math.round(height*dpr));
          if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;
          gl.viewport(0,0,w,h);gl.disable(gl.SCISSOR_TEST);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(program);gl.enable(gl.SCISSOR_TEST);
          gl.uniform1f(uniforms.time,Number.isFinite(time)?time:0);
          for(const body of bodies){
            const {x,y,radius}=body;if(![x,y,radius].every(Number.isFinite)||radius<=0)continue;
            const opacity=Math.min(1,(radius/.7)**2);if(opacity<1/255)continue;
            const edge=radius*2.8,left=Math.max(0,Math.floor((x-edge)*dpr)),right=Math.min(w,Math.ceil((x+edge)*dpr));
            const bottom=Math.max(0,Math.floor((height-y-edge)*dpr)),top=Math.min(h,Math.ceil((height-y+edge)*dpr));
            if(right<=left||top<=bottom)continue;
            gl.scissor(left,bottom,right-left,top-bottom);const appearance=profile(body.star?.id);
            gl.uniform2f(uniforms.center,x*dpr,(height-y)*dpr);gl.uniform1f(uniforms.radius,radius*dpr);gl.uniform1f(uniforms.opacity,opacity);
            gl.uniform3fv(uniforms.base,appearance.color);gl.uniform1f(uniforms.kind,appearance.kind);gl.drawArrays(gl.TRIANGLES,0,6);
          }
          gl.disable(gl.SCISSOR_TEST);return true;
        }catch{release();return false;}
      },
      destroy(){if(destroyed)return;destroyed=true;release();canvas.removeEventListener?.('webglcontextlost',lost);canvas.removeEventListener?.('webglcontextrestored',restored);}
    };
  }
  return {createRenderer,profile};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=OrbitalStellar;
