/* ============================================================
   CCTV 근무표 자동배정 — 배정 엔진 / 통계 / 검증 (DOM 비의존)
   index.html에서 <script src="engine.js">로 로드되며,
   Node에서도 require()로 불러와 테스트할 수 있습니다.
   ============================================================ */
"use strict";

/* ---------- 시간 구조 상수 ---------- */
const DAY_SLOTS = ['06:30','07:30','08:30','09:30','10:30','11:30','12:30','13:30','14:30','15:30','16:30'];
const EVENING   = ['17:30','18:30','19:30','20:30','21:30'];
const NIGHT_BUNCHO = [
  {id:1, slots:['22:30','02:30']},
  {id:2, slots:['23:30','03:30']},
  {id:3, slots:['00:30','04:30']},
  {id:4, slots:['01:30','05:30']},
];
// 06:30 기준 24슬롯 시계순 (인접 판정용)
const SLOT_ORDER = ['06:30','07:30','08:30','09:30','10:30','11:30','12:30','13:30','14:30','15:30','16:30',
  '17:30','18:30','19:30','20:30','21:30','22:30','23:30','00:30','01:30','02:30','03:30','04:30','05:30'];
const MORNING_AFTER_NIGHT = ['06:30','07:30','08:30']; // 전날 야간자 다음날 열외
const STORE_KEY = 'cctv_roster_v2';

/* ---------- 기본 설정/가중치 ---------- */
const DEFAULT_WEIGHTS = {
  // 신병은 하루 개수(2칸)만 우선 보장하고, '어느 시간대'인지는 시간대 공정성(slotFairKey + slotRate)으로
  // 분산시킨다 → 신병이 이른 칸(아침·09:30)만 도맡지 않도록. 특정 시간대·번초 반복은 강하게 막는다.
  avgHours:0.8, todayHours:1.6, groupRate:1.8, slotRate:7.0,
  nightRate:1.8, bunchoRate:3.0, mealRate:2.2, patrolRate:2.2,
  recruitBias:-0.3, jitter:0.04
};
const WEIGHT_LABELS = {
  avgHours:'누적평균시간', todayHours:'당일 이미받은시간', groupRate:'그룹 배정률',
  slotRate:'슬롯 배정률(그룹별)', nightRate:'야간 배정률', bunchoRate:'번초 배정률',
  mealRate:'밥교대 배정률', patrolRate:'순찰 배정률', recruitBias:'신병 보정', jitter:'미세 난수'
};
const DEFAULT_SETTINGS = {patrolBonus:0.5, enable1430OnHoliday:false, weights:{...DEFAULT_WEIGHTS}};

/* ---------- 상태 ---------- */
let DB = {version:2, lastBackupAt:null, workers:[], schedules:{}, prebook:[], holidays:{}, settings:JSON.parse(JSON.stringify(DEFAULT_SETTINGS))};


function migrate(obj){
  const out = {version:2, lastBackupAt:null, workers:[], schedules:{}, prebook:[], holidays:{}, settings:JSON.parse(JSON.stringify(DEFAULT_SETTINGS))};
  if(!obj || typeof obj!=='object') return out;
  out.prebook = (Array.isArray(obj.prebook)?obj.prebook:[]).map(normPrebook).filter(Boolean);
  if(obj.holidays && typeof obj.holidays==='object' && !Array.isArray(obj.holidays)){
    Object.keys(obj.holidays).forEach(k=>{ if(/^\d{4}-\d{2}-\d{2}$/.test(k)) out.holidays[k]=String(obj.holidays[k]||'휴무'); });
  }
  out.lastBackupAt = obj.lastBackupAt || null;
  // settings
  if(obj.settings){
    out.settings = Object.assign({}, DEFAULT_SETTINGS, obj.settings);
    out.settings.weights = Object.assign({}, DEFAULT_WEIGHTS, obj.settings.weights||{});
  }
  // workers — 구버전 필드 보정
  const ws = obj.workers || obj.people || [];
  out.workers = ws.map((w,i)=>normWorker(w,i));
  // schedules — 구버전이 배열일 수도
  const sc = obj.schedules || {};
  if(Array.isArray(sc)){ sc.forEach(s=>{ if(s&&s.date) out.schedules[s.date]=normSched(s); }); }
  else { Object.keys(sc).forEach(k=>{ out.schedules[k]=normSched(sc[k]); }); }
  return out;
}
function normWorker(w,i){
  return {
    id: w.id || ('w'+Date.now().toString(36)+i+Math.random().toString(36).slice(2,6)),
    name: w.name || ('근무자'+(i+1)),
    roleReady: w.roleReady!==undefined ? !!w.roleReady : !!(w.roleType && w.roleType!=='recruit'),
    roleType: (w.roleType==='duty'||w.roleType==='situation') ? w.roleType : 'duty',
    // 운항병: 상황병 근무 가능(roleReady/roleType='situation') + 고정 스케줄. 활성 1명만.
    // 말년: 메커니즘상 신병과 동일 취급(roleReady=false)이되 카운트 초기화는 하지 않음.
    isNavigator: !!w.isNavigator,
    isVeteran: !!w.isVeteran,
    canMeal: w.canMeal!==undefined ? !!w.canMeal : true,
    baseHours: Number(w.baseHours)||0,
    active: w.active!==undefined ? !!w.active : true,
    countResetAt: w.countResetAt || null,
    createdAt: w.createdAt || null,
    inactivePeriods: Array.isArray(w.inactivePeriods)? w.inactivePeriods.filter(p=>p&&p.start) : []
  };
}
const PREBOOK_KINDS=['vacation','exday','exboth','duty','situation'];
const PREBOOK_KR={vacation:'휴가', exday:'주간 열외', exboth:'모두 열외', duty:'당직 예약', situation:'상황병 예약'};
function normPrebook(p){
  if(!p || !p.wid || !p.start) return null;
  return {
    id: p.id || ('pb'+Date.now().toString(36)+Math.random().toString(36).slice(2,7)),
    kind: PREBOOK_KINDS.includes(p.kind)? p.kind : 'vacation',
    wid: p.wid,
    start: p.start,
    end: (p.end && p.end>=p.start)? p.end : p.start
  };
}
/* 해당 날짜에 걸리는 사전등록 목록 */
function prebookOn(ds){ return (DB.prebook||[]).filter(p=> ds>=p.start && ds<=p.end); }

/* ---------- 휴무일 ---------- */
/* 대한민국 공휴일 2025~2027 (대체공휴일 포함, 참고용 내장 데이터) */
const KR_HOLIDAYS = {
  '2025-01-01':'신정','2025-01-27':'임시공휴일','2025-01-28':'설연휴','2025-01-29':'설날','2025-01-30':'설연휴',
  '2025-03-01':'삼일절','2025-03-03':'대체공휴일','2025-05-05':'어린이날·석가탄신일','2025-05-06':'대체공휴일',
  '2025-06-03':'대통령선거','2025-06-06':'현충일','2025-08-15':'광복절',
  '2025-10-03':'개천절','2025-10-05':'추석연휴','2025-10-06':'추석','2025-10-07':'추석연휴','2025-10-08':'대체공휴일','2025-10-09':'한글날',
  '2025-12-25':'성탄절',
  '2026-01-01':'신정','2026-02-16':'설연휴','2026-02-17':'설날','2026-02-18':'설연휴',
  '2026-03-01':'삼일절','2026-03-02':'대체공휴일','2026-05-05':'어린이날','2026-05-24':'석가탄신일','2026-05-25':'대체공휴일',
  '2026-06-03':'지방선거','2026-06-06':'현충일','2026-08-15':'광복절','2026-08-17':'대체공휴일',
  '2026-09-24':'추석연휴','2026-09-25':'추석','2026-09-26':'추석연휴',
  '2026-10-03':'개천절','2026-10-05':'대체공휴일','2026-10-09':'한글날','2026-12-25':'성탄절',
  '2027-01-01':'신정','2027-02-05':'설연휴','2027-02-06':'설날','2027-02-07':'설연휴','2027-02-08':'대체공휴일',
  '2027-03-01':'삼일절','2027-05-05':'어린이날','2027-05-13':'석가탄신일','2027-06-06':'현충일',
  '2027-08-15':'광복절','2027-08-16':'대체공휴일',
  '2027-09-14':'추석연휴','2027-09-15':'추석','2027-09-16':'추석연휴',
  '2027-10-03':'개천절','2027-10-04':'대체공휴일','2027-10-09':'한글날','2027-10-11':'대체공휴일',
  '2027-12-25':'성탄절','2027-12-27':'대체공휴일'
};
/* 휴무일 이름: 직접 지정 > 내장 공휴일 > null */
function holidayName(ds){ return (DB.holidays&&DB.holidays[ds]) || KR_HOLIDAYS[ds] || null; }
function isHolidayDate(ds){ return !!holidayName(ds); }

function normSched(s){
  s = s||{};
  return {
    date: s.date,
    workHoliday: !!s.workHoliday,
    nextWorkHoliday: !!s.nextWorkHoliday,
    nextMealAuto: !!s.nextMealAuto,
    dutyId:s.dutyId||null, situationId:s.situationId||null,
    nextDutyId:s.nextDutyId||null, nextSituationId:s.nextSituationId||null, nextMealId:s.nextMealId||null,
    prevDutyId:s.prevDutyId||null, prevSituationId:s.prevSituationId||null,
    mealId:s.mealId||null,
    dayEx:s.dayEx||[], nightEx:s.nightEx||[], bothEx:s.bothEx||[],
    assign:s.assign||{}, night:s.night||{},
    fixed:s.fixed||{}, patrolExtra:s.patrolExtra||null,
    relaxed:s.relaxed||{}, warnings:s.warnings||[], tier:s.tier||1,
    activeIds: Array.isArray(s.activeIds) ? s.activeIds : null,
    generatedAt:s.generatedAt||null
  };
}

/* ---------- 날짜/그룹 유틸 ---------- */
function pad(n){return String(n).padStart(2,'0');}
function todayStr(){const d=new Date();return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}
/* 생성된 시간표 중 가장 최신(최대) 날짜. 없으면 null */
function latestSchedDate(){ const ks=Object.keys(DB.schedules); return ks.length? ks.sort().slice(-1)[0] : null; }
function addDays(ds,n){const d=new Date(ds+'T00:00:00');d.setDate(d.getDate()+n);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}
function dow(ds){return new Date(ds+'T00:00:00').getDay();} // 0=일..6=토
const DOW_KR=['일','월','화','수','목','금','토'];

