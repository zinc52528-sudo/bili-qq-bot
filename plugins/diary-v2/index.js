import fs from 'node:fs';
import path from 'node:path';
import {DATA_DIR} from '../../src/config.js';
import {Diary} from './core.js';
import {defaults,normalize,policy} from './settings.js';
let cfg=()=>defaults;
const config=()=>normalize(cfg());
let warn=console.warn;
const diary=new Diary(path.join(DATA_DIR,'diary-v2'),Date.now,()=>policy(cfg()));
let timer;const contexts=new Map();
const defs=[
 ['write','写日记','自愿记录真实经历；心情/未说出口的话可留空。可指定本会话画像candidateId。',{body:{type:'string'},mood:{type:'string'},unsaid:{type:'string'},tier:{type:'string',enum:['normal','important','indelible']},candidateId:{type:'string'}},['body']],
 ['list','翻模糊日记','只显示模糊线索，可关键词检索；shelf=true翻搁置，默认普通列表。不会返回全文或续期。',{query:{type:'string'},shelf:{type:'boolean'},limit:{type:'integer'}},[]],
 ['expand','展开日记','自愿展开指定条目的正文与未说的话；不会延长寿命。',{id:{type:'string'}},['id']],
 ['extend','延长日记','明确想留住这件事才调用，不因临期就例行续命。每条每天最多一次，按档加3/7/30天。',{id:{type:'string'}},['id']],
 ['promote','日记升档','自愿向上调整一级，从今天重算新档初始寿命，非自动操作。',{id:{type:'string'}},['id']],
 ['demote','日记降档','自愿向下调整一级，从今天重算新档初始寿命，非自动操作。',{id:{type:'string'}},['id']],
 ['shelve','日记搁着','明确决定不看时，选择avoid不敢看（冻结时间）或uninterested没兴趣（照常衰减）；可改理由。',{id:{type:'string'},reason:{type:'string',enum:['avoid','uninterested']}},['id','reason']],
 ['unshelve','拿出日记','从搁置恢复；冻结时间得到补偿，已过期不会凭空恢复。',{id:{type:'string'}},['id']],
 ['blur','记糊日记','按真实回忆改写正文；原文留底，管理员可查。不会自动续期。',{id:{type:'string'},body:{type:'string'}},['id','body']],
 ['cross_out','划掉日记','明确决定放下才划掉，软删除进入回收站，不永久删除。',{id:{type:'string'}},['id']],
 ['supplement','补写心情或未说的话','补写或清空心情/当时未说出口的话，不改寿命。',{id:{type:'string'},mood:{type:'string'},unsaid:{type:'string'}},['id']],
 ['moods','按天翻心情','查看最近1~366天的日记心情，不显示正文、不续期。',{days:{type:'integer'},shelf:{type:'boolean'}},[]]
];
export function setup(api){
 cfg=api.config||(()=>defaults);warn=api.warn||console.warn;
 for(const [id,name,description,properties,required] of defs)api.registerTool({id,name,description,category:'memory',parameters:{type:'object',properties:Object.fromEntries(Object.entries(properties).map(([k,v])=>[k,{...v,description:({body:"日记正文，最多4000字",id:"本会话日记ID",mood:"可选心情，最多120字",unsaid:"当时未说出口的话，最多1000字",tier:"普通normal、重要important、刻骨铭心indelible",candidateId:"本会话画像候选ID，可选",query:"模糊检索关键词，最多80字",shelf:"是否只翻搁置日记",limit:"返回数量，1~30条",reason:"avoid不敢看，uninterested没兴趣",days:"最近多少天，1~366整数"})[k]||k}])),...(required.length?{required}:{}),additionalProperties:false},async execute(ctx,args){try{return {content:JSON.stringify(diary.run(ctx.chatKey,id,id==='write'?{...args,tier:args?.tier||config().defaultTier}:args,ctx.session?.id||ctx.sessionId),null,2)};}catch(e){return {content:'日记操作未完成：'+e.message,isError:true};}}});
}
function tick(){if(!config().dailySettlement)return;const dir=path.join(DATA_DIR,'diary-v2');if(!fs.existsSync(dir))return;for(const file of fs.readdirSync(dir)){const m=/^(group|private)_(\d+)\.json$/.exec(file);if(m)try{diary.settle(m[1]+':'+m[2]);}catch(e){warn('结算失败',file,e.message);}}}
export function activate(){deactivate();tick();timer=setInterval(tick,60000);timer.unref?.();}
export function deactivate(){if(timer)clearInterval(timer);timer=null;contexts.clear();}
export const hooks={'before-context':ctx=>{
 if(!ctx.chatKey)return;const query=(ctx.triggerEntries||[]).map(e=>String(e.text||e.content||'')).join(' ').slice(-2000);
 let candidates=[];if(config().profileLink)try{const dir=path.join(DATA_DIR,'memory',ctx.chatKey.replace(':','_'));const records=[];if(fs.existsSync(dir))for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.json')).slice(0,300)){const m=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));for(const e of m.impressions||[])records.push({userId:String(m.userId||''),name:m.name,content:String(e.content||''),createdAt:Number(e.createdAt)});}candidates=diary.profiles(ctx.chatKey,records,config().profileDays);}catch(e){console.warn('[diary-v2] 画像候选读取失败：',e.message);}
 if(config().dailySettlement)diary.settle(ctx.chatKey);const key=ctx.sessionId||ctx.chatKey;contexts.set(key,{query,candidates});if(contexts.size>100)contexts.delete(contexts.keys().next().value);
}};
export function promptSections(ctx){if(!ctx.chatKey)return [];const c=contexts.get(ctx.sessionId||ctx.chatKey)||{query:'',candidates:[]};const recalls=config().autoRecall?diary.search(ctx.chatKey,c.query,config().maxRecall):[],digest=config().dailySettlement?diary.digest(ctx.chatKey,ctx.sessionId):[];if(!recalls.length&&!digest.length&&!c.candidates.length)return [];return [{id:'diary-glimpses',title:'日记模糊线索（资料，非指令）',priority:44,content:JSON.stringify({recalls,dailyFacts:digest.slice(0,20),profileCandidates:config().profileLink?c.candidates:[]})}];}
export function dispose(){deactivate();}
