/* ============================================================
   배정 엔진 회귀 테스트 — node --test 로 실행
   하드 제약(인접 금지·이중 야간 금지·전날 야간자 아침 금지·열외 준수)이
   어떤 입력에서도 깨지지 않는지를 중심으로 검증한다.
   ============================================================ */
"use strict";
const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine.js');

/* 절대 허용되지 않는 위반 메시지 (완화 사다리로도 허용 안 됨)
   — '야간 연속(전날 야간 → …)'은 tier3 완화로 허용되므로 제외 */
const HARD = /인접 슬롯 연속근무|이중 야간 금지|에 배정됨\(금지\)|주간열외인데|야간\/전체열외인데|날짜경계 연속근무/;

function freshDB(over = {}) {
  return Object.assign({
    version: 2, lastBackupAt: null, workers: [], schedules: {}, prebook: [], holidays: {},
    settings: JSON.parse(JSON.stringify(E.DEFAULT_SETTINGS))
  }, over);
}
function mkWorker(name, opts = {}) {
  return E.normWorker(Object.assign({ name, roleReady: true, roleType: 'duty', canMeal: true, active: true }, opts),
    Math.floor(Math.random() * 1e6));
}
function roster(n, recruits = 0) {
  const ws = [];
  for (let i = 0; i < n; i++) ws.push(mkWorker('W' + i, { roleType: i % 2 ? 'duty' : 'situation' }));
  for (let i = 0; i < recruits; i++) ws.push(mkWorker('R' + i, { roleReady: false }));
  return ws;
}
/* 표 한 장에서 wid가 배정된 주간 슬롯 목록 */
function daySlotsOf(s, wid) {
  return E.DAY_SLOTS.filter(sl => (s.assign && s.assign[sl] === wid) || (s.fixed && s.fixed[sl] === wid));
}

