import fs from 'node:fs';
import path from 'node:path';
import {DATA_DIR} from './lib/env.js';
import {Notebook} from './lib/notebook.js';
import {getConfig} from '../../src/config.js';
export function createNotebookExtension(api,settings){
 const notebook=new Notebook(path.join(DATA_DIR,'short-notebook'),{config:settings,sourceAllowed:(m,key)=>{
   if(m.self)return true;const c=getConfig(),id=String(m.senderId||'');
   return !(c.globalBlocklist||[]).map(String).includes(id)&&!(key?.startsWith('group:')&&(c.blocklist?.[key.split(':')[1]]||[]).map(String).includes(id));
 }});
 const seen=new Map();let timer=null;
 const on=()=>settings().enabled!==false&&settings().notebookEnabled!==false;
 const recent=ctx=>ctx.store?.recent?.(ctx.chatKey,{limit:80})||[];
 const run=fn=>async(ctx,args={})=>{try{if(!on())throw Error('短期记事本未启用');return {content:JSON.stringify(fn(ctx,args))};}catch(e){return {content:String(e.message),isError:true};}};
 const defs=[
  {id:'notebook_read',name:'读短期记事本',description:'查看当前会话近几天的笔记、待办和原话线索。只读当前会话；需要回忆最近进展时使用。',parameters:{type:'object',properties:{}},execute:run(ctx=>notebook.list(ctx.chatKey))},
  {id:'notebook_write',name:'补写短期记事本',description:'把当前会话已发生的关键进展、约定或待办整理为短笔记。必须引用有效原消息ID；推测需明确标注。不是写日记，也不会设置定时提醒。',parameters:{type:'object',properties:{text:{type:'string',description:'1～400字整理笔记'},kind:{type:'string',enum:['note','todo','decision'],description:'普通笔记、待办或决定'},sourceIds:{type:'array',items:{type:'integer'},description:'当前会话原消息本地ID数组，至少一个'}},required:['text','sourceIds']},execute:run((ctx,args)=>{
    const messages=recent(ctx);for(const id of args.sourceIds||[]){const m=ctx.store?.findByLocalId?.(ctx.chatKey,id);if(m&&!messages.some(x=>x.id===m.id))messages.push(m);}
    return notebook.add(ctx.chatKey,args,messages);
  })},
  {id:'notebook_done',name:'划掉已完成笔记',description:'当前会话待办已经完成、取消或不再有效时标记不再注入。原始聊天存档不删除。',parameters:{type:'object',properties:{id:{type:'string',description:'notebook_read返回的笔记ID'}},required:['id']},execute:run((ctx,args)=>notebook.done(ctx.chatKey,String(args.id||'')))},
  {id:'context_handoff',name:'上下文交接',description:'用户要求整理或清理当前上下文时，先保存本会话交接线索。reset=true表示后续运行不再自动带旧历史，原聊天存档保留；成功后用finish结束本轮。不要当成删除聊天记录。',parameters:{type:'object',properties:{reset:{type:'boolean',description:'是否将自动历史起点移动到当前最新消息；默认false只保存交接'}}},execute:run((ctx,args)=>{
    if(settings().allowContextHandoff===false)throw Error('上下文交接开关已关闭');
    const result=notebook.capture(ctx.chatKey,recent(ctx),{handoff:true,reset:args.reset===true});
    return {...result,message:args.reset===true?'交接已保存，下次运行从新历史起点继续；原存档保留。本轮请结束。':'交接已保存，未改变上下文范围'};
  })}
 ];
 for(const d of defs)api.registerTool({...d,category:'memory',icon:'📝'});
 function scan(){
  if(!on()||settings().notebookAutoCapture===false)return;
  const dir=path.join(DATA_DIR,'messages');if(!fs.existsSync(dir))return;
  let processed=0;
  for(const name of fs.readdirSync(dir)){
   const m=/^(group|private)_(\d+)\.json$/.exec(name);if(!m)continue;
   const file=path.join(dir,name),st=fs.statSync(file);
   if(st.mtimeMs===seen.get(name))continue;if(processed++>=10)break;
   if(st.size>20*1024*1024){seen.set(name,st.mtimeMs);api.warn('记事本跳过过大的聊天文件，请在会话运行时捕获');continue;}
   const data=JSON.parse(fs.readFileSync(file,'utf8'));
   notebook.capture(m[1]+':'+m[2],(data.messages||[]).slice(-80));seen.set(name,st.mtimeMs);
  }
  if(seen.size>1000)seen.clear();
 }
 return {
  activate(){this.deactivate();timer=setInterval(()=>{try{scan();}catch{api.warn('短期记事本后台捕获失败，原始存档未改动');}},60000);timer.unref?.();},
  deactivate(){if(timer)clearInterval(timer);timer=null;seen.clear();},
  capture(ctx){if(on()){
    const messages=recent(ctx);
    notebook.periodic(ctx.chatKey,messages);
    if(settings().notebookAutoCapture!==false)notebook.capture(ctx.chatKey,messages);
  }},
  render(ctx){return on()?notebook.render(ctx.chatKey):'';},
  boundary({chatKey}){return {afterId:on()?notebook.boundary(chatKey):0};},
  notebook
 };
}