function dayGroup(ds, workHoliday){
  if(workHoliday) return 'weekend';
  const d=dow(ds);
  if(d===6||d===0) return 'weekend';
  if(d===3) return 'wed';
  if(d===5) return 'fri';
  return 'mtth'; // 월화목
}
const DAYGROUP_KR={mtth:'월화목', wed:'수', fri:'금', weekend:'토일/휴무'};
function mealGroup(ds, workHoliday){
  const d=dow(ds);
  return (workHoliday||d===6||d===0) ? 'weekend' : 'weekday';
}
// 야간 그룹: 다음날이 평일/휴일
function nightGroup(ds, nextWorkHoliday){
  const nd=dow(addDays(ds,1));
  if(nextWorkHoliday) return 'holiday';
  return (nd===6||nd===0) ? 'holiday' : 'weekday';
}

/* ---------- 근무자 헬퍼 ---------- */
function W(id){ return DB.workers.find(w=>w.id===id); }
function nameOf(id){ const w=W(id); return w?w.name:(id?'(삭제됨)':'—'); }
function isRecruit(w){ return !w.roleReady; }   // 신병·말년 모두 배정 메커니즘상 신병 취급
function isNavigator(w){ return !!w.isNavigator; }
function isVeteran(w){ return !!w.isVeteran; }
function activeWorkers(){ return DB.workers.filter(w=>w.active); }
/* 활성 운항병 1명(없으면 null) */
function activeNavigator(){ return DB.workers.find(w=>w.active && w.isNavigator) || null; }
/* 운항병 주간 고정 슬롯: 월~목 09:30·13:30 / 금 09:30·14:30 / 주말·휴무 없음(일반 풀 참여) */
function navFixedDaySlots(ds, workHoliday){
  if(dayGroup(ds, workHoliday)==='weekend') return [];   // 토·일·휴무: 고정 없음
  return dow(ds)===5 ? ['09:30','14:30'] : ['09:30','13:30'];
}
/* 운항병의 과거 금/토 야간 횟수 (균등 배분 판단용) */
function navNightBalance(navId){
  let fri=0, sat=0;
  Object.keys(DB.schedules).forEach(ds=>{
    const s=DB.schedules[ds];
    if(!(s && s.night && Object.values(s.night).includes(navId))) return;
    const d=dow(ds); if(d===5) fri++; else if(d===6) sat++;
  });
  return {fri, sat};
}

function inInactive(w, ds){
  return (w.inactivePeriods||[]).some(p=>{
    const s=p.start, e=p.end||'9999-12-31';
    return ds>=s && ds<=e;
  });
}
// 그 날짜에 '존재/가용'한가 (분모 계산용 기본조건)
function presentOn(w, ds, sched){
  if(inInactive(w,ds)) return false;
  if(sched){
    if((sched.bothEx||[]).includes(w.id)) return false;            // 전체열외 → 분모 제외
    if(Array.isArray(sched.activeIds)) return sched.activeIds.includes(w.id); // 생성시 활성자 스냅샷이 정답
    // 스냅샷 없는 구버전 표: 그 표가 만들어질 때 근무자가 아직 없었으면 제외(신규 추가자는 분모 0부터)
    if(w.createdAt && sched.generatedAt && sched.generatedAt < w.createdAt) return false;
  }
  return true;
}

/* ---------- 통계/배정률 엔진 ---------- */
/* 성능: buildStats는 모든 근무표를 매번 처음부터 훑어 비싸므로 캐시한다.
   결과는 DB(workers·schedules·patrolBonus)에만 의존하는 순수 계산이고,
   외부에서는 읽기만 하므로 동일 DB 상태에서는 캐시 재사용이 안전하다.
   DB가 바뀌는 시점(save)에서만 무효화 → 배정(배치) 로직은 전혀 손대지 않음. */
let _statsCache = new Map();
/* validateSchedule도 달력 한 달치(매 셀)에서 반복 호출되므로 같은 방식으로 캐시한다.
   전날 표·사전등록·근무자 이름에도 의존하지만, DB 변경 시점(save)에 전체 무효화하므로 안전하다. */
let _validCache = new Map();
function invalidateStats(){ _statsCache.clear(); _validCache.clear(); }
function buildStats(uptoDate, month){
  const key = (month||'') + '\u0001' + ((uptoDate==null) ? '\u0000ALL' : uptoDate);
  const hit = _statsCache.get(key);
  if(hit) return hit;
  const st = _computeStats(uptoDate, month);
  _statsCache.set(key, st);
  return st;
}
/* 모든 저장 근무표를 날짜순으로 훑어 각 근무자의
   분모(겪은 근무표 수)와 분자(배정 횟수)를 누적 → 배정률 산출 */
function _computeStats(uptoDate, month){
  const dates = Object.keys(DB.schedules).filter(d=> (!uptoDate || d<uptoDate) && (!month || d.slice(0,7)===month)).sort();
  const st = {};
  DB.workers.forEach(w=>{
    st[w.id]={
      hours: month ? 0 : (w.baseHours||0),
      wkndHours:0, wkndDen:0,   // 토·일·휴무(weekend 그룹)만의 근무시간·근무일수 — 운항병 배정용 평균에 사용
      denom:0, dutyCnt:0, sitCnt:0,
      groupNum:{mtth:0,wed:0,fri:0,weekend:0}, groupDen:{mtth:0,wed:0,fri:0,weekend:0},
      slotNum:{}, slotDen:0, slotLast:{},
      slotGNum:{mtth:{},wed:{},fri:{},weekend:{}},
      nightNum:0, nightDen:0, nightGNum:{weekday:0,holiday:0}, nightGDen:{weekday:0,holiday:0},
      bunchoNum:{1:0,2:0,3:0,4:0},
      mealNum:0, mealDen:0, mealGNum:{weekday:0,weekend:0}, mealGDen:{weekday:0,weekend:0}, lastMeal:null,
      patrolNum:0, patrolDen:0, patrolGNum:{weekday:0,weekend:0}, patrolGDen:{weekday:0,weekend:0}
    };
    DAY_SLOTS.forEach(s=>st[w.id].slotNum[s]=0);
    DAY_SLOTS.forEach(s=>{ ['mtth','wed','fri','weekend'].forEach(g=>st[w.id].slotGNum[g][s]=0); });
  });
  for(const ds of dates){
    const s = DB.schedules[ds];
    const g = dayGroup(ds, s.workHoliday);
    const ng = nightGroup(ds, s.nextWorkHoliday);
    const mg = mealGroup(ds, s.workHoliday);
    const isWknd = (g==='weekend');
    const addH = (id, x)=>{ st[id].hours += x; if(isWknd) st[id].wkndHours += x; };  // 시간 누적 + 주말분 별도 집계
    DB.workers.forEach(w=>{
      const r=st[w.id];
      const afterReset = !w.countResetAt || ds>=w.countResetAt;
      const present = presentOn(w, ds, s);
      // 분모 (일반: 카운트 기준 이후 + 가용)
      if(present && afterReset){
        r.denom++; r.slotDen++;
        if(isWknd) r.wkndDen++;
        r.groupDen[g]++; r.nightDen++; r.nightGDen[ng]++;
        // 순찰 분모: 16:30/17:30 근무자가 아니어야 후보 → 근사적으로 가용일수
        const at1630 = s.assign && s.assign['16:30']===w.id;
        const at1730 = s.fixed && s.fixed['17:30']===w.id;
        if(!at1630 && !at1730){ r.patrolDen++; r.patrolGDen[mg]++; }
      }
      // 밥교대 분모는 reset 무시(유지), 가용이면 카운트
      if(present){ r.mealDen++; r.mealGDen[mg]++; }
    });
    // 분자
    DAY_SLOTS.forEach(slot=>{
      const id = s.assign && s.assign[slot];
      if(id && st[id]){
        st[id].slotNum[slot]++; st[id].groupNum[g]++;
        st[id].slotGNum[g][slot]++;
        st[id].slotLast[slot]=ds;   // 날짜 오름차순 순회 → 마지막(최근) 배정일이 남음
        addH(id, slotHours(slot));
      }
    });
    NIGHT_BUNCHO.forEach(b=>{
      const id = s.night && s.night[b.id];
      if(id && st[id]){
        st[id].nightNum++; st[id].nightGNum[ng]++; st[id].bunchoNum[b.id]++;
        addH(id, 1);
      }
    });
    // 밥교대 (근무시간 부여 안 함 — 카운트만). 날짜 오름차순 순회라 lastMeal은 가장 최근 날짜가 남음
    if(s.mealId && st[s.mealId]){
      st[s.mealId].mealNum++; st[s.mealId].mealGNum[mg]++; st[s.mealId].lastMeal=ds;
    }
    // 순찰(전용 추가자)
    if(s.patrolExtra && st[s.patrolExtra]){
      st[s.patrolExtra].patrolNum++; st[s.patrolExtra].patrolGNum[mg]++; addH(s.patrolExtra, DB.settings.patrolBonus);
    }
    // 고정 역할 슬롯 시간(부하 반영). 14:30(당일상황)·13:30(금요일 당일상황)도 고정 슬롯이므로 여기서 1회만 집계.
    const fx = s.fixed||{};
    ['18:30','19:30','20:30','21:30','14:30','13:30'].forEach(k=>{ if(fx[k]&&st[fx[k]]) addH(fx[k], 1); });
    if(fx['17:30']&&st[fx['17:30']]) addH(fx['17:30'], 1 + DB.settings.patrolBonus);
    // 당직/상황병 카운트(표시용)
    if(s.dutyId&&st[s.dutyId]) st[s.dutyId].dutyCnt++;
    if(s.situationId&&st[s.situationId]) st[s.situationId].sitCnt++;
  }
  return st;
}
function slotHours(slot){ return slot==='07:30' ? 1+DB.settings.patrolBonus : 1; }
function rate(num,den){ return den>0 ? num/den : 0; }
function avgHours(r){ return r.denom>0 ? r.hours/r.denom : r.hours; }
// 운항병 배정 평균: 토·일·휴무 근무만으로 계산(분모=주말 근무일수, 분자=주말 근무시간).
// 주중 고정 스케줄의 큰 부하가 주말 배정 우선순위를 왜곡하지 않도록 분리한다.
function weekendAvgHours(r){ return r.wkndDen>0 ? r.wkndHours/r.wkndDen : 0; }
// 주간 슬롯 총량. 고정 역할 시간과 별도로 '일반 주간칸이 한 사람에게 몰리는지'를 보기 위한 보조 페널티.
function daySlotTotal(r){ return Object.values(r.slotNum||{}).reduce((a,b)=>a+(Number(b)||0),0); }

