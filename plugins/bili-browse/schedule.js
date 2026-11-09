const WINDOWS='09:00-12:00,14:00-18:00';
const HOLIDAYS_2026=[['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']];
export function resolveSchedule(c, now=Date.now()) {
  const d=new Date(now+8*3600000),date=d.toISOString().slice(0,10),md=date.slice(5),day=d.getUTCDay(),minute=d.getUTCHours()*60+d.getUTCMinutes();
  const extra=String(c.offPeakDates||'').split(/[,，\s]+/).filter(Boolean);
  const holiday=extra.includes(date)||(date.startsWith('2026-')&&HOLIDAYS_2026.some(([a,b])=>md>=a&&md<=b));
  const ranges=String(c.peakWindows??WINDOWS).split(/[,，]+/).map(s=>s.trim()).filter(Boolean);
  const parsed=ranges.map(s=>{
    const m=/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(s);if(!m)return null;
    const [h1,m1,h2,m2]=m.slice(1).map(Number);const a=h1*60+m1,b=h2*60+m2;
    return h1<24&&h2<=24&&m1<60&&m2<60&&b<=1440&&a<b?[a,b]:null;
  });
  if(!ranges.length||parsed.some(x=>!x))return {scheduleBand:'invalid',scheduleAllowed:false};
  const peak=day!==0&&day!==6&&!holiday&&parsed.some(([a,b])=>minute>=a&&minute<b);
  const number=(k,def,min,max)=>{const v=Number(c[k]);return Math.max(min,Math.min(max,Number.isFinite(v)?v:def));};
  const band=peak?'peak':'offPeak';
  return { scheduleBand:band,scheduleAllowed:peak?c.peakBrowseEnabled===true:c.offPeakBrowseEnabled!==false,
    checkIntervalMin:peak?number('peakIntervalMin',240,30,1440):number('offPeakIntervalMin',90,30,1440),
    bandDailyRounds:peak?number('peakDailyRounds',1,0,12):number('offPeakDailyRounds',6,0,12),
    calendarKnown:date.startsWith('2026-'),holiday };
}
