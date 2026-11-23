import {useEffect} from 'react';

const blockers=new Set<symbol>();
export function beginUpdateBlock(){const id=Symbol();blockers.add(id);return()=>{blockers.delete(id);};}
export function useUpdateBlocker(blocked:boolean){
 useEffect(()=>{const id=Symbol();if(blocked)blockers.add(id);return()=>{blockers.delete(id);};},[blocked]);
}
export function updateIsSafe(requireVisible=true){
 if(blockers.size||(requireVisible&&document.visibilityState!=='visible'))return false;
 for(const el of document.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('textarea,input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])'))if(el.value.trim())return false;
 return true;
}
let started=false;
export function useSilentPWAUpdate(){
 useEffect(()=>{
  if(started||!('serviceWorker' in navigator)||!import.meta.env.PROD)return;started=true;
  let registration:ServiceWorkerRegistration|undefined,pendingReload=false,reloading=false,lastUpdate=0,lastActivity=Date.now(),waitingSince=0;
  const peers=new Map<string,{safe:boolean;at:number}>(),id=crypto.randomUUID();
  const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('rahala-safe-update'):null;
  const announce=()=>channel?.postMessage({id,safe:updateIsSafe(false),at:Date.now()});
  if(channel)channel.onmessage=e=>{const m=e.data;if(m&&typeof m.id==='string'&&typeof m.safe==='boolean'){peers.set(m.id,{safe:m.safe,at:Date.now()});if(m.ask)announce();}};
  const attempt=()=>{
   announce();if(!updateIsSafe()||Date.now()-lastActivity<2500)return;
   if(pendingReload){if(!reloading){reloading=true;location.reload();}return;}
   if(registration?.waiting){
    if(!waitingSince){waitingSince=Date.now();channel?.postMessage({id,safe:true,ask:true});return;}
    if(Date.now()-waitingSince<1500)return;
    if([...peers.values()].some(p=>Date.now()-p.at<45000&&!p.safe))return;
    registration.waiting.postMessage({type:'SKIP_WAITING'});
   }
  };
  const check=()=>{if(navigator.onLine&&registration&&Date.now()-lastUpdate>60000){lastUpdate=Date.now();void registration.update().catch(()=>{});}attempt();};
  const activity=()=>{lastActivity=Date.now();announce();};
  const changed=()=>{pendingReload=true;attempt();};
  navigator.serviceWorker.addEventListener('controllerchange',changed);
  void navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).then(r=>{registration=r;check();r.addEventListener('updatefound',()=>{const worker=r.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller){waitingSince=0;attempt();}});});}).catch(()=>{});
  const timer=window.setInterval(attempt,3000);
  window.addEventListener('focus',check);window.addEventListener('online',check);document.addEventListener('visibilitychange',check);document.addEventListener('input',activity);document.addEventListener('pointerdown',activity);document.addEventListener('keydown',activity);
  return()=>{clearInterval(timer);channel?.close();navigator.serviceWorker.removeEventListener('controllerchange',changed);window.removeEventListener('focus',check);window.removeEventListener('online',check);document.removeEventListener('visibilitychange',check);document.removeEventListener('input',activity);document.removeEventListener('pointerdown',activity);document.removeEventListener('keydown',activity);started=false;};
 },[]);
}