/* ---------- 분포 통계 (공정성 지표) ---------- */
function stdev(arr){ if(!arr.length) return 0; const m=arr.reduce((a,b)=>a+b,0)/arr.length; return Math.sqrt(arr.reduce((a,b)=>a+(b-m)*(b-m),0)/arr.length); }
function cv(arr){ if(!arr.length) return 0; const m=arr.reduce((a,b)=>a+b,0)/arr.length; if(m===0)return 0; const v=arr.reduce((a,b)=>a+(b-m)*(b-m),0)/arr.length; return Math.sqrt(v)/m; }
function gini(arr){ const a=arr.filter(x=>x>=0).slice().sort((x,y)=>x-y); const n=a.length; if(n===0)return 0; const s=a.reduce((x,y)=>x+y,0); if(s===0)return 0; let cum=0; for(let i=0;i<n;i++) cum+=(2*(i+1)-n-1)*a[i]; return cum/(n*s); }

if(typeof window!=='undefined') window._app = {get DB(){return DB;}, buildStats, dayGroup, nightGroup, mealGroup, activeNavigator}; // 디버그용

/* ============================================================
   배정 엔진
   ============================================================ */

/* 후보 공통: 활성 + 그 날짜 가용 + reset 이후(밥교대 제외) */
function baseEligible(ds){
  return activeWorkers().filter(w=> !inInactive(w,ds));
}

/* 주간 슬롯 후보 (열외 적용)
   운항병: 주중(월~금)엔 고정 스케줄만 서므로 일반 주간 풀에서 제외. 토·일·휴무엔 일반 근무자처럼 포함. */
function dayCandidates(ds, ctx){
  const ex = new Set([
    ctx.prevDutyId, ctx.dutyId, ctx.prevSituationId, ctx.situationId,
    ctx.mealId, ...ctx.dayEx, ...ctx.bothEx
  ].filter(Boolean));
  const weekday = dayGroup(ds, ctx.workHoliday)!=='weekend';
  return baseEligible(ds).filter(w=> !ex.has(w.id) && !(weekday && isNavigator(w)));
}
/* 야간 번초 후보 — 운항병은 야간을 사전배정(금/토 1회)으로만 서므로 항상 제외 */
function nightCandidates(ds, ctx){
  const ex = new Set([
    ctx.prevDutyId, ctx.dutyId, ctx.nextDutyId,
    ctx.prevSituationId, ctx.situationId, ctx.nextSituationId,
    ctx.nextMealId,            // 다음날 밥교대 → 내일 야간 투입 가능성 → 오늘 야간 금지(야간 이틀연속 방지)
    ...ctx.nightEx, ...ctx.bothEx
  ].filter(Boolean));
  return baseEligible(ds).filter(w=> !ex.has(w.id) && !isNavigator(w));
}
/* 밥교대 후보: 투입가능 + 전날·당일 당직/상황병·주간열외 제외 (다음날 당직/상황병은 포함)
   + 전날 야간자 회피(야간 후보 부족 시 밥교대가 야간에 투입될 수 있음 → 이틀연속 방지). 후보 고갈 시에만 완화. */
function mealCandidates(ds, ctx){
  const ex = new Set([
    ctx.prevDutyId, ctx.dutyId, ctx.prevSituationId, ctx.situationId,
    ...ctx.dayEx, ...ctx.bothEx
  ].filter(Boolean));
  const prevN = ctx._prevNight || new Set();
  // 운항병은 고정 부하가 커 밥교대 후보에서 제외
  const base = baseEligible(ds).filter(w=> w.canMeal && w.roleReady!==false && !isNavigator(w) && !ex.has(w.id));
  const noPrev = base.filter(w=> !prevN.has(w.id));
  return noPrev.length ? noPrev : base;   // 전날 야간자 외 인원이 없으면 부득이 완화
}

/* 공정성 점수 (낮을수록 우선) */
function score(w, slotKey, opts){
  const W_ = DB.settings.weights, r = opts.stats[w.id];
  let s = 0;
  // 운항병은 토·일 배정 우선순위를 주말 전용 평균으로 판단(주중 고정부하 제외)
  s += W_.avgHours * (isNavigator(w) ? weekendAvgHours(r) : avgHours(r));
  s += W_.todayHours * (opts.todayHours[w.id]||0);
  if(opts.isNight){
    s += W_.groupRate * rate(r.nightGNum[opts.nightGrp], r.nightGDen[opts.nightGrp]);
    s += W_.nightRate * rate(r.nightNum, r.nightDen);
    s += W_.bunchoRate * rate(r.bunchoNum[opts.bunchoId], r.nightDen);
    // 번초 반복은 비율만 보면 약하게 먹기 때문에 원횟수도 같이 페널티.
    s += 0.45 * (r.bunchoNum[opts.bunchoId]||0);
  }else{
    const g = opts.dayGrp;
    const slotCnt = r.slotNum[slotKey]||0;                       // 전체(그룹 무관) 해당 슬롯 횟수
    const gSlotCnt = (r.slotGNum[g]||{})[slotKey]||0;            // 같은 그룹에서 해당 슬롯 횟수
    s += W_.groupRate * rate(r.groupNum[g], r.groupDen[g]);
    // 핵심: 오늘과 같은 그룹(월화목/수/금/토일)에서 이 시간대에 들어간 '비율'이 낮은 사람부터.
    // 전체 비율만 보면 '수요일마다 06:30'처럼 그룹 안에서 반복되는 쏠림이 묻히기 때문에,
    // 통계 탭의 그룹별 슬롯 배정률(slotGNum/groupDen)을 그대로 배정 기준으로 쓴다.
    s += W_.slotRate * rate(gSlotCnt, r.groupDen[g]);
    // 원횟수 페널티: 같은 그룹 같은 시간대 반복은 강하게, 그룹 무관 전체 반복은 보조로 민다.
    // (시간대 공정성을 더 강하게: 같은 사람이 같은 시간대를 반복해 받는 쏠림을 키운 계수로 민다)
    s += 1.3 * gSlotCnt;
    s += 0.4 * slotCnt;
    // 보조 보정: 고정 역할이 적다는 이유로 일반 주간칸 전체가 한 명에게 몰리는 현상 방지.
    s += 0.08 * daySlotTotal(r);
  }
  if(isRecruit(w)) s += W_.recruitBias;            // 음수면 약간 우선
  s += (Math.random()-0.5) * W_.jitter;
  return s;
}

/* 당일 배정 개수의 '균등 비교 기준값'.
   신병은 기본 하루 2개씩 받도록 1개를 깎아서 비교한다.
   동률 시 신병/비신병 우선순위는 recruitOrder() 참고 — 합치면
   신병 2개씩 → 비신병 1개씩(점수순) → 그래도 넘치면 비신병 2개째(점수순) → 신병 3개째 … 순서가 된다. */
function effTodayCount(wid, cnt){
  const w = W(wid);
  cnt = cnt||0;
  return (w && isRecruit(w)) ? Math.max(0, cnt-1) : cnt;
}

/* 같은 기준개수(동률)에서의 신병/비신병 우선순위.
   주간: 기본 단계(기준개수 0)에는 신병 먼저(하루 2개 보장) / 넘침 단계(1+)에는 비신병 먼저.
   야간: 신병 우선 없음 — 야간·번초 배정률 점수로만 경쟁.
   (신병 우선이 야간에도 적용되면 야간 변수가 먼저 처리되는 솔버 특성상
    신병이 매일 야간·같은 번초만 도맡는 쏠림이 생긴다) */
function recruitOrder(w, effCnt, isNight){
  const rec = w && isRecruit(w);
  if(effCnt>0) return rec?1:0;     // 넘침: 비신병 먼저 (신병 3개째는 최후)
  if(isNight) return 0;            // 야간 기본 단계: 동순위 → 점수로 결정
  return rec?0:1;                  // 주간 기본 단계: 신병 먼저 (2개 채움)
}

/* 시간대(슬롯) 공정성 정렬키 — 같은 그룹에서 이 시간대를 많이 받은 사람일수록 큰 값(후순위).
   당일 개수(cnt) 다음, '신병 우선(rec)'보다 먼저 적용한다.
   이유: rec가 sc보다 앞서면 신병은 동률(cnt)일 때 무조건 먼저 뽑혀 MRV가 먼저 푸는
   이른 칸(아침/09:30)을 도맡는다. 시간대 공정성을 rec 앞에 두면 '그 시간대를 이미 많이 한
   사람'은 신병이라도 후순위가 되어, 신병이 이른 칸만 가져가는 쏠림이 끊긴다.
   개수(cnt)는 1순위로 그대로라 인당 근무개수·평균시간 균등은 영향받지 않는다.
   야간 번초는 0(영향 없음 — 번초 공정성은 bunchoRate가 담당). */
function slotFairKey(wid, v, ctx){
  if(!v || v.type!=='day') return 0;
  const r = ctx.stats[wid]; if(!r) return 0;
  const g = ctx._dayGrp;
  const gSlotCnt = (r.slotGNum[g]||{})[v.key]||0;   // 같은 그룹·같은 시간대 누적 횟수
  const slotCnt  = r.slotNum[v.key]||0;             // 그룹 무관 전체 해당 시간대 횟수
  // 정수 버킷: 미세 차이로 신병 우선이 흔들리지 않게 하되, 1회 이상 차이는 분명히 반영
  return Math.round(gSlotCnt*2 + slotCnt*0.5);
}

/* ----- 06:30 순번제(로테이션) -----
   06:30은 점수 경쟁이 아니라 순번으로 돈다: 신병/비신병 구분 없이
   ①06:30 누적 횟수가 적은 사람 → ②동률이면 마지막 06:30이 가장 오래된(또는 한 적 없는) 사람.
   하드 제약(전날 야간자 아침 금지·인접·열외 등)에 걸린 사람은 건너뛰고 다음 순번이 들어간다
   (횟수가 그대로라 다음 기회에 다시 1순위). */
const ROTATION_SLOT = '06:30';
function isRotationVar(v){ return v && v.type==='day' && v.key===ROTATION_SLOT; }
function rotCompare(a, b){
  return (a.rotCnt-b.rotCnt) || (a.rotLast<b.rotLast?-1:a.rotLast>b.rotLast?1:0);
}
function rotKeys(wid, ctx){
  const r = ctx.stats[wid];
  if(!r) return {rotCnt:0, rotLast:''};
  return {rotCnt: r.slotNum[ROTATION_SLOT]||0, rotLast: (r.slotLast&&r.slotLast[ROTATION_SLOT])||''};
}

