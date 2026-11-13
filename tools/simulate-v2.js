/* 새 배정 시스템(v2) 시뮬레이션 — 실제 데이터는 건드리지 않는다(백업 파일을 읽어 메모리에서만 생성).
   사용: node tools/simulate-v2.js <백업.json> [일수=90]
   환경변수: SIT=이름,이름,…(상황병 명단·순번)  OUTING=평일 하루 외출 인원(기본 0)
            GAPA GAPBC GAPANY GAPH(위병조장 텀)  VERBOSE=1(사람별 표)
   휴가·열외는 과거 근무표의 실제 열외를 13주(91일) 뒤로 옮겨 재현한다. */
"use strict";
const fs = require('fs');
const E = require('../engine.js');
const file = process.argv[2], DAYS = +process.argv[3] || 90;
const env = process.env, SHIFT = 91;
const DB = E.migrate(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
E.setDB(DB);
const act = () => DB.workers.filter(w => w.active);
const sitNames = (env.SIT || '').split(',').map(s => s.trim()).filter(Boolean);
const sit = sitNames.map(n => act().find(w => w.name.includes(n))).filter(Boolean);
if (sit.length !== sitNames.length || !sit.length) { console.error('SIT 명단을 찾지 못했습니다'); process.exit(1); }
DB.workers.forEach(w => { if (sit.includes(w)) { w.roleReady = true; w.roleType = 'situation'; } else if (w.roleReady) w.roleType = 'duty'; });
const start = E.addDays(E.latestSchedDate(), 1);
const hist = DB.schedules;
E.switchToV2(start);
{ const c = E.v2cfg(), n = (v, d) => v === undefined ? d : +v;   // 지정하지 않으면 앱 기본값
  DB.settings.v2 = Object.assign(c, { gapA: n(env.GAPA, c.gapA), gapBC: n(env.GAPBC, c.gapBC), gapAny: n(env.GAPANY, c.gapAny), gapH: n(env.GAPH, c.gapH) }); }
// 과거 열외 재현: 주 단위 배식조(폐지)는 빼고, 유조차 일정은 같은 간격으로 옮긴다
const oldPb = DB.prebook;
DB.prebook = oldPb.filter(p => p.kind === 'fueltruck' || p.kind === 'fuelsub')
  .map(p => Object.assign({}, p, { id: p.id + 's', start: E.addDays(p.start, SHIFT), end: E.addDays(p.end, SHIFT) }));
function exOf(ds) {
  const src = E.addDays(ds, -SHIFT), s = hist[src] || {};
  const messWk = new Set(oldPb.filter(p => p.kind === 'mess' && src >= p.start && src <= p.end).map(p => p.wid));
  return { bothEx: (s.bothEx || []).filter(id => !messWk.has(id)), dayEx: s.dayEx || [], nightEx: s.nightEx || [], slotEx: s.slotEx || {} };
}
const dates = []; for (let i = 0; i < DAYS + 1; i++) dates.push(E.addDays(start, i));
const isHol = ds => E.dayGroup(ds, false) === 'weekend' || E.isHolidayDate(ds);
// 상황병 순번: 명단 순서대로 하루 1명, 그날·다음날 못 서는 사람은 건너뛴다
const sitOf = {}; let ptr = 0;
dates.forEach((ds, i) => {
  const off = new Set([...exOf(ds).bothEx, ...exOf(ds).dayEx]);
  for (let k = 0; k < sit.length; k++) {
    const w = sit[(ptr + k) % sit.length];
    if (!off.has(w.id) && w.id !== sitOf[dates[i - 1]]) { sitOf[ds] = w.id; ptr = (ptr + k + 1) % sit.length; break; }
  }
});
let outPtr = 0;
const made = [];
for (let i = 0; i < DAYS; i++) {
  const ds = dates[i], nds = dates[i + 1], ex = exOf(ds), nex = exOf(nds);
  const outing = [];
  if (+env.OUTING && !isHol(ds)) {
    const off = new Set([...ex.bothEx, ...ex.dayEx, sitOf[ds], sitOf[dates[i - 1]]]);
    const ws = act();
    for (let k = 0; k < ws.length && outing.length < +env.OUTING; k++) { const w = ws[(outPtr + k) % ws.length]; if (!off.has(w.id)) outing.push(w.id); }
    outPtr = (outPtr + (+env.OUTING)) % ws.length;
  }
  const s = E.generateDay2(Object.assign({ date: ds, workHoliday: isHol(ds), nextWorkHoliday: isHol(nds),
    situationId: sitOf[ds], nextSituationId: sitOf[nds], outing, nextOff: [...nex.bothEx, ...nex.dayEx] }, ex));
  DB.schedules[ds] = s; E.invalidateStats(); made.push(s);
}

/* ---------- 보고 ---------- */
const st = E.buildStats2(null), f = (x, n = 2) => (+x).toFixed(n);
const sd = a => E.stdev(a), mm = a => a.length ? f(Math.min(...a)) + '~' + f(Math.max(...a)) : '-';
let hard = [], softCnt = {}, tiers = {}, perDayMax = {};
made.forEach(s => {
  const v = E.validateSchedule2(s);
  v.hard.forEach(m => hard.push(s.date + ' ' + m));
  v.soft.forEach(m => { const k = m.replace(/^.*: /, '').replace(/\d\d:\d\d |\d번초 /, ''); softCnt[k] = (softCnt[k] || 0) + 1; });
  tiers[s.tier] = (tiers[s.tier] || 0) + 1;
  const c = {}; [...Object.values(s.assign), ...Object.values(s.fixed), ...Object.values(s.night), s.patrolExtra].forEach(id => { if (id) c[id] = (c[id] || 0) + 1; });
  const mx = Math.max(0, ...Object.values(c)); perDayMax[mx] = (perDayMax[mx] || 0) + 1;
  if (env.VERBOSE && mx >= 4) console.log('  [하루 ' + mx + '칸]', s.date, '주간·저녁·야간 후보 외 인원:', act().length - new Set([...Object.values(s.assign), ...Object.values(s.fixed), ...Object.values(s.night)].filter(Boolean)).size, '명 / 근무 인원', Object.keys(c).length);
});
console.log(`기간 ${start} ~ ${dates[DAYS - 1]} (${DAYS}일) · 활성 ${act().length}명 (상황병 ${sit.length} · 일반병 ${act().filter(E.isGeneralW).length} · 신병 ${act().filter(w => !w.roleReady).length})`);
console.log('텀 설정', JSON.stringify(E.v2cfg()), '외출/평일', +env.OUTING || 0);
console.log('하드 위반', hard.length); hard.slice(0, 15).forEach(m => console.log('  ' + m));
console.log('완화·미배정(건수)', softCnt);
console.log('완화 단계(tier)별 일수', tiers, '· 하루 최다 근무 칸수별 일수', perDayMax);
const gen = act().filter(E.isGeneralW), all = act();
const pAvg = all.filter(w => st[w.id].pDen > 0).map(w => st[w.id].pHours / st[w.id].pDen);
console.log(`개인정비 CCTV 시간/대상일: ${mm(pAvg)} (표준편차 ${f(sd(pAvg), 3)})`);
['A', 'BC', 'H'].forEach(g => { const a = gen.map(w => st[w.id].gate[g].num); console.log(`위병조장 ${g} 횟수: ${mm(a)} (표준편차 ${f(sd(a))})`); });
// 위병조장 간격
const gaps = { any: [], A: [], BC: [] }, lastG = {};
made.forEach(s => Object.entries(s.gate).forEach(([k, id]) => {
  if (!id) return; const g = k === 'A' ? 'A' : k === 'H' ? 'H' : 'BC', L = lastG[id] = lastG[id] || {};
  const dd = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
  if (L.any) gaps.any.push(dd(L.any, s.date)); if (L[g] && gaps[g]) gaps[g].push(dd(L[g], s.date));
  L.any = s.date; L[g] = s.date;
}));
Object.entries(gaps).forEach(([k, a]) => { const h = {}; a.forEach(x => { const b = x >= 8 ? '8+' : x; h[b] = (h[b] || 0) + 1; }); console.log(`위병조장 간격(${k}) 분포[일:건수]`, h, '평균', f(a.reduce((x, y) => x + y, 0) / a.length, 1)); });
['weekday', 'sat', 'sun'].forEach(g => { const ws = all.filter(w => w.canXmess); const a = ws.map(w => st[w.id].messNum[g]); console.log(`배식조 ${g} 횟수: ${mm(a)} (표준편차 ${f(sd(a))})`); });
const cls = w => E.isSituationW(w) ? '상황' : E.isGeneralW(w) ? '일반' : '신병';
['상황', '일반', '신병'].forEach(c => { const ws = all.filter(w => cls(w) === c && st[w.id].denom > 0); if (!ws.length) return;
  console.log(`[${c}] 평균근무시간/일 ${mm(ws.map(w => E.avgHours(st[w.id])))} · 야간/대상일 ${mm(ws.map(w => st[w.id].nightNum / st[w.id].nightDen))} · CCTV칸/대상일 ${mm(ws.map(w => (Object.values(st[w.id].slotNum).reduce((a, b) => a + b, 0) + st[w.id].nightNum) / st[w.id].denom))}`); });
if (env.VERBOSE) {
  console.log('이름\t구분\t대상일\t평균h\t개인정비h/일\tA\tBC\tH\t배식(평/토/일)\t야간\t상황');
  all.forEach(w => { const r = st[w.id]; console.log([w.name, cls(w), r.denom, f(E.avgHours(r)), r.pDen ? f(r.pHours / r.pDen, 3) : '-', r.gate.A.num, r.gate.BC.num, r.gate.H.num,
    [r.messNum.weekday, r.messNum.sat, r.messNum.sun].join('/'), r.nightNum, r.sitCnt].join('\t')); });
}
