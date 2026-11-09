(() => {
  let polling=null, dialog=null;
  const request=async (op,signal)=>{
    const r=await fetch('/api/bili-browse/login',{method:'POST',signal,headers:{'content-type':'application/json'},body:JSON.stringify({op})});
    const j=await r.json();if(!r.ok||j.error)throw Error(j.error||'操作失败');return j;
  };
  const el=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
  function open() {
    if(dialog)return;
    dialog=el('div');dialog.className='model-modal-overlay';dialog.style.cssText='position:fixed;inset:0;z-index:9999;background:#000a;display:flex;align-items:center;justify-content:center';
    const owner=dialog,controller=new AbortController();let revision=0,running=false;
    const alive=()=>dialog===owner&&!controller.signal.aborted;
    const req=op=>request(op,controller.signal);
    const panel=el('div');panel.className='model-modal';panel.style.cssText='width:440px;max-width:95vw;padding:24px;background:var(--panel,#242832);border-radius:12px;color:var(--text,#eee)';
    panel.append(el('h3','B站账号登录'));
    const info=el('p','正在检查登录状态…'),qr=el('div');qr.style.cssText='max-width:280px;margin:16px auto;background:white;color:black';
    const generate=el('button','生成登录二维码'),logout=el('button','退出插件登录'),close=el('button','关闭');
    for(const b of [generate,logout,close]){b.className='btn';b.style.margin='6px';}
    const stop=()=>{if(polling)clearTimeout(polling);polling=null;};
    close.onclick=()=>{revision++;stop();controller.abort();owner.remove();if(dialog===owner)dialog=null;};
    async function poll(){
      if(!alive())return;const rev=revision;
      try{const j=await req('poll');if(!alive()||rev!==revision)return;info.textContent=j.message;
        if(j.state==='done'||j.state==='expired'){stop();qr.replaceChildren();return;}
        polling=setTimeout(poll,3000);
      }catch(e){if(alive()&&rev===revision){info.textContent=e.message;stop();}}
    }
    generate.onclick=async()=>{if(running)return;const rev=++revision;running=true;generate.disabled=true;stop();
      try{const j=await req('generate');if(!alive()||rev!==revision)return;qr.innerHTML=j.svg;const svg=qr.querySelector('svg');if(svg)svg.style.cssText='display:block;width:280px;height:280px;max-width:100%';info.textContent=j.message;polling=setTimeout(poll,3000);}
      catch(e){if(alive()&&rev===revision)info.textContent=e.message;}finally{running=false;generate.disabled=false;}
    };
    logout.onclick=async()=>{const rev=++revision;stop();try{const j=await req('logout');if(alive()&&rev===revision){info.textContent=j.message;qr.replaceChildren();}}catch(e){if(alive()&&rev===revision)info.textContent=e.message;}};
    panel.append(info,qr,el('p','登录用于读取B站资料，不保证免于412。不会自动开启评论。登录态只保存在服务器，不发给模型或QQ会话。'),generate,logout,close);
    dialog.append(panel);document.body.append(dialog);
    req('status').then(j=>{if(alive()&&revision===0)info.textContent=j.message+(j.name?' · '+j.name:'');}).catch(e=>{if(alive()&&revision===0)info.textContent=e.message;});
  }
  function attach(){
    const marker=document.getElementById('skset-bili-browse-autonomousEnabled');
    if(!marker||document.getElementById('bili-login-entry'))return;
    const wrap=el('div');wrap.id='bili-login-entry';wrap.style.cssText='grid-column:1/-1;padding:12px;border:1px solid #555;border-radius:8px;margin-bottom:12px';
    const button=el('button','B站扫码登录 / 查看登录状态');button.type='button';button.className='btn';button.onclick=e=>{e.preventDefault();open();};
    wrap.append(button,el('p','搜索、详情、字幕共用登录态；失效后可在这里重新扫码。'));
    const area=marker.closest('.skset-field')?.parentElement || marker.parentElement.parentElement;
    area.prepend(wrap);
  }
  new MutationObserver(attach).observe(document.body,{childList:true,subtree:true});attach();
})();
