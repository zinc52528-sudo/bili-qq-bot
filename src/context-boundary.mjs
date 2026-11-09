// Filter automatic prompt history, never delete or alter the underlying ChatStore.
export function boundedStore(store,chatKey,afterId){
  if(!Number.isSafeInteger(afterId)||afterId<=0)return store;
  return new Proxy(store,{get(target,prop){
    if(prop==='recent')return (key,opts)=>target.recent(key,opts).filter(m=>key!==chatKey||Number(m.id)>afterId);
    const v=Reflect.get(target,prop,target);return typeof v==='function'?v.bind(target):v;
  }});
}