/* ---------- 날짜/그룹 유틸 ---------- */
test('addDays: 월말·연말 경계', () => {
  assert.equal(E.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(E.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(E.addDays('2026-03-01', -1), '2026-02-28');
});

test('dayGroup/nightGroup/mealGroup 분류', () => {
  assert.equal(E.dayGroup('2026-06-15', false), 'mtth');   // 월
  assert.equal(E.dayGroup('2026-06-17', false), 'wed');    // 수
  assert.equal(E.dayGroup('2026-06-19', false), 'fri');    // 금
  assert.equal(E.dayGroup('2026-06-20', false), 'weekend');// 토
  assert.equal(E.dayGroup('2026-06-15', true), 'weekend'); // 휴무일 지정 시
  assert.equal(E.nightGroup('2026-06-19', false), 'holiday'); // 다음날 토요일
  assert.equal(E.nightGroup('2026-06-15', false), 'weekday');
  assert.equal(E.nightGroup('2026-06-15', true), 'holiday');  // 다음날 휴무 지정
  assert.equal(E.mealGroup('2026-06-20', false), 'weekend');
});

test('내장 공휴일이 autoInputFor의 휴무 판정에 반영된다', () => {
  E.setDB(freshDB({ workers: roster(10) }));
  const inp = E.autoInputFor('2026-08-17'); // 광복절 대체공휴일(월)
  assert.equal(inp.workHoliday, true);
});

/* ---------- 마이그레이션/정규화 ---------- */
test('migrate: 구버전(people 배열·schedules 배열) 호환', () => {
  const out = E.migrate({
    people: [{ name: '갑', roleType: 'duty' }],
    schedules: [{ date: '2026-01-05', assign: {} }],
    settings: { weights: { avgHours: 9 } }
  });
  assert.equal(out.workers.length, 1);
  assert.equal(out.workers[0].roleReady, true);
  assert.ok(out.schedules['2026-01-05']);
  assert.equal(out.settings.weights.avgHours, 9);
  assert.equal(out.settings.weights.slotRate, E.DEFAULT_WEIGHTS ? E.DEFAULT_WEIGHTS.slotRate : 5.0);
});

test('normPrebook: 필수값 누락 → null, end<start 보정', () => {
  assert.equal(E.normPrebook(null), null);
  assert.equal(E.normPrebook({ kind: 'vacation', start: '2026-01-01' }), null); // wid 없음
  const p = E.normPrebook({ kind: 'vacation', wid: 'x', start: '2026-01-10', end: '2026-01-05' });
  assert.equal(p.end, '2026-01-10');
});

/* ---------- 단일 생성: 완전 배정 + 하드 제약 ---------- */
test('generateDay: 충분한 인원이면 전 슬롯 배정 + 하드 위반 없음', () => {
  E.setDB(freshDB({ workers: roster(14) }));
  const ds = '2026-06-15';
  const s = E.generateDay(E.autoInputFor(ds));
  E.getDB().schedules[ds] = s; E.invalidateStats();
  const issues = E.validateSchedule(s);
  assert.deepEqual(issues.filter(m => HARD.test(m)), []);
  assert.deepEqual(issues.filter(m => /미배정/.test(m)), []);
  E.DAY_SLOTS.forEach(sl => assert.ok(s.assign[sl] || (s.fixed && s.fixed[sl]), sl + ' 비어 있음'));
  [1, 2, 3, 4].forEach(b => assert.ok(s.night[b], b + '번초 비어 있음'));
});

test('generateDay: 주간 열외(dayEx)·전체 열외(bothEx) 준수', () => {
  const ws = roster(14);
  E.setDB(freshDB({ workers: ws }));
  const ds = '2026-06-16';
  const inp = E.autoInputFor(ds);
  inp.dayEx = [ws[0].id];
  inp.bothEx = [ws[1].id];
  const s = E.generateDay(inp);
  assert.deepEqual(daySlotsOf(s, ws[0].id), [], '주간 열외자가 주간에 배정됨');
  assert.deepEqual(daySlotsOf(s, ws[1].id), [], '전체 열외자가 주간에 배정됨');
  assert.ok(!Object.values(s.night).includes(ws[1].id), '전체 열외자가 야간에 배정됨');
});

test('generateDay: 전날 야간자는 다음날 아침(06:30~08:30) 금지', () => {
  E.setDB(freshDB({ workers: roster(14) }));
  const d1 = '2026-06-15', d2 = '2026-06-16';
  const s1 = E.generateDay(E.autoInputFor(d1));
  E.getDB().schedules[d1] = s1; E.invalidateStats();
  const s2 = E.generateDay(E.autoInputFor(d2));
  E.getDB().schedules[d2] = s2; E.invalidateStats();
  const prevNight = Object.values(s1.night).filter(Boolean);
  E.MORNING_AFTER_NIGHT.forEach(sl => {
    assert.ok(!prevNight.includes(s2.assign[sl]), sl + '에 전날 야간자 배정됨');
  });
  assert.deepEqual(E.validateSchedule(s2).filter(m => HARD.test(m)), []);
});

/* ---------- 무작위 입력 강건성 (2-opt 포함 전 파이프라인) ---------- */
test('무작위 부대 구성 25회: 이틀 연속 생성에서 하드 제약이 절대 깨지지 않음', () => {
  for (let iter = 0; iter < 25; iter++) {
    const n = 8 + Math.floor(Math.random() * 9);          // 8~16명
    const recruits = Math.floor(Math.random() * 3);       // 0~2명
    const ws = roster(n, recruits);
    E.setDB(freshDB({ workers: ws }));
    const base = '2026-0' + (1 + Math.floor(Math.random() * 9)) + '-' + String(10 + Math.floor(Math.random() * 18));
    for (const ds of [base, E.addDays(base, 1)]) {
      const inp = E.autoInputFor(ds);
      // 무작위 열외 0~2명
      const shuffled = ws.slice().sort(() => Math.random() - 0.5);
      if (Math.random() < .5) inp.dayEx = [shuffled[0].id];
      if (Math.random() < .3) inp.bothEx = [shuffled[1].id];
      const s = E.generateDay(inp);
      E.getDB().schedules[ds] = s; E.invalidateStats();
      const hard = E.validateSchedule(s).filter(m => HARD.test(m));
      assert.deepEqual(hard, [], `iter=${iter} ds=${ds} n=${n} recruits=${recruits}: ${hard.join(' / ')}`);
      // 이중 야간 직접 확인
      const cnt = {};
      Object.values(s.night).forEach(id => { if (id) cnt[id] = (cnt[id] || 0) + 1; });
      Object.entries(cnt).forEach(([id, c]) => assert.ok(c <= 1, `iter=${iter} 이중 야간: ${id}`));
    }
  }
});

/* ---------- 넘침(인원 부족) 시 배정 순서 ---------- */
test('넘침 시 추가분은 비신병에게: 신병은 하루 2개 상한, 비신병이 2개째를 받는다', () => {
  // 비신병 8 + 신병 2 → 수요 15칸: 신병2씩+비신병1씩(밥교대 제외)으로 10칸 → 5칸 넘침.
  // 새 규칙: 넘침분은 비신병 2개째로 흡수, 신병은 3개째를 받지 않는다.
  for (let iter = 0; iter < 10; iter++) {
    const ws = [];
    for (let i = 0; i < 8; i++) ws.push(mkWorker('W' + i, { roleType: i % 2 ? 'duty' : 'situation' }));
    for (let i = 0; i < 2; i++) ws.push(mkWorker('R' + i, { roleReady: false, canMeal: false }));
    E.setDB(freshDB({ workers: ws }));
    const s = E.generateDay(E.autoInputFor('2026-06-15'));
    const cnt = {};
    [s.fixed, s.assign, s.night].forEach(m => Object.values(m || {}).forEach(id => { if (id) cnt[id] = (cnt[id] || 0) + 1; }));
    const recCnt = ws.filter(w => w.name[0] === 'R').map(w => cnt[w.id] || 0);
    const nonCnt = ws.filter(w => w.name[0] === 'W').map(w => cnt[w.id] || 0);
    recCnt.forEach(c => assert.ok(c <= 2, `iter=${iter} 신병이 ${c}개 배정됨 (상한 2)`));
    assert.ok(nonCnt.some(c => c >= 2), `iter=${iter} 넘침분이 비신병 2개째로 가지 않음: ${nonCnt.join(',')}`);
  }
});

/* ---------- 운항병 사전배정 ---------- */
function mkNav(name, opts = {}) {
  return mkWorker(name, Object.assign({ roleReady: true, roleType: 'situation', isNavigator: true }, opts));
}

test('운항병: 월~목 09:30·13:30, 금 09:30·14:30 고정 + 그 외 주간·야간 없음', () => {
  const nav = mkNav('NAV');
  const ws = [nav].concat(roster(15));
  E.setDB(freshDB({ workers: ws }));
  // 월(2026-06-15)
  const mon = E.generateDay(E.autoInputFor('2026-06-15'));
  assert.equal(mon.assign['09:30'], nav.id);
  assert.equal(mon.assign['13:30'], nav.id);
  assert.deepEqual(daySlotsOf(mon, nav.id), ['09:30', '13:30'], '운항병 월요일 고정 슬롯 이상');
  assert.ok(!Object.values(mon.night).includes(nav.id), '운항병 평일 야간 배정됨');
  // 금(2026-06-19)
  const fri = E.generateDay(E.autoInputFor('2026-06-19'));
  assert.equal(fri.assign['09:30'], nav.id);
  assert.equal(fri.assign['14:30'], nav.id);
  assert.deepEqual(daySlotsOf(fri, nav.id), ['09:30', '14:30'], '운항병 금요일 고정 슬롯 이상');
});

test('운항병이 상황병 근무를 서면 주간 고정(09:30·13:30)이 자동 제외된다', () => {
  const nav = mkNav('NAV');
  const ws = [nav].concat(roster(15));
  E.setDB(freshDB({ workers: ws }));
  const inp = E.autoInputFor('2026-06-15'); // 월
  inp.situationId = nav.id;
  const s = E.generateDay(inp);
  assert.equal(s.fixed['14:30'], nav.id, '운항병이 당일상황 고정칸(14:30)을 안 섬');
  assert.notEqual(s.assign['09:30'], nav.id);
  assert.notEqual(s.assign['13:30'], nav.id);
  assert.deepEqual(daySlotsOf(s, nav.id), ['14:30'], '운항병 상황병 시 고정이 안 빠짐');
});

test('운항병 야간: 금/토 중 매주 1회 + 금·토 횟수 균등, 그 외 야간 없음', () => {
  const nav = mkNav('NAV');
  const ws = [nav].concat(roster(15));
  E.setDB(freshDB({ workers: ws }));
  let ds = '2026-06-01'; // 월 → 56일 = 8주(금·토 8쌍)
  for (let d = 0; d < 56; d++) {
    const s = E.generateDay(E.autoInputFor(ds));
    E.getDB().schedules[ds] = s; E.invalidateStats();
    ds = E.addDays(ds, 1);
  }
  let fri = 0, sat = 0, other = 0;
  Object.keys(E.getDB().schedules).forEach(k => {
    const s = E.getDB().schedules[k];
    if (!Object.values(s.night).includes(nav.id)) return;
    const d = E.dow(k);
    if (d === 5) fri++; else if (d === 6) sat++; else other++;
  });
  assert.equal(other, 0, `운항병이 금/토 외 야간에 배정됨 (${other})`);
  assert.equal(fri + sat, 8, `운항병 야간 총 ${fri + sat}회 (기대 8 — 매주 1회)`);
  assert.ok(Math.abs(fri - sat) <= 1, `금(${fri})·토(${sat}) 야간 불균등`);
});

test('운항병: 이틀 연속 생성에서 하드 제약 위반 없음(고정+상황병 혼재)', () => {
  const nav = mkNav('NAV');
  const ws = [nav].concat(roster(13, 2));
  E.setDB(freshDB({ workers: ws }));
  let ds = '2026-06-10';
  for (let d = 0; d < 14; d++) {
    const inp = E.autoInputFor(ds);
    if (d % 3 === 0) inp.situationId = nav.id; // 가끔 운항병을 상황병으로
    const s = E.generateDay(inp);
    E.getDB().schedules[ds] = s; E.invalidateStats();
    assert.deepEqual(E.validateSchedule(s).filter(m => HARD.test(m)), [], `ds=${ds} 하드 위반`);
    ds = E.addDays(ds, 1);
  }
});

test('운항병: 토·일 주간은 일반 근무자처럼 풀에 참여할 수 있다', () => {
  const nav = mkNav('NAV');
  const ws = [nav].concat(roster(9)); // 인원을 빠듯하게 → 주말 주간에 운항병도 필요
  E.setDB(freshDB({ workers: ws }));
  const sat = '2026-06-20';
  const cands = E.dayCandidates(sat, { workHoliday: true, dayEx: [], bothEx: [], prevDutyId: null, dutyId: null, prevSituationId: null, situationId: null, mealId: null });
  assert.ok(cands.some(w => w.id === nav.id), '운항병이 주말 주간 후보에 없음');
});

test('운항병 고정 슬롯은 설정(navFixed)으로 바뀐다', () => {
  const nav = mkNav('NAV');
  const ws = [nav].concat(roster(15));
  const db = freshDB({ workers: ws });
  db.settings.navFixed = { weekday: ['10:30', '15:30'], friday: ['08:30'] };
  E.setDB(db);
  // 월: 설정한 10:30·15:30 고정
  const mon = E.generateDay(E.autoInputFor('2026-06-15'));
  assert.deepEqual(daySlotsOf(mon, nav.id), ['10:30', '15:30'], '설정한 월~목 슬롯이 반영 안 됨');
  // 금: 08:30 하나
  const fri = E.generateDay(E.autoInputFor('2026-06-19'));
  assert.deepEqual(daySlotsOf(fri, nav.id), ['08:30'], '설정한 금요일 슬롯이 반영 안 됨');
});

test('migrate: navFixed 기본값 보강 + 잘못된 슬롯 제거', () => {
  const out = E.migrate({ workers: [], settings: { navFixed: { weekday: ['09:30', '99:99'], friday: [] } } });
  assert.deepEqual(out.settings.navFixed.weekday, ['09:30'], '유효 슬롯만 남아야');
  assert.deepEqual(out.settings.navFixed.friday, [], '빈 배열 유지');
  const out2 = E.migrate({ workers: [], settings: {} });
  assert.deepEqual(out2.settings.navFixed, E.DEFAULT_SETTINGS.navFixed, '기본값 보강');
});

/* ---------- 말년 ---------- */
test('말년: 배정 메커니즘상 신병과 동일(isRecruit) + 정규화 보존', () => {
  const vet = mkWorker('VET', { roleReady: false, isVeteran: true });
  assert.equal(E.isRecruit(vet), true, '말년이 신병 취급이 아님');
  assert.equal(E.isVeteran(vet), true);
  // 넘침 상황에서 신병처럼 하루 2개 상한이 적용되는지 (말년 2명 + 비신병 8명)
  const ws = [];
  for (let i = 0; i < 8; i++) ws.push(mkWorker('W' + i, { roleType: i % 2 ? 'duty' : 'situation' }));
  for (let i = 0; i < 2; i++) ws.push(mkWorker('V' + i, { roleReady: false, isVeteran: true, canMeal: false }));
  E.setDB(freshDB({ workers: ws }));
  const s = E.generateDay(E.autoInputFor('2026-06-15'));
  const cnt = {};
  [s.fixed, s.assign, s.night].forEach(m => Object.values(m || {}).forEach(id => { if (id) cnt[id] = (cnt[id] || 0) + 1; }));
  ws.filter(w => w.name[0] === 'V').forEach(w => assert.ok((cnt[w.id] || 0) <= 2, '말년이 하루 3개 이상 배정됨'));
});

/* ---------- 야간 3일 연속 방지 ---------- */
function nightSeed(ds, nightMap, ids) {
  return { date: ds, workHoliday: false, nextWorkHoliday: false, assign: {}, night: nightMap, fixed: {},
    mealId: null, patrolExtra: null, activeIds: ids, dayEx: [], nightEx: [], bothEx: [] };
}

test('야간 3일 연속 금지: 이틀 연속 야간자는 인원이 있으면 다음날 야간에서 제외된다', () => {
  const ws = roster(14);
  const X = ws[0];
  const ids = ws.map(w => w.id);
  E.setDB(freshDB({ workers: ws }));
  // 6/13·6/14: X가 1번초 2일 연속
  E.getDB().schedules['2026-06-13'] = nightSeed('2026-06-13', { 1: X.id }, ids);
  E.getDB().schedules['2026-06-14'] = nightSeed('2026-06-14', { 1: X.id }, ids);
  E.invalidateStats();
  // 6/15: 인원 충분 → X는 3연속이 되므로 야간 제외
  const s = E.generateDay(E.autoInputFor('2026-06-15'));
  assert.ok(!Object.values(s.night).includes(X.id), '이틀 연속 야간자가 3일째 야간에 배정됨');
  assert.ok(s.tier < 4, '인원이 충분한데 3연속 완화 tier가 켜짐: tier=' + s.tier);
});

test('야간 3일 연속은 강제(tier≥4)일 때만 허용 — 장기 실행 불변식', () => {
  for (let trial = 0; trial < 3; trial++) {
    const ws = roster(9);   // 빠듯한 인원 → 2연속은 흔하게 발생
    E.setDB(freshDB({ workers: ws }));
    let ds = '2026-06-01';
    const dates = [];
    const nightOf = {};   // date -> Set(야간자)
    for (let d = 0; d < 28; d++) {
      const s = E.generateDay(E.autoInputFor(ds));
      E.getDB().schedules[ds] = s; E.invalidateStats();
      dates.push(ds);
      nightOf[ds] = new Set(Object.values(s.night).filter(Boolean));
      ds = E.addDays(ds, 1);
    }
    dates.forEach((d, i) => {
      if (i < 2) return;
      const s = E.getDB().schedules[d];
      nightOf[d].forEach(id => {
        if (nightOf[dates[i - 1]].has(id) && nightOf[dates[i - 2]].has(id)) {
          // 3연속 발생 → 반드시 강제 완화(tier≥4)여야 한다 (tier<4에서 3연속이면 버그)
          assert.ok(s.tier >= 4, `trial=${trial} ${E.nameOf(id)} 3연속 야간인데 tier=${s.tier} (강제 아님)`);
        }
      });
    });
  }
});

/* ---------- 밥교대 균등·로테이션 ---------- */
/* 통계 시딩용 최소 근무표 (mealId만 의미 있음) */
function mkMealSched(mealId, ids) {
  return { workHoliday: false, nextWorkHoliday: false, assign: {}, night: {}, fixed: {},
           mealId, patrolExtra: null, activeIds: ids, dayEx: [], nightEx: [], bothEx: [] };
}

test('밥교대: 횟수 동률이면 마지막으로 한 지 가장 오래된 사람이 들어간다', () => {
  const meals = [0, 1, 2, 3].map(i => mkWorker('M' + i));            // 밥교대 가능 4명
  const others = [0, 1, 2, 3, 4, 5, 6, 7].map(i => mkWorker('O' + i, { canMeal: false }));
  const ws = meals.concat(others);
  const ids = ws.map(w => w.id);
  E.setDB(freshDB({ workers: ws }));
  // 6/8(월)~6/11(목) 평일에 M0→M1→M2→M3 순서로 밥교대 이력 시딩 (전원 평일 1회 동률)
  ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11'].forEach((ds, i) => {
    E.getDB().schedules[ds] = mkMealSched(meals[i].id, ids);
  });
  E.invalidateStats();
  // 6/12(금·평일): 동률이므로 가장 오래 쉰 M0이 선정되어야 한다 (난수 무관, 사전식)
  const s = E.generateDay(E.autoInputFor('2026-06-12'));
  assert.equal(s.mealId, meals[0].id);
});

