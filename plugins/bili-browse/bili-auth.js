import qrcode from './qrcode.cjs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const ALLOWED = new Set(['SESSDATA','bili_jct','DedeUserID','DedeUserID__ckMd5','buvid3','buvid4']);
export function parseCookies(lines, url = '') {
  const out = {};
  for (const line of lines || []) {
    const match = /^\s*([^=;\s]+)=([^;]*)/.exec(line);
    if (match && ALLOWED.has(match[1]) && !/[\r\n]/.test(match[2])) out[match[1]] = match[2];
  }
  if (url) { const u = new URL(url); for (const [k,v] of u.searchParams) if (ALLOWED.has(k) && !out[k] && !/[;\r\n]/.test(v)) out[k]=v; }
  return out;
}
export function createBiliAuth({ fetcher, config, storage, now = Date.now }) {
  let pending = null, active = false, serial = 0;
  let cached = null, lastStatus = 0;
  const credentials = () => {
    const saved = storage()?.get('bili-login-v1') || {};
    if (saved.cookies?.SESSDATA) return saved.cookies;
    if (saved.manualDisabled) return {};
    const c = config();
    return { SESSDATA: c.sessdata || '', bili_jct: c.biliJct || '' };
  };
  const authenticatedFetch = async (url, options = {}) => {
    const u = new URL(url), headers = new Headers(options.headers || {});
    if (u.protocol === 'https:' && (u.hostname === 'api.bilibili.com' || u.hostname === 'passport.bilibili.com')) {
      const cookies = {};
      for (const piece of (headers.get('cookie') || '').split(';')) {const i=piece.indexOf('=');if(i>0){const k=piece.slice(0,i).trim();if(!ALLOWED.has(k)||k==='buvid3'||k==='buvid4')cookies[k]=piece.slice(i+1).trim();}}
      for (const [k,v] of Object.entries(credentials())) if (v) cookies[k]=v;
      const text = Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; ');
      if (text) headers.set('cookie',text);
      headers.set('referer','https://www.bilibili.com/');headers.set('user-agent',UA);
    } else headers.delete('cookie');
    // Never follow redirects carrying credentials to another origin.
    return fetcher(url,{...options,headers,redirect:['api.bilibili.com','passport.bilibili.com'].includes(u.hostname)?'error':options.redirect,signal:options.signal || AbortSignal.timeout(15000)});
  };
  async function json(url, auth = false) {
    const r = await (auth ? authenticatedFetch : fetcher)(url,{headers:{'user-agent':UA,referer:'https://www.bilibili.com/'},redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!r.ok) throw new Error(`B站 HTTP ${r.status}`);
    const j=await r.json(); if(j.code!==0 && !(auth && j.code===-101))throw new Error(`B站接口错误 ${j.code}`);
    return {r,j};
  }
  async function status(force=false) {
    if (!credentials().SESSDATA) return {loggedIn:false,message:'未登录'};
    if (!force && cached && now()-lastStatus<60000) return cached;
    const {j}=await json('https://api.bilibili.com/x/web-interface/nav',true);
    cached={loggedIn:!!j.data?.isLogin,name:String(j.data?.uname||''),message:j.data?.isLogin?'已登录':'登录态已失效，请重新扫码'};lastStatus=now();return cached;
  }
  async function action(op) {
    if(!active) throw new Error('插件未启用');
    if(op==='status') {try{return await status();}catch{return {loggedIn:null,configured:!!credentials().SESSDATA,message:'暂时无法校验登录状态，可能是网络或B站风控'};}}
    if(op==='logout') {serial++;pending=null;cached=null;storage()?.set('bili-login-v1',{manualDisabled:true});return {loggedIn:false,message:'已移除插件保存的登录态；手填登录态也暂停使用'};}
    if(op==='generate') {
      const g=++serial;
      const {j}=await json('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
      if(!active||g!==serial)throw new Error('操作已取消');
      const u=new URL(j.data.url);if(u.protocol!=='https:'||!['passport.bilibili.com','account.bilibili.com'].includes(u.hostname))throw new Error('二维码登录地址不合法');
      pending={key:j.data.qrcode_key,expires:now()+180000,lastPoll:0};
      const qr=qrcode(0,'M');qr.addData(u.href);qr.make();
      return {state:'waiting',svg:qr.createSvgTag({cellSize:5,margin:4,scalable:true}),expiresAt:pending.expires,message:'请用B站App扫码并确认登录（约3分钟有效）'};
    }
    if(op==='poll') {
      const p=pending,g=serial;
      if(!p||p.expires<now()) {pending=null;return {state:'expired',message:'二维码已过期，请重新生成'};}
      if(now()-p.lastPoll<2500)return {state:'waiting',message:'等待扫码确认'};
      p.lastPoll=now();
      const {r,j}=await json('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key='+encodeURIComponent(p.key));
      if(!active||g!==serial||pending!==p)throw new Error('操作已取消');
      const code=j.data?.code;
      if(code===86101)return {state:'waiting',message:'等待扫码'};
      if(code===86090)return {state:'scanned',message:'已扫码，请在手机上确认'};
      if(code===86038){pending=null;return {state:'expired',message:'二维码已过期'};}
      if(code!==0)throw new Error('扫码状态异常 '+code);
      const cookies=parseCookies(r.headers.getSetCookie?.()||[],j.data.url||'');
      if(!cookies.SESSDATA||!cookies.bili_jct)throw new Error('扫码成功但登录凭据不完整，请重试');
      storage()?.set('bili-login-v1',{cookies,savedAt:now()});pending=null;cached=null;
      return {state:'done',loggedIn:true,message:'登录成功，登录态已保存；不会自动开启发评论'};
    }
    throw new Error('未知操作');
  }
  // Internal only: never exposed by the management capability or model tools.
  const commentCredentials=()=>{
    if(!active)return null;
    const c=credentials();
    return c.SESSDATA&&c.bili_jct?{sessdata:c.SESSDATA,biliJct:c.bili_jct}:null;
  };
  return {action,fetch:authenticatedFetch,commentCredentials,hasLogin:()=>!!credentials().SESSDATA,activate:()=>{active=true},deactivate:()=>{active=false;serial++;pending=null}};
}