/* ----- 신병 간 공평성 -----
   같은 날 신병이 받는 개수가 갈릴 때(예: 신병 3명이 2·2·1개) 누가 덜 받을지를 정한다:
   ①당일 원개수(effTodayCount로 깎기 전) 적은 신병 먼저 — 신병끼리 번갈아 채워 몰림 방지 →
   ②누적 평균시간이 적은 신병 먼저 — 평균시간 많은 신병이 적은 개수를 받는다.
   평균시간은 0.25h 버킷으로 비교해 미세 차이는 기존 순서(시간대 공정성 등, 안정 정렬)가 유지된다.
   정렬이 끝난 후보 목록에서 '신병이 있던 자리'끼리만 재배열하므로 비신병과의 상대 순서
   (당일 개수·시간대 공정성·신병 우선)는 그대로다. 06:30 순번제 슬롯에는 적용하지 않는다. */
function recruitAvgBucket(wid, ctx){
  const r = ctx.stats[wid];
  return r ? Math.round(avgHours(r)*4) : 0;
}
function rebalanceRecruits(list){
  const pos=[], recs=[];
  list.forEach((e,i)=>{ if(e.isRec){ pos.push(i); recs.push(e); } });
  if(recs.length<2) return list;
  recs.sort((a,b)=> (a.raw-b.raw) || (a.ravg-b.ravg));
  pos.forEach((p,k)=>{ list[p]=recs[k]; });
  return list;
}

/* 인접 판정 */
function slotsOf(varObj){ return varObj.type==='day' ? [varObj.key] : NIGHT_BUNCHO.find(b=>b.id===varObj.bunchoId).slots; }
function adjacent(slotsA, slotsB){
  for(const a of slotsA) for(const b of slotsB){
    const ia=SLOT_ORDER.indexOf(a), ib=SLOT_ORDER.indexOf(b);
    if(Math.abs(ia-ib)===1) return true;
  }
  return false;
}

function addSlotsToMap(map, wid, slots){
  if(!wid || !slots || !slots.length) return map;
  map[wid] = (map[wid] || []).concat(slots);
  return map;
}
function cloneSlotMap(map){
  const out = {};
  Object.entries(map || {}).forEach(([wid, slots])=>{ out[wid] = (slots || []).slice(); });
  return out;
}
function baseOccupiedSlots(ctx){
  return cloneSlotMap(ctx && ctx._fixedSlotsByWorker);
}
function slotsByWorkerFromFixed(fixed){
  const out = {};
  Object.entries(fixed || {}).forEach(([slot, wid])=>addSlotsToMap(out, wid, [slot]));
  return out;
}
function hasAdjacentOccupied(ctx, wid, slots){
  const m = baseOccupiedSlots(ctx);
  return !!(m[wid] && adjacent(m[wid], slots));
}

/* ----- 백트래킹 솔버 -----
   variables: [{type:'day',key} | {type:'night',bunchoId}]
   tier flags: allowPrevNightMorning, allowReuse, allowAdjacent  */
function solve(vars, domains, ctx, tier, prevNight){
  const flags = {
    allowPrevNightMorning: false,                          // 하드 제약: 전날 야간자 아침(06:30/07:30/08:30) 절대 금지
    allowReuse: tier>=2,                                   // 완화1: 인원 부족 시 중복 투입(같은 날 두 칸)
    allowConsecNight: tier>=3,                             // 완화2: 전날 야간자 오늘 야간(이틀연속) — 중복보다 나중에 양보
    allowAdjacent: false                                   // 하드 제약: 인접(연속) 슬롯 절대 금지 (완화하지 않음)
  };
  // 빠른 불가능 판정(비둘기집): 중복 투입이 막힌 단계에서 후보 합집합이 변수 수보다 적으면
  // 어차피 완전해가 없으므로 예산(6만 노드)을 태우지 않고 즉시 실패 처리한다.
  if(!flags.allowReuse){
    const uniq=new Set(); domains.forEach(d=>d.forEach(w=>uniq.add(w)));
    if(uniq.size < vars.length) return {ok:false, assign:{}};
  }
  const assign = {};        // varKey -> workerId
  // 고정 슬롯(특히 17:30 다음날 밥교대)을 인접 판정에 먼저 포함한다.
  // 기존에는 자동배정끼리만 인접을 막아서 16:30+17:30 같은 구멍이 생길 수 있었다.
  const usedSlotsByWorker = baseOccupiedSlots(ctx); // workerId -> [slot,...]
  const order = vars.map((v,i)=>i);
  let nodes = 0; const BUDGET = 60000;

  function varKey(v){ return v.type==='day' ? 'D'+v.key : 'N'+v.bunchoId; }
  function eligible(v, wid){
    if(assign && Object.values(assign).includes(wid) && !flags.allowReuse) return false;
    // 하드 제약(완화 불가): 한 사람은 같은 날 야간 번초 1개까지 — 1번초+3번초 같은 이중 야간 금지
    if(v.type==='night'){
      for(const k in assign){ if(k[0]==='N' && assign[k]===wid) return false; }
    }
    const sl = slotsOf(v);
    // 전날 야간자 → 다음날 아침 슬롯 열외
    if(!flags.allowPrevNightMorning && v.type==='day' && MORNING_AFTER_NIGHT.includes(v.key) && prevNight.has(wid)) return false;
    // 전날 야간자 → 오늘 야간 금지(야간 이틀 연속)
    if(!flags.allowConsecNight && v.type==='night' && prevNight.has(wid)) return false;
    // 인접 금지 (이미 다른 슬롯에 같은 사람)
    if(!flags.allowAdjacent && usedSlotsByWorker[wid]){
      if(adjacent(usedSlotsByWorker[wid], sl)) return false;
    }
    return true;
  }
  function place(v, wid){
    assign[varKey(v)] = wid;
    usedSlotsByWorker[wid] = (usedSlotsByWorker[wid]||[]).concat(slotsOf(v));
  }
  function unplace(v, wid){
    delete assign[varKey(v)];
    usedSlotsByWorker[wid] = usedSlotsByWorker[wid].filter(x=>!slotsOf(v).includes(x));
    if(usedSlotsByWorker[wid].length===0) delete usedSlotsByWorker[wid];
  }

  const todayHours = {...ctx._todayHours};
  const todayCount = {...(ctx._todayCount||{})};
  function bt(remaining){
    if(remaining.length===0) return true;
    if(++nodes>BUDGET) throw 'budget';
    // MRV: 현재 가용 후보 가장 적은 변수
    // 단 06:30(순번제)은 항상 먼저 확정 — 로테이션 1순위가 다른 슬롯에 선점되지 않게.
    let best=-1, bestList=null, bestSize=1e9;
    for(const idx of remaining){
      if(isRotationVar(vars[idx])){
        best=idx; bestList=domains[idx].filter(wid=>eligible(vars[idx],wid)); bestSize=bestList.length;
        break;
      }
    }
    if(best<0) for(const idx of remaining){
      const v=vars[idx];
      const list = domains[idx].filter(wid=>eligible(v,wid));
      if(list.length<bestSize){ bestSize=list.length; best=idx; bestList=list; }
      if(bestSize===0) break;
    }
    if(bestSize===0) return false; // 막힘 → 백트랙
    const v=vars[best];
    const dg=ctx._dayGrp, ng=ctx._nightGrp;
    // 후보 정렬(사전식): ①당일 기준개수 적은 사람 먼저(고정 포함 — 신병은 1개를 깎아 비교) →
    //   ②시간대 공정성(이 시간대를 적게 받은 사람 먼저) — 신병이 이른 칸만 도맡지 않도록 rec보다 앞 →
    //   ③동률이면 기본 단계는 신병 먼저, 넘침 단계는 비신병 먼저
    //   (신병 2개씩 → 비신병 1개씩 → 비신병 2개째 → 신병 3개째 순) →
    //   ④공정성 점수(평균시간·배정률 등) 오름차순
    bestList = bestList.map(wid=>{
      const w=W(wid);
      const o={stats:ctx.stats, todayHours, isNight:v.type==='night', dayGrp:dg, nightGrp:ng,
               bunchoId:v.type==='night'?v.bunchoId:null};
      const cnt=effTodayCount(wid, todayCount[wid]);
      return {wid, cnt, fair:slotFairKey(wid, v, ctx), rec:recruitOrder(w, cnt, v.type==='night'), sc:score(w, v.type==='day'?v.key:null, o),
              isRec: !!(w&&isRecruit(w)), raw: todayCount[wid]||0, ravg: recruitAvgBucket(wid, ctx), ...rotKeys(wid, ctx)};
    });
    if(isRotationVar(v)){
      // 06:30 순번제: 횟수 적은 순 → 오래된 순. 동률만 기존 공정성 순서로.
      bestList.sort((a,b)=> rotCompare(a,b) || (a.cnt-b.cnt) || (a.fair-b.fair) || (a.rec-b.rec) || (a.sc-b.sc));
    }else{
      bestList.sort((a,b)=> (a.cnt-b.cnt) || (a.fair-b.fair) || (a.rec-b.rec) || (a.sc-b.sc));
      if(v.type==='day') rebalanceRecruits(bestList);
    }
    bestList = bestList.map(x=>x.wid);

    const rest = remaining.filter(i=>i!==best);
    for(const wid of bestList){
      place(v,wid);
      const add = v.type==='day'? slotHours(v.key) : 1;
      todayHours[wid]=(todayHours[wid]||0)+add;
      todayCount[wid]=(todayCount[wid]||0)+1;
      if(bt(rest)) return true;
      todayCount[wid]--;
      todayHours[wid]-=add;
      unplace(v,wid);
    }
    return false;
  }
  try{
    const ok = bt(order);
    return {ok, assign:{...assign}};
  }catch(e){
    return {ok:false, assign:{...assign}, budget:true};
  }
}