test('밥교대: 그룹별 카운트 분리 + 전체 횟수 균형 — 주말만 한 사람보다 0회인 사람 우선', () => {
  const m1 = mkWorker('M1'), m2 = mkWorker('M2');
  const others = [0, 1, 2, 3, 4, 5, 6, 7].map(i => mkWorker('O' + i, { canMeal: false }));
  const ws = [m1, m2].concat(others);
  const ids = ws.map(w => w.id);
  E.setDB(freshDB({ workers: ws }));
  // M1은 주말 밥교대만 2회 (6/13 토, 6/14 일)
  E.getDB().schedules['2026-06-13'] = mkMealSched(m1.id, ids);
  E.getDB().schedules['2026-06-14'] = mkMealSched(m1.id, ids);
  E.invalidateStats();
  // 6/15(월·평일): 평일 카운트는 둘 다 0 동률 → 전체 횟수(M1=2, M2=0)로 M2 선정
  const s = E.generateDay(E.autoInputFor('2026-06-15'));
  assert.equal(s.mealId, m2.id);
  // 6/20(토·주말): 주말 카운트 M1=2, M2=0 → M2 선정 (그룹별 분리 카운트)
  E.getDB().schedules['2026-06-15'] = s; E.invalidateStats();
  const s2 = E.generateDay(E.autoInputFor('2026-06-20'));
  assert.equal(s2.mealId, m2.id);
});

