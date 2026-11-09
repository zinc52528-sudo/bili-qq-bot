import fs from 'node:fs';
import path from 'node:path';
const DAY=86400000;
const labels={normal:'普通',important:'重要',indelible:'刻骨铭心'};
const date=t=>new Date(t+8*3600000).toISOString().slice(0,10);
function read(dir,chat){if(!/^(group|private):\d{1,15}$/.test(chat))throw Error('会话格式无效');const file=path.join(dir,chat.replace(':','_')+'.json');if(!fs.existsSync(file))return {items:[]};const v=JSON.parse(fs.readFileSync(file,'utf8'));if(v.version!==2||!Array.isArray(v.items))throw Error('日记文件损坏，未修改数据');return v;}
function remaining(e,now){return e.expiresAt-(e.shelf?.reason==='avoid'?e.shelf.since:now);}
function status(e,now){return e.deletedAt?'trash':e.shelf?'shelved':remaining(e,now)<=0?'expired':'active';}
function preview(e,now){const r=remaining(e,now),ratio=Math.max(0,r)/(e.allocatedDays*DAY);const hint=Array.from(String(e.body||'').split(/[。！？\n.!?]/)[0]).slice(0,16).join('');return {id:e.id,date:date(e.createdAt),tier:labels[e.tier]||e.tier,mood:String(e.mood||''),hint:ratio>.5||ratio>=.2&&!e.mood?hint:'',status:status(e,now),remainingDays:Math.max(0,Math.ceil(r/DAY)),reason:e.shelf?.reason||'',frozen:e.shelf?.reason==='avoid'};}
export function browseDiary(dir,{chat='',id='',filter='active',query='',page=1}={},now=Date.now()){
 if(!chat){const chats=[];if(fs.existsSync(dir))for(const name of fs.readdirSync(dir)){const m=/^(group|private)_(\d{1,15})\.json$/.exec(name);if(!m)continue;const key=m[1]+':'+m[2];try{const v=read(dir,key),counts={active:0,shelved:0,expired:0,trash:0};for(const e of v.items)counts[status(e,now)]++;chats.push({chat:key,counts,total:v.items.length});}catch{chats.push({chat:key,error:'文件无法读取，请检查备份',total:0});}}return {chats:chats.sort((a,b)=>a.chat.localeCompare(b.chat))};}
 const v=read(dir,chat);
 if(id){const e=v.items.find(x=>x.id===id);if(!e)throw Error('未找到这条日记');return {entry:{...preview(e,now),body:String(e.body||''),unsaid:String(e.unsaid||''),createdAt:e.createdAt,expiresAt:e.expiresAt,deletedAt:e.deletedAt||null,history:(Array.isArray(e.history)?e.history:[]).map(h=>({body:String(h.body||''),at:h.at}))}};}
 if(!['active','shelved','expired','trash','all'].includes(filter))throw Error('无效筛选');query=String(query).trim().slice(0,80).toLowerCase();page=Number(page);if(!Number.isInteger(page)||page<1||page>100000)throw Error('页码无效');
 const found=v.items.filter(e=>(filter==='all'||status(e,now)===filter)&&(!query||[e.body,e.mood,e.unsaid,e.id].some(t=>String(t||'').toLowerCase().includes(query)))).sort((a,b)=>b.createdAt-a.createdAt);return {chat,total:found.length,page,pageSize:20,items:found.slice((page-1)*20,page*20).map(e=>preview(e,now))};
}
