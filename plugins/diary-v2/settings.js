import {TIERS} from './core.js';
export const defaults={autoRecall:true,dailySettlement:true,profileLink:true,maxRecall:5,profileDays:3,defaultTier:'normal',normalDays:7,normalAdd:3,importantDays:21,importantAdd:7,indelibleDays:90,indelibleAdd:30,normalWarn:1,importantWarn:3,indelibleWarn:7};
export const schema={
 autoRecall:{type:'boolean',label:'聊天中浮现模糊回忆',description:'按本轮聊天关键词检索日记，只注入模糊线索；关闭后仍可主动调用日记工具。'},
 dailySettlement:{type:'boolean',label:'每日结算提示',description:'每日生成临期、到期及调档候选清单，下次聊天时展示，不主动唤醒AI或发送QQ。'},
 profileLink:{type:'boolean',label:'画像联动',description:'从当前会话的跨日相似成员印象生成候选，模型决定是否写入日记。'},
 maxRecall:{type:'number',label:'每轮最多回忆几条',description:'1~10条，默认5条；仅限制自动注入，不改变日记数量。',min:1,max:10,step:1},
 profileDays:{type:'number',label:'画像强化所需不同日期数',description:'2~30天，默认3天。提高后会按新阈值过滤已有候选。重复读取不算新的一天。',min:2,max:30,step:1},
 defaultTier:{type:'enum',values:['normal','important','indelible'],options:[{value:'normal',label:'普通'},{value:'important',label:'重要'},{value:'indelible',label:'刻骨铭心'}],label:'未指定时的日记档位',description:'normal=普通，important=重要，indelible=刻骨铭心。模型明确指定时优先使用其指定档位。'},
 ...Object.fromEntries(Object.entries(TIERS).flatMap(([k,t])=>[
  [k+'Days',{type:'number',label:t.label+'：初始寿命（天）',description:`1~3650天，默认${t.days}天。只影响新日记或之后调档，不重算已有日记到期日。`,min:1,max:3650,step:1}],
  [k+'Add',{type:'number',label:t.label+'：每次延长（天）',description:`1~365天，默认${t.add}天。下一次明确延长时使用，每条每天限一次。`,min:1,max:365,step:1}],
  [k+'Warn',{type:'number',label:t.label+'：结算提示间隔（天）',description:`1~365天，默认${t.warn}天。只限制同条日记重复提示，不自动续命。`,min:1,max:365,step:1}]
 ])),
 instructions:{type:'internal',label:'使用与保留规则',description:'展开不续命，只有明确延长才保留更久；不敢看冻结时间，没兴趣继续衰减；划掉只进回收站。寿命设置不追溯已有日记。日记与回收站的查看说明已放在本次交付的《日记2.0使用说明》中。'}
};
const integer=(v,f,min,max)=>Number.isInteger(Number(v))&&Number(v)>=min&&Number(v)<=max?Number(v):f;
export function normalize(raw={}){const c={...defaults,...raw};for(const k of ['autoRecall','dailySettlement','profileLink'])c[k]=raw[k]===undefined?defaults[k]:raw[k]===true;c.maxRecall=integer(c.maxRecall,5,1,10);c.profileDays=integer(c.profileDays,3,2,30);c.defaultTier=TIERS[c.defaultTier]?c.defaultTier:'normal';for(const k of Object.keys(TIERS)){c[k+'Days']=integer(c[k+'Days'],defaults[k+'Days'],1,3650);c[k+'Add']=integer(c[k+'Add'],defaults[k+'Add'],1,365);c[k+'Warn']=integer(c[k+'Warn'],defaults[k+'Warn'],1,365);}return c;}
export function policy(raw){const c=normalize(raw);return Object.fromEntries(Object.entries(TIERS).map(([k,t])=>[k,{...t,days:c[k+'Days'],add:c[k+'Add'],warn:c[k+'Warn']} ]));}