/* ---------- 신병 시간대 분산 ---------- */
test('신병도 시간대가 분산된다: 같은 주간 슬롯·야간 독점 금지', () => {
  const ws = roster(10, 2);
  E.setDB(freshDB({ workers: ws }));
  let ds = '2026-06-01';
  const days = 21;
  for (let d = 0; d < days; d++) {
    const s = E.generateDay(E.autoInputFor(ds));
    E.getDB().schedules[ds] = s; E.invalidateStats();
    ds = E.addDays(ds, 1);
  }
  const st = E.buildStats(null);
  ws.filter(w => w.name[0] === 'R').forEach(w => {
    const r = st[w.id];
    // 야간 독점 금지: 신병이 거의 매일 야간에 들어가면 안 됨
    assert.ok(r.nightNum <= days * 0.6, `${w.name} 야간 ${r.nightNum}/${days}회 — 야간 쏠림`);
    const cnts = Object.values(r.slotNum);
    const totalDay = cnts.reduce((a, b) => a + b, 0);
    const distinct = cnts.filter(c => c > 0).length;
    // 주간이 한두 시간대에 몰리면 안 됨: 최댓값이 본인 주간 배정의 35% 이하 + 4개 이상 슬롯 경험
    assert.ok(distinct >= 4, `${w.name} 주간 슬롯 종류 ${distinct}개 — 특정 시간대 쏠림`);
    assert.ok(Math.max(...cnts) <= Math.max(2, totalDay * 0.35),
      `${w.name} 특정 슬롯 ${Math.max(...cnts)}/${totalDay}회 집중`);
  });
});