/* 부분 채움(그리디): 솔버가 완전해를 못 찾을 때 남은 칸 최대한 채움 */
function greedyFill(vars, domains, ctx, prevNight, partial){
  const assign = {...partial};
  const used = new Set(Object.values(assign));
  const usedSlots = baseOccupiedSlots(ctx);
  Object.entries(assign).forEach(([k,wid])=>{
    const v = vars.find(v=> (v.type==='day'?'D'+v.key:'N'+v.bunchoId)===k);
    if(v) usedSlots[wid]=(usedSlots[wid]||[]).concat(slotsOf(v));
  });
  const todayHours={...ctx._todayHours};
  const todayCount={...(ctx._todayCount||{})};
  Object.values(assign).forEach(id=>{ if(id) todayCount[id]=(todayCount[id]||0)+1; });  // partial 반영
  // 06:30(순번제)부터 채워 로테이션 1순위가 다른 칸에 먼저 쓰이지 않게 한다 (안정 정렬 → 나머지 순서 유지)
  const fillOrder = vars.map((_,i)=>i).sort((a,b)=>(isRotationVar(vars[a])?0:1)-(isRotationVar(vars[b])?0:1));
  fillOrder.forEach(idx=>{
    const v=vars[idx];
    const key=v.type==='day'?'D'+v.key:'N'+v.bunchoId;
    if(assign[key]) return;
    // 하드 제약: 전날 야간자는 아침(06:30/07:30/08:30) 금지 — 위반보다 미배정
    const banMorning = (v.type==='day' && MORNING_AFTER_NIGHT.includes(v.key));
    const isNight = v.type==='night';
    const sl = slotsOf(v);
    const noAdj = wid => !(usedSlots[wid] && adjacent(usedSlots[wid], sl));   // 하드 제약: 인접 슬롯 절대 금지
    // 하드 제약(완화 불가): 같은 날 야간 번초 1개까지 — 이중 야간 금지
    const hasNight = wid => { for(const k in assign){ if(k[0]==='N' && assign[k]===wid) return true; } return false; };
    const okHard = wid => !(banMorning && prevNight.has(wid)) && noAdj(wid) && !(isNight && hasNight(wid));
    const okSoft = wid => okHard(wid) && !(isNight && prevNight.has(wid));   // 야간 이틀연속 회피(소프트)
    // 1차: 미사용 + 야간연속 회피, 2차: 중복 허용+야간연속 회피, 3차(최후): 야간연속까지 허용(아침·인접 금지는 유지)
    let pool = domains[idx].filter(wid=>!used.has(wid) && okSoft(wid));
    if(pool.length===0) pool = domains[idx].filter(okSoft);
    if(pool.length===0) pool = domains[idx].filter(wid=>!used.has(wid) && okHard(wid));
    if(pool.length===0) pool = domains[idx].filter(okHard);
    if(pool.length===0) return;              // 채울 사람 없음 → 미배정 (인접/아침 금지는 끝까지 유지)
    const o={stats:ctx.stats, todayHours, isNight:v.type==='night', dayGrp:ctx._dayGrp,
             nightGrp:ctx._nightGrp, bunchoId:v.type==='night'?v.bunchoId:null};
    // 사전식: 당일 기준개수(신병은 1개 깎음 → 기본 2개씩) → 시간대 공정성(적게 받은 사람 먼저) → 기본 단계 신병 먼저·넘침 단계 비신병 먼저 → 점수
    // 06:30은 순번제(누적 횟수 → 오래된 순), 그 외 주간칸은 신병끼리 재배열(rebalanceRecruits) 적용
    pool = pool.map(wid=>{
      const w=W(wid);
      const cnt=effTodayCount(wid, todayCount[wid]);
      return {wid, cnt, fair:slotFairKey(wid, v, ctx), rec:recruitOrder(w, cnt, v.type==='night'), sc:score(w, v.type==='day'?v.key:null, o),
              isRec: !!(w&&isRecruit(w)), raw: todayCount[wid]||0, ravg: recruitAvgBucket(wid, ctx), ...rotKeys(wid, ctx)};
    });
    if(isRotationVar(v)){
      pool.sort((a,b)=> rotCompare(a,b) || (a.cnt-b.cnt) || (a.fair-b.fair) || (a.rec-b.rec) || (a.sc-b.sc));
    }else{
      pool.sort((a,b)=> (a.cnt-b.cnt) || (a.fair-b.fair) || (a.rec-b.rec) || (a.sc-b.sc));
      if(v.type==='day') rebalanceRecruits(pool);
    }
    const wid=pool[0].wid;
    assign[key]=wid; used.add(wid);
    todayCount[wid]=(todayCount[wid]||0)+1;
    usedSlots[wid]=(usedSlots[wid]||[]).concat(sl);   // 인접 판정 위해 점유 슬롯 누적
  });
  return assign;
}

/* 국소 개선: 제약 위반 없는 후보로만 교체(1-opt)하거나 두 칸의 배정자를 맞바꿔(2-opt)
   점수합 감소 (해를 악화시키지 않음, 균등도 유지) */
function localImprove(vars, domains, ctx, assign, prevNight){
  let improved=true, guard=0;
  const keyOf=v=> v.type==='day'?'D'+v.key:'N'+v.bunchoId;
  function used(exceptKey){ const s=new Set(); Object.entries(assign).forEach(([k,v])=>{ if(k!==exceptKey) s.add(v); }); return s; }
  function occupiedSlotsExcept(...exceptKeys){
    const m = baseOccupiedSlots(ctx);
    Object.entries(assign).forEach(([k,wid])=>{
      if(exceptKeys.includes(k) || !wid) return;
      const vv = vars.find(v=> keyOf(v)===k);
      if(vv) addSlotsToMap(m, wid, slotsOf(vv));
    });
    return m;
  }
  function scoreOpts(v){
    return {stats:ctx.stats, todayHours:ctx._todayHours, isNight:v.type==='night', dayGrp:ctx._dayGrp,
            nightGrp:ctx._nightGrp, bunchoId:v.type==='night'?v.bunchoId:null};
  }
  /* wid를 v에 둘 때 하드 제약 검사 — ig(무시할 키)들을 비운 상태 기준 (2-opt 스왑 검증용) */
  function hardOk(v, wid, ...ig){
    const occ = occupiedSlotsExcept(...ig);
    if(occ[wid] && adjacent(occ[wid], slotsOf(v))) return false;                       // 인접 금지(고정 포함)
    if(v.type==='day' && MORNING_AFTER_NIGHT.includes(v.key) && prevNight.has(wid)) return false; // 전날 야간자 아침 금지
    if(v.type==='night'){
      if(prevNight.has(wid)) return false;                                             // 야간 이틀연속 도입 금지
      for(const k in assign){ if(!ig.includes(k) && k[0]==='N' && assign[k]===wid) return false; } // 이중 야간 금지
    }
    return true;
  }
  /* 2-opt: 서로 다른 두 칸의 배정자를 맞바꿈 — 개인별 배정 개수가 안 변해 균등이 깨지지 않고,
     1-opt(한 칸 교체)로는 못 빠져나오는 국소최적을 탈출한다 */
  function twoOptPass(){
    let changed=false;
    for(let i=0;i<vars.length;i++){
      const vi=vars[i], ki=keyOf(vi), a=assign[ki]; if(!a || isRotationVar(vi)) continue; // 06:30 순번제 보호
      const oi=scoreOpts(vi);
      for(let j=i+1;j<vars.length;j++){
        const vj=vars[j], kj=keyOf(vj), b=assign[kj];
        if(!b || a===b || isRotationVar(vj)) continue;
        if(!domains[i].includes(b) || !domains[j].includes(a)) continue;
        if(!hardOk(vi,b,ki,kj) || !hardOk(vj,a,ki,kj)) continue;
        const oj=scoreOpts(vj);
        const cur = score(W(a), vi.type==='day'?vi.key:null, oi) + score(W(b), vj.type==='day'?vj.key:null, oj);
        const alt = score(W(b), vi.type==='day'?vi.key:null, oi) + score(W(a), vj.type==='day'?vj.key:null, oj);
        if(alt < cur - 0.25){ assign[ki]=b; assign[kj]=a; changed=true; break; }
      }
    }
    return changed;
  }
  // 당일 개수(고정 포함 + 현재 배정) — 스왑이 균등을 깨지 않도록 감시
  const todayCount={...(ctx._todayCount||{})};
  Object.values(assign).forEach(id=>{ if(id) todayCount[id]=(todayCount[id]||0)+1; });
  while(improved && guard++<40){
    improved=false;
    for(let i=0;i<vars.length;i++){
      const v=vars[i], key=v.type==='day'?'D'+v.key:'N'+v.bunchoId;
      const cur=assign[key]; if(!cur) continue;
      if(isRotationVar(v)) continue;   // 06:30은 순번제 — 점수 교체로 로테이션을 깨지 않는다
      const o={stats:ctx.stats, todayHours:ctx._todayHours, isNight:v.type==='night', dayGrp:ctx._dayGrp,
               nightGrp:ctx._nightGrp, bunchoId:v.type==='night'?v.bunchoId:null};
      const curSc=score(W(cur), v.type==='day'?v.key:null, o);
      const uset=used(key);
      const occ=occupiedSlotsExcept(key);
      const sl=slotsOf(v);
      for(const wid of domains[i]){
        if(uset.has(wid)) continue;
        if(occ[wid] && adjacent(occ[wid], sl)) continue; // 하드 제약: 고정 슬롯 포함 인접 금지
        if(v.type==='day' && MORNING_AFTER_NIGHT.includes(v.key) && prevNight.has(wid)) continue; // 하드 제약
        if(v.type==='night' && prevNight.has(wid)) continue; // 야간 이틀연속 도입 금지
        // 균등 유지: 새 배정자의 당일 기준개수(신병은 1개 깎음)가 기존 배정자 이상이 되면(피크 상승) 스왑 금지
        if(effTodayCount(wid, (todayCount[wid]||0) + 1) > effTodayCount(cur, todayCount[cur])) continue;
        // 신병 간 균형 유지: 평균시간이 많거나 같은 신병 쪽으로 개수가 더 늘어나는 교체 금지
        if(isRecruit(W(wid)) && isRecruit(W(cur)) &&
           (todayCount[wid]||0)+1 > (todayCount[cur]||0)-1 &&
           recruitAvgBucket(wid, ctx) >= recruitAvgBucket(cur, ctx)) continue;
        const sc=score(W(wid), v.type==='day'?v.key:null, o);
        if(sc < curSc - 0.25){
          assign[key]=wid; improved=true;
          todayCount[wid]=(todayCount[wid]||0)+1; todayCount[cur]=(todayCount[cur]||0)-1;
          break;
        }
      }
    }
    // 1-opt가 더 못 줄이면 2-opt(맞교환) 시도 — 성공하면 다음 라운드에서 1-opt 재시도
    if(!improved) improved = twoOptPass();
  }
  return assign;
}

/* ----- 밥교대 자동배정 -----
   사전식 균등: ① 오늘 그룹(평일/주말·휴일) 횟수가 적은 사람 →
               ② 전체 밥교대 횟수가 적은 사람 →
               ③ 마지막 밥교대가 가장 오래된(또는 한 적 없는) 사람 →
               ④ 미세 점수(그룹 배정률·평균시간·신병 보정·난수)
   → 두 그룹이 각각 고르게 + 전체 횟수도 고르게 + 동률이면 오래 쉰 사람부터. */
