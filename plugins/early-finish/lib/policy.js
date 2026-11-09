// Conservative local policy: only an entirely successful text-only batch may end.
const FOLLOWUP=/我(?:去|来)?(?:看看|查查|查一下|找找|问问|听听|翻翻)|等(?:一)?下|稍等|稍后|待会|回头|接下来|马上|正在|帮你|给你(?:设置|安排|记|查|找|发|画)|我(?:会|要|准备|打算|再|先)|提醒|闹钟|日记|记住|记下来|存下来|订阅|取消|删除|修改|上传|下载|发(?:张|个|一)?(?:图|表情|照片|链接)|画(?:一|张)|给你(?:看|听)|唱(?:一)?段|\b(?:I(?:'ll| will)|let me|one moment|remind|schedule|subscribe)\b/i;
const ACTION_REQUEST=/提醒|闹钟|日记|记住|记下来|记事本|订阅|取消|删除|修改|改头像|发动态|搜索|查一下|查查|帮我查|帮我找|发图|发个表情|发张|看看视频|\b(?:remind|schedule|subscribe|search|remember)\b/i;
export function decideBatchEnd({calls=[],results=[],newSent=[],entries=[]}={}){
 const no=reason=>({shouldEnd:false,reason});
 if(!Array.isArray(calls)||!calls.length||!Array.isArray(results)||!Array.isArray(newSent)||!Array.isArray(entries))return no('批次格式不完整');
 if(calls.some(c=>c?.function?.name!=='send_message'))return no('本批含查询或操作工具，保留正常循环');
 if(results.length!==calls.length||results.some(r=>!r||r.isError!==false||r.error||r.name!=='send_message'))return no('工具结果不完整或有失败，保留循环');
 const ids=calls.map(c=>c.id);if(ids.some(x=>typeof x!=='string'||!x)||new Set(ids).size!==ids.length||results.some(r=>!ids.includes(r.tool_call_id))||new Set(results.map(r=>r.tool_call_id)).size!==ids.length)return no('工具调用与结果未配对');
 if(newSent.length<calls.length||newSent.some(s=>!s||s.type!=='text'||typeof s.text!=='string'||!s.text.trim()))return no('没有完整确认纯文字发送');
 if(FOLLOWUP.test(newSent.map(s=>s.text).join('\n')))return no('可能仍有后续动作，保留循环');
 if(ACTION_REQUEST.test(entries.map(e=>String(e?.text||'')).join('\n')))return no('触发消息涉及操作或记忆任务，保留循环');
 return {shouldEnd:true,reason:'纯文字发送全部成功，无匹配的后续动作线索，提前收尾'};
}