test('신병이 이른 칸(06:30~09:30)을 독식하지 않는다: 이른칸 점유율이 전체 주간 점유율을 넘지 않고 특정 이른칸에 고박히지 않음', () => {
  // 회귀 방지: 동률(당일개수)일 때 신병 우선(rec)이 시간대 공정성보다 앞서면
  // 신병이 MRV가 먼저 푸는 이른 칸(아침/09:30)을 도맡아, 같은 신병이 매일 같은 이른 칸에
  // 고박힌다. 시간대 공정성(slotFairKey)을 rec 앞에 둔 뒤로는 이른 칸이 비신병과 고루
  // 나뉘고, 한 신병이 특정 이른 칸만 반복해 받지 않아야 한다.
  const EARLY = ['06:30', '07:30', '08:30', '09:30'];
  for (let trial = 0; trial < 3; trial++) {
    const ws = roster(9, 3);
    const recruitIds = new Set(ws.filter(w => w.name[0] === 'R').map(w => w.id));
    E.setDB(freshDB({ workers: ws }));
    let ds = '2026-06-01';
    let rEarly = 0, tEarly = 0, rDay = 0, tDay = 0;
    const perRookieEarly = {};   // rookieId -> {slot: count}
    for (let d = 0; d < 42; d++) {
      const s = E.generateDay(E.autoInputFor(ds));
      E.getDB().schedules[ds] = s; E.invalidateStats();
      E.DAY_SLOTS.forEach(sl => {
        const id = (s.assign && s.assign[sl]) || (s.fixed && s.fixed[sl]);
        if (!id) return;
        const isR = recruitIds.has(id);
        tDay++; if (isR) rDay++;
        if (EARLY.includes(sl)) {
          tEarly++;
          if (isR) { rEarly++; (perRookieEarly[id] = perRookieEarly[id] || {})[sl] = ((perRookieEarly[id] || {})[sl] || 0) + 1; }
        }
      });
      ds = E.addDays(ds, 1);
    }
    const earlyShare = rEarly / tEarly;     // 이른칸 중 신병 비율
    const overallShare = rDay / tDay;       // 전체 주간 중 신병 비율
    // 1) 신병이 '이른 칸에만' 몰리면 earlyShare 가 overallShare 를 크게 넘는다 → 독식
    assert.ok(earlyShare <= overallShare + 0.12,
      `trial=${trial} 신병 이른칸 점유 ${(earlyShare * 100).toFixed(0)}% 가 전체 점유 ${(overallShare * 100).toFixed(0)}% 를 과도하게 초과 (이른칸 독식)`);
    // 2) 비신병도 이른 칸을 충분히 가져간다
    assert.ok(earlyShare <= 0.65, `trial=${trial} 비신병 이른칸 점유율이 ${((1 - earlyShare) * 100).toFixed(0)}% 로 너무 낮음`);
    // 3) 한 신병이 특정 이른 칸(예: 09:30)에 고박히지 않는다
    Object.entries(perRookieEarly).forEach(([id, dist]) => {
      const tot = Object.values(dist).reduce((a, b) => a + b, 0);
      if (tot >= 4) {
        const mx = Math.max(...Object.values(dist));
        assert.ok(mx / tot <= 0.55,
          `trial=${trial} ${E.nameOf(id)} 가 특정 이른칸에 ${mx}/${tot}회(${(100 * mx / tot).toFixed(0)}%) 집중`);
      }
    });
  }
});

/* ---------- 06:30 순번제(로테이션) ---------- */
/* 통계 시딩용 최소 근무표 (assign만 의미 있음) */
function mkAssignSched(assign, ids) {
  return { workHoliday: false, nextWorkHoliday: false, assign, night: {}, fixed: {},
           mealId: null, patrolExtra: null, activeIds: ids, dayEx: [], nightEx: [], bothEx: [] };
}

