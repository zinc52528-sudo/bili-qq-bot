let consoleSessionPromise = null;
function ensureConsoleSession() {
  if (consoleSessionPromise) return consoleSessionPromise;
  consoleSessionPromise = new Promise((resolve,reject) => {
    const overlay = document.createElement('div');
    overlay.className='model-modal-overlay';
    overlay.style.zIndex='100000';
    overlay.innerHTML='<form class="model-modal" style="max-width:440px;padding:24px"><h3>登录 QQ Agent</h3><p>输入原有管理 Token。仅用于本次浏览器会话。</p><label for="console-session-token">管理 Token</label><input id="console-session-token" type="password" autocomplete="current-password" required style="width:100%;margin:12px 0"><p role="alert" id="console-session-error"></p><button class="btn btn-primary" type="submit">登录</button></form>';
    document.body.appendChild(overlay);
    const form=overlay.querySelector('form'),input=overlay.querySelector('input'),error=overlay.querySelector('[role=alert]'),button=overlay.querySelector('button');
    form.addEventListener('submit',async event=>{
      event.preventDefault(); button.disabled=true; error.textContent='';
      try {
        const res=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:input.value})});
        if(!res.ok)throw new Error('Token 不正确，请重试');
        input.value='';overlay.remove();resolve();
      }catch(e){error.textContent=e.message;button.disabled=false;}
    });
    setTimeout(()=>input.focus(),0);
  }).finally(()=>{consoleSessionPromise=null;});
  return consoleSessionPromise;
}
