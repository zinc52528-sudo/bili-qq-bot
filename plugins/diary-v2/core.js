import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const DAY=86400000;
export const TIERS={normal:{label:'普通',days:7,add:3,warn:1,near:2},important:{label:'重要',days:21,add:7,warn:3,near:10},indelible:{label:'刻骨铭心',days:90,add:30,warn:7,near:30}};
export const day=t=>new Date(t+8*3600000).toISOString().slice(0,10);
const text=(s,max,required=false)=>{if(typeof s!=='string'||s.length>max||(required&&!s.trim()))throw Error(`文本不能为空且不得超过${max}字`);return s.trim();};
const title=s=>Array.from(s.split(/[。！？\n.!?]/)[0]).slice(0,16).join('');
export class Diary {
 constructor(dir,clock=Date.now,policy=()=>TIERS){this.dir=dir;this.clock=clock;this.policy=policy;}
 tiers(){return this.policy();}
 file(chat){if(!/^(group|private):\d+$/.test(chat))throw Error('非法会话');return path.join(this.dir,chat.replace(':','_')+'.json');}
 load(chat){const p=this.file(chat);if(!fs.existsSync(p))return {version:2,items:[],candidates:[],settledDay:'',digest:[],digestSession:null};const v=JSON.parse(fs.readFileSync(p,'utf8'));if(v.version!==2||!Array.isArray(v.items)||!Array.isArray(v.candidates))throw Error('日记数据损坏，停止读写，请管理员恢复备份');return v;}
 save(chat,v){const p=this.file(chat);fs.mkdirSync(this.dir,{recursive:true,mode:0o700});const tmp=p+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v,null,2),{mode:0o600});fs.renameSync(tmp,p);}
 remaining(e,now=this.clock()){return e.expiresAt-(e.shelf?.reason==='avoid'?e.shelf.since:now);}
 visible(e,now=this.clock()){const ratio=Math.max(0,this.remaining(e,now))/(e.allocatedDays*DAY);return {id:e.id,date:day(e.createdAt),tier:this.tiers()[e.tier].label,mood:e.mood||'',...(ratio>.5?{hint:title(e.body)}:ratio>=.2&&!e.mood?{hint:title(e.body)}:{}),remainingDays:Math.max(0,Math.ceil(this.remaining(e,now)/DAY)),shelf:e.shelf?.reason||null,expired:this.remaining(e,now)<=0};}
 suggest(e){const r=this.remaining(e)/DAY;if(e.tier==='normal'&&e.allocatedDays>13)return '可升档';if(e.tier==='important'&&e.allocatedDays>60)return '可升档';if(e.tier!=='normal'&&r<(e.tier==='important'?10:30))return '可降档';return '';}
 run(chat,op,a={},session=''){const now=this.clock(),v=this.load(chat);let out;
  if(op==='write'){
   if(v.items.filter(e=>!e.deletedAt).length>=2000)throw Error('本会话日记达到2000条上限');
   const body=text(a.body,4000,true),tier=a.tier||'normal';if(!this.tiers()[tier])throw Error('无效档位');
   const candidate=a.candidateId?v.candidates.find(c=>c.id===a.candidateId):null;if(a.candidateId&&!candidate)throw Error('画像候选不存在或不属于本会话');if(candidate?.writtenId)throw Error('此画像已写入日记');
   const existing=v.items.find(e=>!e.deletedAt&&e.body===body&&day(e.createdAt)===day(now));if(existing)return {duplicate:true,...this.visible(existing)};
   const e={id:'d'+crypto.randomBytes(8).toString('hex'),body,mood:text(a.mood||'',120),unsaid:text(a.unsaid||'',1000),tier,createdAt:now,tierStartedAt:now,expiresAt:now+this.tiers()[tier].days*DAY,allocatedDays:this.tiers()[tier].days,lastExtendedDay:'',lastTierDay:'',warnedAt:0,deletedAt:null,shelf:null,history:[],sourceCandidate:a.candidateId||null};v.items.push(e);if(candidate)candidate.writtenId=e.id;out=this.visible(e);
  }else if(op==='list'||op==='moods'){
   const days=op==='moods'?Number(a.days??7):null;if(op==='moods'&&(!Number.isInteger(days)||days<1||days>366))throw Error('天数须为1~366整数');
   const q=text(a.query||'',80).toLowerCase();const shelf=a.shelf===true;
   out=v.items.filter(e=>!e.deletedAt&&(shelf?!!e.shelf:!e.shelf)&&(op!=='moods'||e.createdAt>=now-days*DAY)&&(!q||`${e.body} ${e.mood}`.toLowerCase().includes(q))).sort((a,b)=>b.createdAt-a.createdAt).slice(0,Math.min(30,Math.max(1,Number(a.limit)||10))).map(e=>op==='moods'?{id:e.id,date:day(e.createdAt),mood:e.mood||'未记录心情'}:this.visible(e));
  }else{
   const e=v.items.find(e=>e.id===a.id&&!e.deletedAt);if(!e)throw Error('日记不存在、已划掉或不属于本会话');
   if(op==='expand')out={...this.visible(e),body:e.body,unsaid:e.unsaid};
   else if(op==='extend'){if(e.lastExtendedDay===day(now))throw Error('今天已经延长过');e.expiresAt+=this.tiers()[e.tier].add*DAY;e.allocatedDays+=this.tiers()[e.tier].add;e.lastExtendedDay=day(now);out=this.visible(e);}
   else if(op==='promote'||op==='demote'){
    if(e.lastTierDay===day(now))throw Error('今天已调整过档位');const ks=Object.keys(this.tiers()),idx=ks.indexOf(e.tier)+(op==='promote'?1:-1);if(idx<0||idx>=ks.length)throw Error('已经是边界档位');
    e.tier=ks[idx];e.tierStartedAt=now;e.expiresAt=now+this.tiers()[e.tier].days*DAY;e.allocatedDays=this.tiers()[e.tier].days;e.lastTierDay=day(now);if(e.shelf?.reason==='avoid')e.shelf.since=now;out=this.visible(e);
   }else if(op==='shelve'||op==='unshelve'){
    if(op==='shelve'&&!['avoid','uninterested'].includes(a.reason))throw Error('须选择avoid不敢看或uninterested没兴趣');
    if(e.shelf?.reason==='avoid')e.expiresAt+=now-e.shelf.since;
    e.shelf=op==='shelve'?{reason:a.reason,since:now}:null;out=this.visible(e);
   }else if(op==='blur'){
    const b=text(a.body,4000,true);if(b!==e.body){if(e.history.length>=100)throw Error('原文历史达到100版上限');e.history.push({body:e.body,at:now});e.body=b;}out=this.visible(e);
   }else if(op==='cross_out'){e.deletedAt=now;out={id:e.id,deleted:true,note:'已移入回收站，未永久删除'};}
   else if(op==='supplement'){if(a.mood===undefined&&a.unsaid===undefined)throw Error('至少提供一项');if(a.mood!==undefined)e.mood=text(a.mood,120);if(a.unsaid!==undefined)e.unsaid=text(a.unsaid,1000);out=this.visible(e);}
   else throw Error('未知操作');
  }
  if(!['list','moods','expand'].includes(op))this.save(chat,v);return out;
 }
 settle(chat){const now=this.clock(),v=this.load(chat);if(v.settledDay===day(now))return;const lines=[];
  for(const e of v.items){if(e.deletedAt||e.shelf?.reason==='avoid')continue;const t=this.tiers()[e.tier],r=this.remaining(e,now)/DAY,suggestion=this.suggest(e);if((r<=t.near||suggestion)&&(!e.warnedAt||now-e.warnedAt>=t.warn*DAY)){lines.push({id:e.id,date:day(e.createdAt),tier:t.label,remainingDays:Math.max(0,Math.ceil(r)),status:r<=0?'已到期，待决定':suggestion||'临期'});e.warnedAt=now;}}
  const merged=new Map((v.digestSession?[]:v.digest).map(x=>[x.id,x]));for(const x of lines)merged.set(x.id,x);v.digest=[...merged.values()].filter(x=>v.items.some(e=>e.id===x.id&&!e.deletedAt));v.digestSession=null;v.settledDay=day(now);this.save(chat,v);
 }
 digest(chat,session){if(!session)return [];const v=this.load(chat);if(v.digestSession&&v.digestSession!==session){v.digest=[];v.digestSession=null;this.save(chat,v);return [];}if(!v.digest.length)return [];if(!v.digestSession){v.digestSession=session;this.save(chat,v);}return v.digest.filter(x=>v.items.some(e=>e.id===x.id&&!e.deletedAt));}
 search(chat,query,limit=5){const v=this.load(chat),now=this.clock();const terms=[...new Set(String(query).toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/g)||[])].flatMap(w=>w.length>2&&/[\u4e00-\u9fff]/.test(w)?Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2)):[w]).slice(0,200);if(!terms.length)return [];
  return v.items.filter(e=>!e.deletedAt&&!e.shelf&&this.remaining(e,now)>0).map(e=>({e,score:terms.filter(t=>(e.body+' '+e.mood).toLowerCase().includes(t)).length})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>this.visible(x.e));
 }
 profiles(chat,records,threshold=3){const v=this.load(chat);const grams=s=>new Set(Array.from({length:Math.max(0,s.length-1)},(_,i)=>s.slice(i,i+2)));const sim=(a,b)=>{const x=grams(a),y=grams(b);return [...x].filter(t=>y.has(t)).length/Math.max(1,new Set([...x,...y]).size);};
  const groups=[];for(const r of records.slice(-1000)){if(!r.userId||!r.content||!Number.isFinite(r.createdAt)||r.createdAt<=0)continue;let g=groups.find(g=>g.userId===r.userId&&sim(g.content,r.content)>=.6);if(!g){g={...r,days:new Set()};groups.push(g);}g.days.add(day(r.createdAt));}
  for(const g of groups.filter(g=>g.days.size>=threshold)){const id='p'+crypto.createHash('sha256').update(g.userId+'\0'+g.content).digest('hex').slice(0,16);const existing=v.candidates.find(c=>c.id===id);if(existing)existing.days=g.days.size;else if(v.candidates.length<500)v.candidates.push({id,userId:g.userId,name:g.name||g.userId,hint:title(g.content),days:g.days.size});}
  this.save(chat,v);return v.candidates.filter(c=>!c.writtenId&&c.days>=threshold).slice(-5).map(({id,name,hint,days})=>({id,name,hint,days}));
 }
}