test('06:30 순번제: 누적 06:30 횟수가 가장 적은 사람이 들어간다 (신병/비신병 무관)', () => {
  const ws = roster(12);
  ws[11].canMeal = false;               // 기대 인원이 밥교대로 빠지지 않게
  const ids = ws.map(w => w.id);
  E.setDB(freshDB({ workers: ws }));
  // 6/1~6/11: W0~W10이 06:30을 1회씩 → W11만 0회
  for (let i = 0; i <= 10; i++) {
    const ds = E.addDays('2026-06-01', i);
    E.getDB().schedules[ds] = mkAssignSched({ '06:30': ws[i].id }, ids);
  }
  E.invalidateStats();
  const s = E.generateDay(E.autoInputFor('2026-06-12'));
  assert.equal(s.assign['06:30'], ws[11].id);
});

test('06:30 순번제: 횟수 동률이면 마지막 06:30이 가장 오래된 사람이 들어간다', () => {
  const ws = roster(12);
  ws[0].canMeal = false;
  const ids = ws.map(w => w.id);
  E.setDB(freshDB({ workers: ws }));
  // 6/1~6/12: W0→W1→…→W11 순으로 06:30을 1회씩 → 전원 1회 동률, W0이 가장 오래됨
  for (let i = 0; i <= 11; i++) {
    const ds = E.addDays('2026-06-01', i);
    E.getDB().schedules[ds] = mkAssignSched({ '06:30': ws[i].id }, ids);
  }
  E.invalidateStats();
  const s = E.generateDay(E.autoInputFor('2026-06-13'));
  assert.equal(s.assign['06:30'], ws[0].id);
});

test('06:30 순번제: 1순위가 열외면 건너뛰고 다음 순번이 들어간다', () => {
  const ws = roster(12);
  ws[0].canMeal = false; ws[1].canMeal = false;
  const ids = ws.map(w => w.id);
  E.setDB(freshDB({ workers: ws }));
  for (let i = 0; i <= 11; i++) {
    const ds = E.addDays('2026-06-01', i);
    E.getDB().schedules[ds] = mkAssignSched({ '06:30': ws[i].id }, ids);
  }
  E.invalidateStats();
  const inp = E.autoInputFor('2026-06-13');
  inp.dayEx = [ws[0].id];               // 1순위(가장 오래된 W0) 주간 열외
  const s = E.generateDay(inp);
  assert.equal(s.assign['06:30'], ws[1].id);
});

test('06:30 순번제: 장기 실행 시 전원 06:30 횟수가 고르게 돈다', () => {
  const ws = roster(12, 2);             // 신병 포함해도 순번은 동일하게 돈다
  E.setDB(freshDB({ workers: ws }));
  let ds = '2026-06-01';
  for (let d = 0; d < 42; d++) {
    const s = E.generateDay(E.autoInputFor(ds));
    E.getDB().schedules[ds] = s; E.invalidateStats();
    ds = E.addDays(ds, 1);
  }
  const st = E.buildStats(null);
  const cnts = ws.map(w => st[w.id].slotNum['06:30'] || 0);
  // 42일/14명 = 평균 3회. 열외(전날 야간·밥교대 등)로 건너뛰어도 격차는 2 이내여야 순번제
  assert.ok(Math.max(...cnts) - Math.min(...cnts) <= 2,
    `06:30 횟수 격차 과다: [${cnts.join(',')}]`);
});

/* ---------- 신병 간 공평성: 개수가 갈릴 때 평균시간 많은 신병이 덜 받는다 ---------- */
test('신병 개수가 갈리는 날: 평균시간 많은 신병이 적은 개수를 받는다', () => {
  // 비신병 3 + 신병 8(=11명), 밥교대 1명 제외 → 가용 10명, 배정 16칸(슬롯 15+17:30 고정 1)
  // → 전원 1개(10칸) 후 2개째는 6칸뿐 → 신병 8명 중 2명은 1개로 남는다.
  // 평균시간(baseHours) 많은 R7은 반드시 '적게 받는 쪽'이어야 한다.
  for (let iter = 0; iter < 5; iter++) {
    const ws = [];
    for (let i = 0; i < 3; i++) ws.push(mkWorker('W' + i, { roleType: i % 2 ? 'duty' : 'situation' }));
    for (let i = 0; i < 7; i++) ws.push(mkWorker('R' + i, { roleReady: false }));
    ws.push(mkWorker('R7', { roleReady: false, baseHours: 30 }));   // 누적 평균시간 많은 신병
    E.setDB(freshDB({ workers: ws }));
    const s = E.generateDay(E.autoInputFor('2026-06-15'));
    const cnt = {};
    [s.fixed, s.assign, s.night].forEach(m => Object.values(m || {}).forEach(id => { if (id) cnt[id] = (cnt[id] || 0) + 1; }));
    const others = ws.filter(w => w.name[0] === 'R' && w.name !== 'R7').map(w => cnt[w.id] || 0);
    const r7 = cnt[ws[10].id] || 0;
    assert.ok(r7 <= Math.min(...others) && r7 < Math.max(...others),
      `iter=${iter} 평균시간 많은 신병(R7=${r7})이 다른 신병들(${others.join(',')})보다 덜 받지 않음`);
  }
});

