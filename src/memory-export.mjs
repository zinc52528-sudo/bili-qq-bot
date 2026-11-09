import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
const compress=promisify(gzip);
const dirs=['diary-v2','short-notebook','memory','memory-v2','semantic-cards','cross-turn','messages'];
const singles=['affinity.json'];
const MAX=128*1024*1024;
async function inventory(root){
 const files=[];let total=0;
 async function walk(rel){
  const full=path.join(root,rel);let st;try{st=await fs.lstat(full);}catch(e){if(e.code==='ENOENT')return;throw e;}
  if(st.isSymbolicLink())throw Error('记忆目录含符号链接，请先检查');
  if(st.isDirectory()){for(const name of (await fs.readdir(full)).sort()){if(['backups','backup'].includes(name))continue;await walk(path.join(rel,name));}}
  else if(st.isFile()&&/\.(json|jsonl|md|txt)$/i.test(rel)){total+=st.size;if(total>MAX||files.length>=10000)throw Error('记忆超过网页导出限制（128MB或10000个文件），请分批备份');files.push({path:rel.split(path.sep).join('/'),bytes:st.size});}
 }
 for(const n of [...dirs,...singles])await walk(n);
 return {files,bytes:total};
}
export async function memoryExportInfo(root){const i=await inventory(root);return {files:i.files.length,bytes:i.bytes,categories:dirs,format:'qq-agent-memory-v1',includes:'日记（含回收站）、长期记忆、人物资料、短期记事本、聊天原始存档、人设',excludes:'API密钥、登录Cookie、服务令牌、账号配置、日志和媒体文件'};}
export async function buildMemoryExport(root,config){
 const i=await inventory(root),files=[];let total=0;
 for(const f of i.files){const p=path.join(root,...f.path.split('/'));const st=await fs.lstat(p);if(!st.isFile()||st.isSymbolicLink())throw Error('文件在导出过程中发生变化，请重试');const b=await fs.readFile(p);total+=b.length;if(total>MAX)throw Error('导出超过128MB');files.push({path:f.path,encoding:'base64',bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex'),data:b.toString('base64')});}
 // Explicit allowlist: never copy arbitrary extension settings or provider configuration.
 const persona={};for(const k of ['persona','customPersonas','personaByChat','personaUnified'])if(config[k]!==undefined)persona[k]=config[k];
 const owner=config.skills?.['owner-identity'];if(owner){persona.ownerIdentity={};for(const k of ['ids','scope','personaEnabled','personaRoleText','personaCustomRules'])if(owner[k]!==undefined)persona.ownerIdentity[k]=owner[k];}
 const raw=Buffer.from(JSON.stringify({format:'qq-agent-memory-v1',createdAt:new Date().toISOString(),application:'QQ Agent',consistentSnapshot:false,notes:['只读逐文件快照；聊天持续写入时，不保证所有文件同一时刻。','保存真实记忆及聊天隐私，请妥善保管。','人设文本和聊天中曾手动粘贴的密钥属于正文，无法保证自动识别移除。','不含程序或插件源码、媒体、账号凭据；恢复前先核对目标版本及会话ID。','可在设置的记忆备份页预览并导入；恢复前自动备份。'],persona,files}));
 return compress(raw,{level:6});
}