function assignMeal(ds, ctx){
  if(ctx.mealId) return ctx.mealId; // 수동 지정/이전됨
  const cands = mealCandidates(ds, ctx);
  if(cands.length===0) return null;
  const mg = mealGroup(ds, ctx.workHoliday);
  const scored = cands.map(w=>{
    const r=ctx.stats[w.id];
    let sc = DB.settings.weights.mealRate * rate(r.mealGNum[mg], r.mealGDen[mg]);
    sc += DB.settings.weights.avgHours * avgHours(r) * 0.5;
    if(isRecruit(w)) sc += DB.settings.weights.recruitBias;
    sc += (Math.random()-0.5)*DB.settings.weights.jitter;
    return {id:w.id,
            g: r.mealGNum[mg]||0,
            t: (r.mealGNum.weekday||0)+(r.mealGNum.weekend||0),
            last: r.lastMeal||'',      // ''(한 적 없음)이 가장 먼저
            sc};
  }).sort((a,b)=> (a.g-b.g) || (a.t-b.t) ||
                  (a.last<b.last?-1:a.last>b.last?1:0) || (a.sc-b.sc));
  return scored[0].id;
}

/* ----- 다음날 밥교대 자동배정 (다음날 기준으로 assignMeal 재사용) ----- */
function autoNextMeal(ds, ctx){
  const nextDs = addDays(ds,1);
  const nctx = {
    date: nextDs,
    workHoliday: !!ctx.nextWorkHoliday,
    dutyId: ctx.nextDutyId||null, situationId: ctx.nextSituationId||null,   // 다음날 당직/상황병
    prevDutyId: ctx.dutyId||null, prevSituationId: ctx.situationId||null,    // 다음날의 '전날' = 오늘
    // 오늘 밥교대자는 야간 후보 부족 시 오늘 야간에 투입될 수 있음 → 다음날 밥교대로 또 뽑히면 이틀 연속 우려.
    // 그러므로 다음날 밥교대 후보에서 오늘 밥교대자를 제외한다.
    dayEx: [...(ctx.dayEx||[]), ctx.mealId].filter(Boolean), bothEx: ctx.bothEx||[],
    mealId: null,
    stats: buildStats(nextDs)
  };
  return assignMeal(nextDs, nctx);
}
/* 다음날 밥교대 값 해석: ''·미지정=자동, '__none__'=없음, 그 외=지정 인원 */
function resolveNextMeal(ds, ctx){
  const v = ctx.nextMealId;
  if(v === '__none__') return {id:null, auto:false};
  if(v) return {id:v, auto:false};
  return {id: autoNextMeal(ds, ctx), auto:true};
}
/* ----- 순찰(17:30 추가) 자동배정 ----- */
/* ----- 순찰(17:30 추가, 0.5h) 자동배정 -----
   16:30 근무자·17:30 근무자 제외 + 주간 근무 가능 풀(당직/상황·전날·밥교대·열외 제외)에서
   평일/주말·휴일 그룹별 순찰 배정률이 가장 낮은 한 명 선정 */
function patrolCandidates(ds, ctx, assign, fixed){
  const ex = new Set([assign['16:30'], fixed['17:30'], ...ctx.bothEx].filter(Boolean));
  return dayCandidates(ds, ctx).filter(w=> !ex.has(w.id));
}
function assignPatrol(ds, ctx, assign, fixed){
  const cands = patrolCandidates(ds, ctx, assign, fixed);
  if(cands.length===0) return null;
  const pg = mealGroup(ds, ctx.workHoliday);  // 평일 / 주말·휴일
  const scored = cands.map(w=>{
    const r=ctx.stats[w.id];
    let sc = DB.settings.weights.patrolRate * rate(r.patrolGNum[pg], r.patrolGDen[pg]);
    sc += DB.settings.weights.avgHours * avgHours(r) * 0.4;
    if(isRecruit(w)) sc += DB.settings.weights.recruitBias;
    sc += (Math.random()-0.5)*DB.settings.weights.jitter;
    return {id:w.id, sc};
  }).sort((a,b)=>a.sc-b.sc);
  return scored[0].id;
}

/* ============================================================
   일일 생성 오케스트레이션
   ============================================================ */