/* ---------- 그룹별 슬롯 비율이 실제 배정에 반영 ---------- */
test('score: 같은 그룹에서 그 시간대를 많이 선 사람일수록 뒤로 밀린다', () => {
  // A·B는 전체 통계가 똑같다(06:30×2, 10:30×2, 시간·분모·그룹 횟수 동일).
  // 다른 점은 그룹 내 분포뿐: A는 수요일마다 06:30, B는 월화목에서 06:30.
  // 전체 비율만 보면 동점이라 구분이 안 되고, 그룹별 슬롯 비율을 봐야 갈린다.
  const A = mkWorker('A'), B = mkWorker('B');
  const ws = [A, B];
  const ids = ws.map(w => w.id);
  const db = freshDB({ workers: ws });
  db.settings.weights.jitter = 0;          // 난수 제거 → 점수 비교가 결정적
  E.setDB(db);
  const seed = (ds, assign) => {
    db.schedules[ds] = { date: ds, workHoliday: false, nextWorkHoliday: false, assign, night: {}, fixed: {},
                         mealId: null, patrolExtra: null, activeIds: ids, dayEx: [], nightEx: [], bothEx: [] };
  };
  seed('2026-06-01', { '06:30': B.id, '10:30': A.id }); // 월(mtth)
  seed('2026-06-02', { '06:30': B.id, '10:30': A.id }); // 화(mtth)
  seed('2026-06-03', { '06:30': A.id, '10:30': B.id }); // 수(wed)
  seed('2026-06-10', { '06:30': A.id, '10:30': B.id }); // 수(wed)
  E.invalidateStats();
  const st = E.buildStats('2026-06-17');
  const opts = g => ({ stats: st, todayHours: {}, isNight: false, dayGrp: g, nightGrp: 'weekday', bunchoId: null });
  // 수요일 06:30은 A가 독점해 왔다 → A 점수가 높아야(후순위) 한다
  assert.ok(E.score(A, '06:30', opts('wed')) > E.score(B, '06:30', opts('wed')),
    '수요일 06:30: 그룹 내 비율이 높은 A가 우선순위에서 밀리지 않음');
  // 수요일 10:30은 B가 독점 → 반대
  assert.ok(E.score(B, '10:30', opts('wed')) > E.score(A, '10:30', opts('wed')),
    '수요일 10:30: 그룹 내 비율이 높은 B가 우선순위에서 밀리지 않음');
  // 월화목 06:30은 B가 독점 → B가 후순위
  assert.ok(E.score(B, '06:30', opts('mtth')) > E.score(A, '06:30', opts('mtth')),
    '월화목 06:30: 그룹 내 비율이 높은 B가 우선순위에서 밀리지 않음');
});

test('그룹 안에서도 시간대가 분산된다: 같은 그룹 같은 슬롯 반복 제한 (8주 실행)', () => {
  // 그룹별 슬롯 비율을 배정에 안 쓰면(전체 비율만 쓰면) '수요일마다 같은 시간대' 같은
  // 그룹 내 반복이 최대 5회/평균 2.6회 수준까지 올라간다. 반영 후 기대치: 최대 3·평균 ~1.7.
  let worst = 0, sumMax = 0, n = 0;
  for (let trial = 0; trial < 3; trial++) {
    const ws = roster(12);
    E.setDB(freshDB({ workers: ws }));
    let ds = '2026-06-01';
    for (let d = 0; d < 56; d++) {
      const s = E.generateDay(E.autoInputFor(ds));
      E.getDB().schedules[ds] = s; E.invalidateStats();
      ds = E.addDays(ds, 1);
    }
    const st = E.buildStats(null);
    ws.forEach(w => {
      ['mtth', 'wed', 'fri', 'weekend'].forEach(g => {
        // 06:30은 순번제(전역 로테이션)라 그룹별 분산 대상이 아님 → 검사에서 제외
        const cnts = Object.entries(st[w.id].slotGNum[g]).filter(([sl]) => sl !== '06:30').map(([, c]) => c);
        const tot = cnts.reduce((a, b) => a + b, 0);
        if (tot >= 3) { const mx = Math.max(...cnts); worst = Math.max(worst, mx); sumMax += mx; n++; }
      });
    });
  }
  assert.ok(worst <= 4, `같은 그룹 같은 슬롯이 최대 ${worst}회 반복됨 (허용 4)`);
  assert.ok(sumMax / n <= 2.2, `그룹 내 슬롯 집중 평균 ${(sumMax / n).toFixed(2)} (허용 2.2)`);
});

/* ---------- 사전등록 충돌 검사 ---------- */
test('prebookConflictsFor: 휴가 기간에 배정된 기존 표를 충돌로 보고', () => {
  const ws = roster(12);
  E.setDB(freshDB({ workers: ws }));
  const ds = '2026-06-15';
  const s = E.generateDay(E.autoInputFor(ds));
  E.getDB().schedules[ds] = s; E.invalidateStats();
  // 그날 실제로 주간 배정된 사람을 골라 휴가(기간 중)를 소급 등록
  const victim = E.DAY_SLOTS.map(sl => s.assign[sl]).find(Boolean);
  const p = E.normPrebook({ kind: 'vacation', wid: victim, start: ds, end: E.addDays(ds, 3) });
  const confs = E.prebookConflictsFor(p, s);
  assert.ok(confs.length >= 1, '충돌이 보고되지 않음');
  assert.ok(confs.every(m => m.startsWith('사전등록 충돌')));
  // validateSchedule에도 소급 반영되는지
  E.getDB().prebook.push(p); E.invalidateStats();
  assert.ok(E.validateSchedule(s).some(m => m.startsWith('사전등록 충돌')));
});

test('prebookConflictsFor: 휴가 복귀일은 주간만 점검(야간 배정은 허용)', () => {
  const ws = roster(12);
  E.setDB(freshDB({ workers: ws }));
  const ds = '2026-06-15';
  const s = E.generateDay(E.autoInputFor(ds));
  const nightWorker = Object.values(s.night).find(Boolean);
  const p = E.normPrebook({ kind: 'vacation', wid: nightWorker, start: E.addDays(ds, -2), end: ds }); // ds=복귀일
  const confs = E.prebookConflictsFor(p, s);
  assert.ok(!confs.some(m => /야간/.test(m)), '복귀일 야간 배정이 충돌로 잘못 보고됨: ' + confs.join(' / '));
});

