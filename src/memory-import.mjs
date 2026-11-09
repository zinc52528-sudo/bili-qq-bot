import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const roots=new Set(['diary-v2','short-notebook','memory','memory-v2','semantic-cards','cross-turn','messages']);
const bad=new Set(['__proto__','prototype','constructor']);
function safeObject(x,depth=0){if(depth>80)throw Error('数据嵌套过深');if(x&&typeof x==='object')for(const [k,v] of Object.entries(x)){if(bad.has(k))throw Error('备份含不安全字段');safeObject(v,depth+1);}}
function validPath(p){if(typeof p!=='string'||p.includes('\\')||p.startsWith('/')||p.includes('\0'))return false;const a=p.split('/');return a.every(s=>s&&s!=='.'&&s!=='..'&&!s.includes(':')&&!['backups','backup'].includes(s))&&((a.length>1&&roots.has(a[0])&&/\.(json|jsonl|md|txt)$/.test(p))||p==='affinity.json');}
export function parseMemoryImport(encoded){
 if(typeof encoded!=='string'||encoded.length>28*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw Error('请选择不超过20MB的备份文件');
 let d;try{d=JSON.parse(gunzipSync(Buffer.from(encoded,'base64'),{maxOutputLength:190*1024*1024}).toString('utf8'));}catch{throw Error('文件不是有效的记忆备份或解压后过大');}
 safeObject(d);if(d.format!=='qq-agent-memory-v1'||!Array.isArray(d.files)||d.files.length>10000)throw Error('不支持的备份格式');
 const seen=new Set();let bytes=0;const files=[];
 for(const f of d.files){if(!validPath(f.path)||seen.has(f.path)||f.encoding!=='base64'||typeof f.data!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(f.data))throw Error('备份文件路径或编码无效');seen.add(f.path);const b=Buffer.from(f.data,'base64');bytes+=b.length;if(bytes>128*1024*1024||b.length!==f.bytes||crypto.createHash('sha256').update(b).digest('hex')!==f.sha256)throw Error('备份大小或校验不一致');if(f.path.endsWith('.json')){let v;try{v=JSON.parse(b.toString('utf8'));}catch{throw Error('备份包含损坏的JSON文件');}safeObject(v);if(f.path.startsWith('messages/')&&(!Array.isArray(v.messages)||typeof v.chatKey!=='string'||f.path!==`messages/${v.chatKey.replace(':','_')}.json`))throw Error('聊天存档格式无效');}files.push({path:f.path,bytes:b});}
 const persona={};for(const k of ['persona','customPersonas','personaByChat','personaUnified'])if(d.persona?.[k]!==undefined)persona[k]=d.persona[k];
 if(d.persona?.ownerIdentity&&typeof d.persona.ownerIdentity==='object'){persona.ownerIdentity={};for(const k of ['ids','scope','personaEnabled','personaRoleText','personaCustomRules'])if(d.persona.ownerIdentity[k]!==undefined)persona.ownerIdentity[k]=d.persona.ownerIdentity[k];}
 if(!files.length&&!Object.keys(persona).length)throw Error('备份没有可恢复的数据');
 return {files,persona,createdAt:String(d.createdAt||''),bytes};
}
async function target(root,rel){const full=path.resolve(root,rel);if(!full.startsWith(path.resolve(root)+path.sep))throw Error('路径越界');let cur=root;for(const name of rel.split('/')){cur=path.join(cur,name);try{const s=await fs.lstat(cur);if(s.isSymbolicLink())throw Error('目标存在符号链接，不能恢复');}catch(e){if(e.code!=='ENOENT')throw e;}}return full;}
async function atomic(file,bytes){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.restore-'+crypto.randomBytes(8).toString('hex');try{await fs.writeFile(tmp,bytes,{mode:0o600});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true}).catch(()=>{});}}
export async function applyMemoryImport(root,parsed,{includePersona=true,now=Date.now()}={}){
 const backup=path.join(root,'memory-import-backups',String(now)+'-'+crypto.randomBytes(4).toString('hex'));await fs.mkdir(backup,{recursive:true,mode:0o700});
 const changes=parsed.files.map(f=>({path:f.path,bytes:f.bytes}));
 if(includePersona&&Object.keys(parsed.persona).length){const cfg=JSON.parse(await fs.readFile(path.join(root,'config.json'),'utf8'));for(const k of ['persona','customPersonas','personaByChat','personaUnified'])if(parsed.persona[k]!==undefined)cfg[k]=parsed.persona[k];if(parsed.persona.ownerIdentity){cfg.skills??={};cfg.skills['owner-identity']={...cfg.skills['owner-identity'],...parsed.persona.ownerIdentity};}changes.push({path:'config.json',bytes:Buffer.from(JSON.stringify(cfg,null,2))});}
 const saved=[];
 // Finish backup of every destination before changing any destination.
 for(const f of changes){const dest=await target(root,f.path);let old=null;try{old=await fs.readFile(dest);}catch(e){if(e.code!=='ENOENT')throw e;}if(old!==null)await atomic(path.join(backup,f.path),old);saved.push({path:f.path,existed:old!==null,dest});}
 await atomic(path.join(backup,'restore-manifest.json'),Buffer.from(JSON.stringify({createdAt:new Date(now).toISOString(),files:saved.map(({path,existed})=>({path,existed}))})));
 try{for(let i=0;i<changes.length;i++)await atomic(saved[i].dest,changes[i].bytes);}
 catch(e){let failed=false;for(const f of saved)try{if(f.existed)await atomic(f.dest,await fs.readFile(path.join(backup,f.path)));else await fs.rm(f.dest,{force:true});}catch{failed=true;}throw Error(failed?'恢复失败且自动回退不完整，请保留备份并停止使用':'恢复失败，已回退原数据');}
 return {backup,files:parsed.files.length,personaRestored:includePersona&&Object.keys(parsed.persona).length>0};
}