function generateDay(input){
  const ds = input.date;
  const prev = DB.schedules[addDays(ds,-1)];
  const ctx = {
    date:ds, workHoliday:!!input.workHoliday,
    dutyId: input.dutyId|| (prev?prev.nextDutyId:null) || null,
    situationId: input.situationId|| (prev?prev.nextSituationId:null) || null,
    nextDutyId: input.nextDutyId||null,
    nextSituationId: input.nextSituationId||null,
    nextMealId: input.nextMealId,   // raw: ''/미지정=자동, '__none__'=없음, id=지정
    mealId: input.mealId|| (prev?prev.nextMealId:null) || null,
    prevDutyId: prev ? prev.dutyId : (input.prevDutyId||null),
    prevSituationId: prev ? prev.situationId : (input.prevSituationId||null),
    dayEx: input.dayEx||[], nightEx: input.nightEx||[], bothEx: input.bothEx||[],
    nextWorkHoliday: !!input.nextWorkHoliday,
  };
  // 통계는 '이 날짜 이전' 표 기준
  ctx.stats = buildStats(ds);
  ctx._todayHours = {};
  ctx._todayCount = {};   // 당일 배정 '개수'(고정 포함) — 균등 분배(1개씩 먼저)의 1차 기준
  ctx._dayGrp = dayGroup(ds, ctx.workHoliday);
  ctx._nightGrp = nightGroup(ds, ctx.nextWorkHoliday);   // 다음날 휴무 반영

  // 전날 야간자 집합 (밥교대/다음날밥교대 선정의 야간 연속 방지에 사용)
  const prevNight = new Set();
  if(prev && prev.night){ Object.values(prev.night).forEach(id=>{ if(id) prevNight.add(id); }); }
  ctx._prevNight = prevNight;

  const warnings = [];
  const relaxed = {};
  const fixed = {};

  /* 1) 오늘 밥교대 결정 (전날 야간자 회피 → 야간 폴백 투입 시 이틀연속 방지) */
  ctx.mealId = assignMeal(ds, ctx);
  if(!ctx.mealId) warnings.push('밥교대 후보가 없어 미배정되었습니다.');

  /* 1-2) 다음날 밥교대 해석 (오늘 밥교대와 동일인 회피 → 야간 연속 방지) */
  const _rnm = resolveNextMeal(ds, ctx);
  ctx.nextMealId = _rnm.id; ctx.nextMealAuto = _rnm.auto;

  /* 2) 고정 역할 슬롯 */
  // 당일 상황병 고정칸 (평일, 또는 휴무+설정ON). 금요일은 14:30 대신 13:30에 고정.
  const wd = dow(ds); const isWeekdaySit = (wd===1||wd===2||wd===4||wd===5);
  const allow1430 = ctx.workHoliday ? DB.settings.enable1430OnHoliday : isWeekdaySit;
  const sitFixSlot = (wd===5 && !ctx.workHoliday) ? '13:30' : '14:30';
  if(allow1430 && ctx.situationId) fixed[sitFixSlot]=ctx.situationId;
  if(ctx.nextMealId) fixed['17:30']=ctx.nextMealId;       // 다음날 밥교대 + 순찰
  if(ctx.nextSituationId) fixed['18:30']=ctx.nextSituationId;
  if(ctx.nextDutyId) fixed['19:30']=ctx.nextDutyId;
  if(ctx.prevSituationId) fixed['20:30']=ctx.prevSituationId;
  if(ctx.prevDutyId) fixed['21:30']=ctx.prevDutyId;

  /* 2-1) 운항병 사전배정: 주중 고정 주간슬롯 + 금/토 야간 1회(균등).
     상황병 등으로 그날 주간/야간 열외 대상이면 해당 고정을 자동으로 뺀다. */
  const nav = activeNavigator();
  const navDay = {};      // slot -> nav.id (assign에 병합)
  let navNight = null;    // {bunchoId} — 야간 번초 사전배정
  if(nav && !inInactive(nav, ds) && !ctx.bothEx.includes(nav.id)){
    // 주간 고정: 그날 주간 열외 대상(상황병·당직·전날역할·밥교대·주간열외)이 아니면 적용
    const dayEx = new Set([ctx.prevDutyId,ctx.dutyId,ctx.prevSituationId,ctx.situationId,ctx.mealId,...ctx.dayEx].filter(Boolean));
    if(!dayEx.has(nav.id)){
      navFixedDaySlots(ds, ctx.workHoliday).forEach(sl=>{ if(!fixed[sl]) navDay[sl]=nav.id; });
    }
    // 야간: 금(wd5)/토(wd6)에 균등 배분으로 매주 1회. 야간 열외 대상이면 건너뜀(다른 날이 흡수).
    const nightEx = new Set([ctx.prevDutyId,ctx.dutyId,ctx.nextDutyId,ctx.prevSituationId,ctx.situationId,ctx.nextSituationId,ctx.nextMealId,...ctx.nightEx].filter(Boolean));
    const nightOk = !nightEx.has(nav.id) && !prevNight.has(nav.id);
    if(nightOk && (wd===5 || wd===6)){
      const {fri,sat} = navNightBalance(nav.id);
      let take=false;
      if(wd===5) take = (fri<=sat);                          // 금: 균형상 금이 밀리면 오늘 밤
      else{                                                  // 토: 전날(금) 야간을 안 섰으면 오늘 밤
        const didFri = prev && prev.night && Object.values(prev.night).includes(nav.id);
        take = !didFri;
      }
      if(take){
        // 번초 균등: 그동안 가장 적게 선 번초 선택
        const bn = ctx.stats[nav.id] ? ctx.stats[nav.id].bunchoNum : {1:0,2:0,3:0,4:0};
        const pick = [1,2,3,4].reduce((a,b)=> (bn[b]||0) < (bn[a]||0) ? b : a, 1);
        navNight = {bunchoId: pick};
      }
    }
  }

  /* 3) 변수 집합: 주간 슬롯(고정·운항병 선점칸 제외) + 야간 번초(운항병 선점 번초 제외) */
  const occDay = new Set(Object.keys(navDay));
  DAY_SLOTS.forEach(s=>{ if(fixed[s]) occDay.add(s); });   // 13:30/14:30 당일상황 고정칸
  const dayVars = DAY_SLOTS.filter(s=>!occDay.has(s)).map(key=>({type:'day',key}));
  // 주간 변수 처리 순서 무작위화: 후보 동률(특히 '신병 먼저')일 때 늘 같은 이른 슬롯부터
  // 배정되는 쏠림(신병이 매일 06:30 등 특정 시간대만 받는 현상)을 깬다.
  // 시간대별 누적 공정성은 점수의 slotRate·slotCnt 페널티와 2-opt가 계속 맞춘다.
  for(let i=dayVars.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [dayVars[i],dayVars[j]]=[dayVars[j],dayVars[i]];
  }
  const nightVars = NIGHT_BUNCHO.filter(b=> !(navNight && navNight.bunchoId===b.id)).map(b=>({type:'night',bunchoId:b.id}));

  /* 3-1) 밥교대 인원은 기본적으로 야간 제외 — 야간 후보가 부족할 때만 폴백으로 자동 투입(5단계).
     단 야간열외(다음날 당직/상황병 등) 대상이면 폴백에서도 제외. */
  const mealNightExcluded = ctx.mealId &&
    new Set([ctx.prevDutyId,ctx.dutyId,ctx.nextDutyId,ctx.prevSituationId,ctx.situationId,ctx.nextSituationId,...ctx.nightEx,...ctx.bothEx].filter(Boolean)).has(ctx.mealId);

  // 인접 금지 기준점: 고정 슬롯을 자동배정 전에 먼저 점유 처리한다.
  // 이로써 16:30 자동 + 17:30 고정 같은 연속근무가 후보 단계에서 차단된다.
  ctx._fixedSlotsByWorker = slotsByWorkerFromFixed(fixed);
  // 운항병 사전배정 슬롯(주간 고정 + 야간 번초)도 인접 기준에 포함
  Object.entries(navDay).forEach(([sl,id])=>addSlotsToMap(ctx._fixedSlotsByWorker, id, [sl]));
  if(navNight) addSlotsToMap(ctx._fixedSlotsByWorker, nav.id, NIGHT_BUNCHO.find(b=>b.id===navNight.bunchoId).slots);

  /* 4) 도메인 */
  const dayCand = dayCandidates(ds, ctx).map(w=>w.id);
  const nightCand = nightCandidates(ds, ctx).map(w=>w.id)
    .filter(id=> id!==ctx.mealId); // 밥교대는 기본 야간 제외 (부족 시에만 폴백 투입)
  const vars = dayVars.concat(nightVars);
  const domains = vars.map(v=> v.type==='day'? dayCand.slice() : nightCand.slice());

  // 당일 부하 사전 반영: 고정 역할 슬롯(14:30·17:30·18:30·19:30·20:30·21:30).
  // 이렇게 해야 '고정까지 포함해 하루 균등'이 되고, 다음날 상황/당직병(주간 후보엔 들어감)이 주간을 덧받지 않음.
  Object.entries(fixed).forEach(([slot,id])=>{
    if(!id) return;
    const h = slot==='17:30' ? (1 + DB.settings.patrolBonus) : 1;
    ctx._todayHours[id] = (ctx._todayHours[id]||0) + h;
    ctx._todayCount[id] = (ctx._todayCount[id]||0) + 1;
  });
  // 운항병 사전배정 부하도 반영(주간 고정 각 1h, 야간 번초 1h)
  Object.keys(navDay).forEach(sl=>{
    ctx._todayHours[nav.id] = (ctx._todayHours[nav.id]||0) + slotHours(sl);
    ctx._todayCount[nav.id] = (ctx._todayCount[nav.id]||0) + 1;
  });
  if(navNight){
    ctx._todayHours[nav.id] = (ctx._todayHours[nav.id]||0) + 1;
    ctx._todayCount[nav.id] = (ctx._todayCount[nav.id]||0) + 1;
  }

  /* 5) 완화 사다리 1→3 (전날 야간 아침 금지·인접 금지는 절대 완화하지 않음) — prevNight은 위에서 산출
     tier1 깨끗 → tier2 중복 투입 → tier3 야간 연속. 그래도 안 되면 부분 채움(인접·아침 금지는 유지) */
  function runLadder(doms){
    for(let tier=1; tier<=3; tier++){
      const r = solve(vars, doms, ctx, tier, prevNight);
      if(r.ok) return {assign:r.assign, tier};
      if(tier===3) // 완전해 실패 → 부분 채움 (전날 야간 아침·인접 금지 유지)
        return {assign: greedyFill(vars, doms, ctx, prevNight, r.assign||{}), tier:4};
    }
  }
  let usedDomains = domains;
  let run = runLadder(domains);
  /* 5-1) 폴백: 야간 번초가 비었고 밥교대 인원을 투입할 수 있으면 야간 후보에 추가 후 재시도 */
  const filledCnt = a => Object.values(a).filter(Boolean).length;
  const nightUnfilled = a => nightVars.some(v=> !a['N'+v.bunchoId]);
  if(ctx.mealId && !mealNightExcluded && nightUnfilled(run.assign)){
    const domains2 = vars.map(v=> v.type==='day'? dayCand.slice() : nightCand.concat([ctx.mealId]));
    const run2 = runLadder(domains2);
    if(run2.tier<4 || filledCnt(run2.assign) > filledCnt(run.assign)){
      run = run2; usedDomains = domains2;
    }
  }
  let result = run.assign;
  const usedTier = run.tier;
  // tier2(중복 투입)은 인원 적은 부대에서 상시 발생하므로 경고하지 않음
  if(usedTier===3) warnings.push('완화: 인원 부족으로 야간 연속(전날 야간자 재투입)을 허용했습니다.');
  if(usedTier===4) warnings.push('인원 부족으로 일부 슬롯을 채우지 못했습니다(미배정). 인접·아침 금지를 지키느라 비워둔 칸일 수 있습니다.');

  /* 7) 국소 개선 */
  result = localImprove(vars, usedDomains, ctx, result, prevNight);
  if(ctx.mealId && nightVars.some(v=> result['N'+v.bunchoId]===ctx.mealId))
    warnings.push('야간 후보 부족으로 밥교대 인원을 야간 번초에 투입했습니다.');

  /* 8) 결과 조립 */
  const assign={}, night={};
  // (13:30/14:30 당일상황이 고정이면 s.fixed에만 두고 assign에는 넣지 않음 — buildStats 이중 집계 방지)
  vars.forEach(v=>{
    const key=v.type==='day'?'D'+v.key:'N'+v.bunchoId;
    if(v.type==='day') assign[v.key]=result[key]||null;
    else night[v.bunchoId]=result[key]||null;
  });
  // 운항병 사전배정 병합 (주간 고정슬롯은 일반 근무이므로 assign에, 야간은 night에)
  Object.entries(navDay).forEach(([sl,id])=>{ assign[sl]=id; });
  if(navNight) night[navNight.bunchoId]=nav.id;

  // 미배정 경고
  DAY_SLOTS.forEach(s=>{ if(!assign[s] && !fixed[s]) warnings.push('주간 '+s+' 미배정'); });
  [1,2,3,4].forEach(b=>{ if(!night[b]) warnings.push('야간 '+b+'번초 미배정'); });

  /* 9) 순찰(17:30 추가) */
  const patrolExtra = assignPatrol(ds, ctx, assign, fixed);

  const sched = {
    date:ds, workHoliday:ctx.workHoliday,
    dutyId:ctx.dutyId, situationId:ctx.situationId,
    nextDutyId:ctx.nextDutyId, nextSituationId:ctx.nextSituationId, nextMealId:ctx.nextMealId,
    nextMealAuto:ctx.nextMealAuto,
    prevDutyId:ctx.prevDutyId, prevSituationId:ctx.prevSituationId,
    mealId:ctx.mealId, dayEx:ctx.dayEx, nightEx:ctx.nightEx, bothEx:ctx.bothEx,
    nextWorkHoliday:ctx.nextWorkHoliday,
    assign, night, fixed, patrolExtra, relaxed, warnings, tier:usedTier,
    activeIds: activeWorkers().map(w=>w.id),   // 생성 시점 활성자 스냅샷 → 비활성자는 이 날 분모에서 제외
    generatedAt:new Date().toISOString()
  };
  return sched;
}