test('prebookConflictsFor: 당직 예약과 표의 당직이 다르면 충돌', () => {
  const ws = roster(12);
  E.setDB(freshDB({ workers: ws }));
  const ds = '2026-06-15';
  const inp = E.autoInputFor(ds);
  inp.dutyId = ws[0].id;
  const s = E.generateDay(inp);
  const p = E.normPrebook({ kind: 'duty', wid: ws[2].id, start: ds, end: ds });
  assert.ok(E.prebookConflictsFor(p, s).some(m => /당직 예약/.test(m)));
  const pOk = E.normPrebook({ kind: 'duty', wid: ws[0].id, start: ds, end: ds });
  assert.deepEqual(E.prebookConflictsFor(pOk, s), []);
});

/* ---------- 카운트 초기화(countResetAt) ---------- */
test('countResetAt: 기준일 이전 근무시간·분자·분모가 전부 0으로 잘린다 (밥교대만 유지)', () => {
  const A = mkWorker('A', { countResetAt: '2026-06-10' });
  const B = mkWorker('B');
  const ws = [A, B]; const ids = ws.map(w => w.id);
  E.setDB(freshDB({ workers: ws }));
  const seed = (ds, assign, mealId) => {
    E.getDB().schedules[ds] = { date: ds, workHoliday: false, nextWorkHoliday: false, assign, night: {}, fixed: {},
      mealId: mealId || null, patrolExtra: null, activeIds: ids, dayEx: [], nightEx: [], bothEx: [] };
  };
  // 초기화(6/10) 이전 2회 + 밥교대 1회, 이후 2회
  seed('2026-06-05', { '06:30': A.id }, A.id);   // 이전: 근무 1 + 밥교대 1
  seed('2026-06-08', { '06:30': A.id }, null);   // 이전: 근무 1
  seed('2026-06-12', { '06:30': A.id }, null);   // 이후: 근무 1
  seed('2026-06-15', { '06:30': A.id }, null);   // 이후: 근무 1
  E.invalidateStats();
  const r = E.buildStats(null)[A.id];
  assert.equal(r.hours, 2, '초기화 이전 근무시간이 남아 있음(2여야 함)');
  assert.equal(r.slotNum['06:30'], 2, '초기화 이전 슬롯 분자가 남아 있음');
  assert.equal(r.denom, 2, '초기화 이전 분모가 남아 있음');
  assert.equal(r.mealNum, 1, '밥교대 카운트는 유지되어야 함(초기화 예외)');
  assert.equal(r.mealDen >= 4, true, '밥교대 분모는 초기화 무시(전체 유지)');
});

/* ---------- 역할자 오배치 검증 ---------- */
test('validateSchedule: 당직/상황병/밥교대 본인이 근무칸에 있으면 경고 (수동편집 대비)', () => {
  const ws = roster(14);
  E.setDB(freshDB({ workers: ws }));
  const ds = '2026-06-15';
  const s = E.generateDay(E.autoInputFor(ds));
  // 정상 생성물엔 역할자 오배치 경고 없음
  assert.deepEqual(E.validateSchedule(s).filter(m => /열외 대상/.test(m)), []);
  // 수동으로 당직자를 06:30에 박아넣으면 경고가 떠야
  const duty = ws[0].id;
  s.dutyId = duty; s.assign['06:30'] = duty;
  assert.ok(E.validateSchedule(s).some(m => /당직.*06:30.*열외 대상/.test(m)), '당직자 주간 오배치가 안 잡힘');
  // 밥교대는 주간만 점검(야간 폴백 허용)
  const s2 = E.generateDay(E.autoInputFor('2026-06-16'));
  s2.mealId = ws[1].id; s2.assign['10:30'] = ws[1].id;
  assert.ok(E.validateSchedule(s2).some(m => /밥교대.*10:30.*열외 대상/.test(m)));
});

/* ---------- 통계/보조 ---------- */
test('buildStats: 생성된 표가 다음날 통계에 누적된다', () => {
  const ws = roster(12);
  E.setDB(freshDB({ workers: ws }));
  const ds = '2026-06-15';
  const s = E.generateDay(E.autoInputFor(ds));
  E.getDB().schedules[ds] = s; E.invalidateStats();
  const st = E.buildStats(E.addDays(ds, 1));
  const totalHours = ws.reduce((a, w) => a + st[w.id].hours, 0);
  assert.ok(totalHours > 0, '누적 시간이 0');
  const denomSum = ws.reduce((a, w) => a + st[w.id].denom, 0);
  assert.ok(denomSum > 0, '분모가 0');
  // 캐시: 같은 인자는 동일 객체 반환
  assert.equal(E.buildStats(E.addDays(ds, 1)), st);
});

test('scheduleRefCount: 배정·역할·고정 슬롯 등장 일수 집계', () => {
  const ws = roster(12);
  E.setDB(freshDB({ workers: ws }));
  const ds = '2026-06-15';
  const s = E.generateDay(E.autoInputFor(ds));
  E.getDB().schedules[ds] = s; E.invalidateStats();
  const someone = E.DAY_SLOTS.map(sl => s.assign[sl]).find(Boolean);
  assert.equal(E.scheduleRefCount(someone), 1);
  assert.equal(E.scheduleRefCount('없는사람'), 0);
});

test('validateScheduleCached: 같은 날짜는 캐시 재사용, invalidate 후 재계산', () => {
  const ws = roster(12);
  E.setDB(freshDB({ workers: ws }));
  const ds = '2026-06-15';
  const s = E.generateDay(E.autoInputFor(ds));
  E.getDB().schedules[ds] = s; E.invalidateStats();
  const a = E.validateScheduleCached(s);
  assert.equal(E.validateScheduleCached(s), a);   // 동일 객체 = 캐시 적중
  E.invalidateStats();
  assert.notEqual(E.validateScheduleCached(s), a); // 새로 계산
});