/* ---------- 실시간 재검증 ---------- */
/* 저장된 s.warnings 대신 현재 배정 상태로 새로 계산 */
function validateSchedule(s){
  const out=[];
  const push=m=>{ if(m && !out.includes(m)) out.push(m); };  // 중복 제거
  const assign=s.assign||{}, fixed=s.fixed||{}, night=s.night||{};

  // 점유 슬롯 맵 (주간 + 저녁고정 + 14:30 + 야간 2슬롯 + 추가순찰 17:30)
  const occ={}; // wid -> Set(slot)
  const mark=(id,slot)=>{ if(!id) return; (occ[id]=occ[id]||new Set()).add(slot); };
  DAY_SLOTS.forEach(sl=> mark(assign[sl]||fixed[sl], sl));
  EVENING.forEach(sl=> mark(fixed[sl], sl));
  NIGHT_BUNCHO.forEach(b=>{ const id=night[b.id]; if(id) b.slots.forEach(sl=>mark(id,sl)); });
  // 추가순찰(17:00)은 SLOT_ORDER 밖이라 인접맵에 넣지 않음 — 16:30/17:30 중복은 아래 7)에서 점검

  // 1) 같은 날 인접 슬롯 연속근무
  Object.keys(occ).forEach(id=>{
    const slots=[...occ[id]].sort((a,b)=>SLOT_ORDER.indexOf(a)-SLOT_ORDER.indexOf(b));
    for(let i=0;i<slots.length;i++) for(let j=i+1;j<slots.length;j++){
      if(Math.abs(SLOT_ORDER.indexOf(slots[i])-SLOT_ORDER.indexOf(slots[j]))===1)
        push(nameOf(id)+' 인접 슬롯 연속근무: '+slots[i]+'·'+slots[j]);
    }
  });

  // 2) 날짜 경계 연속: 전날 05:30(4번초) == 당일 06:30
  const prev=DB.schedules[addDays(s.date,-1)];
  if(prev){
    const prev0530 = prev.night && prev.night[4];
    if(prev0530 && assign['06:30']===prev0530)
      push(nameOf(prev0530)+' 날짜경계 연속근무: 전날 05:30 → 당일 06:30');
    // 3) 전날 야간자가 당일 야간 번초에 배정
    const prevNight=new Set(Object.values(prev.night||{}).filter(Boolean));
    NIGHT_BUNCHO.forEach(b=>{ const id=night[b.id]; if(id && prevNight.has(id)) push(nameOf(id)+' 야간 연속(전날 야간 → 당일 '+b.id+'번초)'); });
    MORNING_AFTER_NIGHT.forEach(sl=>{ const id=assign[sl]; if(id && prevNight.has(id)) push(nameOf(id)+' 전날 야간자가 아침 '+sl+'에 배정됨(금지)'); });
  }

  // 4) 열외 대상이 해당 영역에 배정 (14:30 당일상황병 고정 예외)
  const dEx=new Set([...(s.dayEx||[]),...(s.bothEx||[])]);
  const nEx=new Set([...(s.nightEx||[]),...(s.bothEx||[])]);
  DAY_SLOTS.forEach(sl=>{
    const id=assign[sl]; if(!id) return;
    if(sl==='14:30' && fixed['14:30']===id) return; // 당일 상황병 고정 예외
    if(dEx.has(id)) push(nameOf(id)+' 주간열외인데 '+sl+' 배정됨');
  });
  NIGHT_BUNCHO.forEach(b=>{ const id=night[b.id]; if(id && nEx.has(id)) push(nameOf(id)+' 야간/전체열외인데 '+b.id+'번초 배정됨'); });

  // 4-2) 같은 날 야간 번초 2개 이상 (이중 야간 금지 — 하드 규칙)
  const nightCnt={};
  NIGHT_BUNCHO.forEach(b=>{ const id=night[b.id]; if(id) nightCnt[id]=(nightCnt[id]||0)+1; });
  Object.keys(nightCnt).forEach(id=>{ if(nightCnt[id]>=2) push(nameOf(id)+' 같은 날 야간 번초 '+nightCnt[id]+'개 배정(이중 야간 금지)'); });

  // 5) 당일 밥교대는 기본적으로 야간 제외 — 야간 후보 부족 폴백으로만 투입되므로 별도 경고 없음.
  //    단, 야간열외(다음날 당직/상황병 등) 대상인데 야간에 들어가 있으면 경고.
  if(s.mealId){
    const mealNightEx = new Set([s.prevDutyId,s.dutyId,s.nextDutyId,s.prevSituationId,s.situationId,s.nextSituationId,...(s.nightEx||[]),...(s.bothEx||[])].filter(Boolean)).has(s.mealId);
    const inNight = Object.values(night).includes(s.mealId);
    if(mealNightEx && inNight) push('밥교대('+nameOf(s.mealId)+')가 야간 열외 대상인데 야간 번초에 배정되었습니다.');
  }

  // 6) 다음날 밥교대 == 다음날 당직/상황병 → 17:30/18:30/19:30 충돌
  if(s.nextMealId && s.nextMealId===s.nextDutyId) push('다음날 밥교대=다음날 당직: 17:30·19:30 충돌('+nameOf(s.nextMealId)+')');
  if(s.nextMealId && s.nextMealId===s.nextSituationId) push('다음날 밥교대=다음날 상황병: 17:30·18:30 충돌('+nameOf(s.nextMealId)+')');
  if(s.nextDutyId && s.nextDutyId===s.nextSituationId) push('다음날 당직=다음날 상황병: 18:30·19:30 충돌('+nameOf(s.nextDutyId)+')');
  if(s.nextMealId && s.nextMealId===s.mealId) push('다음날 밥교대=오늘 밥교대('+nameOf(s.mealId)+'): 야간 후보 부족 시 이틀 연속 야간 우려');

  // 7) 추가순찰 미배정 / 16:30·17:30 근무자와 중복
  if(!s.patrolExtra) push('17:00 추가순찰 미배정');
  else{
    if(s.patrolExtra===assign['16:30']) push('추가순찰('+nameOf(s.patrolExtra)+')이 16:30 근무자와 중복');
    if(s.patrolExtra===fixed['17:30']) push('추가순찰('+nameOf(s.patrolExtra)+')이 17:30 밥교대와 중복');
  }

  // 8) 완화칸 검토 안내 / 미배정
  if(s.relaxed && Object.keys(s.relaxed).length){
    Object.entries(s.relaxed).forEach(([sl,lab])=> push('완화 배정 검토 필요: '+sl+' ('+lab+')'));
  }
  DAY_SLOTS.forEach(sl=>{ if(!assign[sl] && !fixed[sl]) push('주간 '+sl+' 미배정'); });
  NIGHT_BUNCHO.forEach(b=>{ if(!night[b.id]) push('야간 '+b.id+'번초 미배정'); });

  // 9) 사전등록 일정과 충돌 — 표를 만든 뒤에 등록·수정된 일정도 소급 점검
  prebookOn(s.date).forEach(p=> prebookConflictsFor(p, s).forEach(push));

  return out;
}

/* 사전등록 항목 p와 생성된 표 s의 충돌 목록.
   소급 적용이 안 되는 사전등록(나중에 등록한 휴가 등)을 달력 ⚠로 드러내기 위한 점검. */
function prebookConflictsFor(p, s){
  const out=[];
  const who=nameOf(p.wid);
  if(p.kind==='duty'){
    if(s.dutyId!==p.wid) out.push('사전등록 충돌: 당직 예약('+who+')과 표의 당직('+nameOf(s.dutyId)+')이 다릅니다');
    return out;
  }
  if(p.kind==='situation'){
    if(s.situationId!==p.wid) out.push('사전등록 충돌: 상황병 예약('+who+')과 표의 상황병('+nameOf(s.situationId)+')이 다릅니다');
    return out;
  }
  // 휴가·열외: 복귀일/주간열외는 주간만, 휴가 중·모두열외는 전 슬롯 점검
  const returning = p.kind==='vacation' && s.date===p.end;
  const dayOnly = p.kind==='exday' || returning;
  const label = returning ? '휴가 복귀일(주간 열외)' : PREBOOK_KR[p.kind];
  const daySl = DAY_SLOTS.filter(sl=> (s.assign&&s.assign[sl]===p.wid)||(s.fixed&&s.fixed[sl]===p.wid));
  if(s.patrolExtra===p.wid) daySl.push('17:00순찰');
  if(daySl.length) out.push('사전등록 충돌: '+label+'('+who+')인데 주간 '+daySl.join('·')+' 배정됨');
  if(!dayOnly){
    const ev=EVENING.filter(sl=> s.fixed&&s.fixed[sl]===p.wid);
    if(ev.length) out.push('사전등록 충돌: '+label+'('+who+')인데 저녁 '+ev.join('·')+' 배정됨');
    const nb=NIGHT_BUNCHO.filter(b=> s.night&&s.night[b.id]===p.wid).map(b=>b.id+'번초');
    if(nb.length) out.push('사전등록 충돌: '+label+'('+who+')인데 야간 '+nb.join('·')+' 배정됨');
    const roles=[];
    if(s.dutyId===p.wid) roles.push('당직');
    if(s.situationId===p.wid) roles.push('상황병');
    if(s.mealId===p.wid) roles.push('밥교대');
    if(roles.length) out.push('사전등록 충돌: '+label+'('+who+')인데 '+roles.join('·')+' 역할로 지정됨');
  }
  return out;
}

/* validateSchedule 캐시판 — 달력 렌더 등 반복 호출용. save() 시 무효화됨. */
function validateScheduleCached(s){
  const hit=_validCache.get(s.date);
  if(hit) return hit;
  const v=validateSchedule(s);
  _validCache.set(s.date, v);
  return v;
}

/* ---------- 일괄 생성용 입력 빌더 ----------
   [근무표 생성] 탭이 화면에서 채우는 값(사전등록·휴무일·전날 이전)을 헤드리스로 동일하게 구성 */
function autoInputFor(ds){
  const prev=DB.schedules[addDays(ds,-1)];
  const pb=prebookOn(ds), pbNext=prebookOn(addDays(ds,1));
  const pbPick=(arr,kind)=>{ const e=arr.find(p=>p.kind===kind); return e?e.wid:null; };
  return {
    date:ds,
    workHoliday: dayGroup(ds,false)==='weekend' || isHolidayDate(ds),
    nextWorkHoliday: dayGroup(addDays(ds,1),false)==='weekend' || isHolidayDate(addDays(ds,1)),
    dutyId: pbPick(pb,'duty') || (prev?prev.nextDutyId:null) || null,
    situationId: pbPick(pb,'situation') || (prev?prev.nextSituationId:null) || null,
    nextDutyId: pbPick(pbNext,'duty')||null,
    nextSituationId: pbPick(pbNext,'situation')||null,
    nextMealId: '',                                   // 자동 배정
    mealId: (prev?prev.nextMealId:null) || null,
    prevDutyId: prev?prev.dutyId:null, prevSituationId: prev?prev.situationId:null,
    // 휴가 마지막날(복귀일)은 주간만 열외 — [근무표 생성] 탭과 동일 규칙
    dayEx: pb.filter(p=> p.kind==='exday' || (p.kind==='vacation' && ds===p.end)).map(p=>p.wid),
    nightEx: [],
    bothEx: pb.filter(p=> p.kind==='exboth' || (p.kind==='vacation' && ds<p.end)).map(p=>p.wid),
  };
}

/* 근무자가 등장하는 생성된 표 날짜 수 — 삭제 전 '보관 권장' 안내용 */
function scheduleRefCount(wid){
  return Object.values(DB.schedules).filter(s=>
    [s.dutyId,s.situationId,s.mealId,s.patrolExtra,s.nextDutyId,s.nextSituationId,s.nextMealId,s.prevDutyId,s.prevSituationId].includes(wid)
    || Object.values(s.assign||{}).includes(wid)
    || Object.values(s.night||{}).includes(wid)
    || Object.values(s.fixed||{}).includes(wid)
  ).length;
}

/* ---------- Node(테스트) 내보내기 ---------- */
if(typeof module!=='undefined' && module.exports){
  module.exports = {
    // 상태 주입
    setDB(db){ DB = db; invalidateStats(); },
    getDB(){ return DB; },
    // 상수
    DAY_SLOTS, EVENING, NIGHT_BUNCHO, SLOT_ORDER, MORNING_AFTER_NIGHT, STORE_KEY,
    DEFAULT_WEIGHTS, DEFAULT_SETTINGS, PREBOOK_KINDS, PREBOOK_KR, KR_HOLIDAYS,
    // 정규화/마이그레이션
    migrate, normWorker, normPrebook, normSched,
    // 날짜/그룹
    pad, todayStr, addDays, dow, dayGroup, nightGroup, mealGroup, latestSchedDate,
    holidayName, isHolidayDate, prebookOn,
    // 근무자
    W, nameOf, isRecruit, isNavigator, isVeteran, activeNavigator, navFixedDaySlots, navNightBalance,
    activeWorkers, inInactive, presentOn, scheduleRefCount,
    // 통계
    buildStats, invalidateStats, slotHours, rate, avgHours, stdev, cv, gini,
    // 배정
    generateDay, autoInputFor, assignMeal, mealCandidates, dayCandidates, nightCandidates, score,
    // 검증
    validateSchedule, validateScheduleCached, prebookConflictsFor
  };
}
