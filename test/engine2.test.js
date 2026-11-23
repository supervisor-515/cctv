/* 새 배정 시스템(v2) 회귀 테스트 — 전환 전에는 앱에서 쓰이지 않는 경로 */
"use strict";
const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine.js');

function setup(nSit = 7, nGen = 14, nRec = 0, start = '2027-03-01') {
  const ws = [];
  const mk = (id, o) => ws.push(E.normWorker(Object.assign({ id, name: id, active: true, canXmess: true }, o), ws.length));
  for (let i = 0; i < nSit; i++) mk('s' + i, { roleReady: true, roleType: 'situation' });
  for (let i = 0; i < nGen; i++) mk('g' + i, { roleReady: true, roleType: 'duty' });
  for (let i = 0; i < nRec; i++) mk('r' + i, { roleReady: false });
  const db = { version: 2, workers: ws, schedules: {}, prebook: [], holidays: {}, settings: JSON.parse(JSON.stringify(E.DEFAULT_SETTINGS)) };
  E.setDB(db); E.switchToV2(start);
  return db;
}
const isHol = ds => E.dayGroup(ds, false) === 'weekend' || E.isHolidayDate(ds);
/* days일 연속 생성. off(ds) → 그날 전체 열외 id 목록, outing(ds) → 외출자 */
function runDays(db, start, days, off = () => [], outing = () => []) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const ds = E.addDays(start, i), nds = E.addDays(ds, 1);
    const sit = k => 's' + (((k % 7) + 7) % 7);
    const s = E.generateDay2({ date: ds, workHoliday: isHol(ds), nextWorkHoliday: isHol(nds),
      situationId: sit(i), nextSituationId: sit(i + 1), bothEx: off(ds), nextOff: off(nds), outing: outing(ds) });
    db.schedules[ds] = s; E.invalidateStats(); out.push(s);
  }
  return out;
}
const holders = s => [...Object.values(s.assign), ...Object.values(s.fixed), ...Object.values(s.night), s.patrolExtra].filter(Boolean);

test('v2: 60일 연속 생성 — 하드 위반 없음, 미배정 없음', () => {
  const db = setup();
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const offMap = {};
  const off = ds => offMap[ds] || (offMap[ds] = db.workers.filter(w => !/^s/.test(w.id) && rnd() < 0.12).map(w => w.id));
  runDays(db, '2027-03-01', 60, off).forEach(s => {
    const v = E.validateSchedule2(s);
    assert.deepStrictEqual(v.hard, [], s.date + ' ' + v.hard.join(' / '));
    assert.ok(!v.soft.some(m => /미배정/.test(m)), s.date + ' ' + v.soft.join(' / '));
  });
});

test('v2: 평일은 위병조장 A·B(일반병 2명), 토·일·휴일은 1명 / 배식조 매일 2명 / 당직·고정칸 없음', () => {
  const db = setup();
  runDays(db, '2027-03-01', 14).forEach(s => {
    const g = Object.values(s.gate);
    if (isHol(s.date)) assert.deepStrictEqual(Object.keys(s.gate), ['H']);
    else { assert.deepStrictEqual(Object.keys(s.gate).sort(), ['A', 'B']); assert.strictEqual(new Set(g).size, 2); }
    g.forEach(id => assert.match(id, /^g/));
    assert.strictEqual(s.messIds.length, 2);
    assert.ok(!s.messIds.some(id => g.includes(id)));
    assert.strictEqual(s.dutyId, undefined);
    E.EVENING.forEach(sl => assert.ok(s.fixed[sl], s.date + ' ' + sl));
  });
});

test('v2: 상황병은 전날 야간·당일·다음날 전부 면제, 위병조장은 당일 주간·저녁 제외', () => {
  const db = setup();
  const all = runDays(db, '2027-03-01', 21);
  all.forEach((s, i) => {
    const h = holders(s);
    const wk = E.dayGroup(s.date, s.workHoliday) !== 'weekend';
    assert.ok(!h.filter((id, k) => !(wk && s.assign['10:30'] === id && k === E.DAY_SLOTS.indexOf('10:30'))).includes(s.situationId), s.date + ' 당일 상황병(10:30 고정 외)');
    if (i > 0) assert.ok(!h.includes(all[i - 1].situationId), s.date + ' 전날 상황병');
    assert.ok(!Object.values(s.night).includes(s.nextSituationId), s.date + ' 다음날 상황병 야간');
    const de = [...Object.values(s.assign), ...Object.values(s.fixed)];
    Object.values(s.gate).forEach(id => assert.ok(!de.includes(id)));
    s.messIds.forEach(id => assert.ok(!h.includes(id)));
    assert.ok(!Object.values(s.night).includes(s.gate.A));
  });
});

test('v2: 외출자는 평일 저녁 칸(금요일은 15:30부터)과 위병조장A에 들어가지 않는다', () => {
  const db = setup();
  const outing = ds => ['g0', 'g1', 'g2', 'g3'];
  runDays(db, '2027-03-01', 12, () => [], outing).forEach(s => {
    if (isHol(s.date)) { assert.deepStrictEqual(s.outing, []); return; }
    E.outingSlots(s.date).forEach(sl => {
      const id = E.DAY_SLOTS.includes(sl) ? s.assign[sl] : s.fixed[sl];
      assert.ok(!s.outing.includes(id), s.date + ' ' + sl);
    });
    assert.ok(!s.outing.includes(s.gate.A));
    assert.deepStrictEqual(E.validateSchedule2(s).hard, []);
  });
});

test('v2: 개인정비 CCTV 시간 — 월~목 17:30 1h·20:30 0.5h, 금 15:30 0.5h·17:30 1.5h·추가순찰 0.5h, 주말 0', () => {
  assert.deepStrictEqual(E.pHoursMap('2027-03-01', false), { '17:30': 1, '18:30': 1, '19:30': 1, '20:30': 0.5 });   // 월
  assert.deepStrictEqual(E.pHoursMap('2027-03-05', false), { '15:30': 0.5, '16:30': 1, '17:30': 1.5, '18:30': 1, '19:30': 1, '20:30': 0.5, P: 0.5 });   // 금
  assert.deepStrictEqual(E.pHoursMap('2027-03-06', true), {});
  assert.deepStrictEqual(E.pHoursMap('2027-03-03', true), {});   // 평일이어도 휴무면 0
  const db = setup();
  const all = runDays(db, '2027-03-01', 5);   // 월~금
  const st = E.buildStats2(null), want = {};
  all.forEach(s => { const pm = E.pHoursMap(s.date, s.workHoliday);
    Object.entries(pm).forEach(([sl, h]) => { const id = sl === 'P' ? s.patrolExtra : E.DAY_SLOTS.includes(sl) ? s.assign[sl] : s.fixed[sl]; if (id) want[id] = (want[id] || 0) + h; });
    if (Object.keys(pm).length) { if (s.gate.A) want[s.gate.A] = (want[s.gate.A] || 0) + (E.dow(s.date) === 5 ? 1.5 : 1);   // 위병조장A: 월~목 1h, 금 1.5h 침해
      s.messIds.forEach(id => { want[id] = (want[id] || 0) + 1; }); } });   // 배식조: 1h
  db.workers.forEach(w => assert.strictEqual(st[w.id].pHours, want[w.id] || 0, w.id));
});

test('v2: 개인정비 시간이 사람마다 고르게 돈다(90일, 대상일당 편차 작음)', () => {
  const db = setup();
  runDays(db, '2027-03-01', 90);
  const st = E.buildStats2(null);
  const a = db.workers.filter(E.isGeneralW).map(w => st[w.id].pHours / st[w.id].pDen);   // 상황병은 개인정비 칸 순번에서 빠진다
  assert.ok(Math.max(...a) - Math.min(...a) < 0.08, 'range ' + (Math.max(...a) - Math.min(...a)));
  const A = db.workers.filter(E.isGeneralW).map(w => st[w.id].gate.A.num);
  assert.ok(Math.max(...A) - Math.min(...A) <= 1, 'A ' + A.join(','));
});

test('v2: 전환 당일 — 전날(구 방식) 표의 야간자 아침 금지·전날 당직/상황병 면제만 이어받는다', () => {
  const db = setup(7, 14, 0, '2027-03-02');
  db.schedules['2027-03-01'] = E.normSched({ date: '2027-03-01', dutyId: 'g0', situationId: 's6', nextSituationId: 's0', nextMealId: 'g5',
    night: { 1: 'g1', 2: 'g2', 3: 'g3', 4: 'g4' }, fixed: { '17:30': 'g5' } });
  const s = E.generateDay2({ date: '2027-03-02', nextSituationId: 's1' });
  assert.strictEqual(s.situationId, 's0');
  const h = holders(s);
  ['g0', 's6'].forEach(id => assert.ok(!h.includes(id), id));
  assert.deepStrictEqual(h.filter(id => id === 's0').length, s.assign['10:30'] === 's0' ? 1 : 0);   // 당일 야간 상황병은 10:30 고정만
  ['06:30', '07:30', '08:30'].forEach(sl => assert.ok(!['g1', 'g2', 'g3', 'g4'].includes(s.assign[sl])));
  ['A', 'B'].forEach(k => assert.ok(!['g1', 'g2', 'g3', 'g4'].includes(s.gate[k])));
  assert.deepStrictEqual(E.validateSchedule2(s).hard, []);
  // 통계는 전환일 이후 v2 표만 센다
  db.schedules['2027-03-02'] = s; E.invalidateStats();
  assert.strictEqual(E.buildStats2(null)['g1'].nightNum, Object.values(s.night).includes('g1') ? 1 : 0);
});

test('v2: 신병은 위병조장 대상이 아니다', () => {
  const db = setup(7, 12, 3);
  runDays(db, '2027-03-01', 14).forEach(s => Object.values(s.gate).forEach(id => assert.match(id, /^g/)));
});

test('v2 연결부: 저장 형식 보존·통계 전환·검증·배정 이유·편집 키', () => {
  const db = setup();
  const all = runDays(db, '2027-03-01', 10);
  // 저장/불러오기(migrate → normSched)를 거쳐도 v2 필드가 남는다
  const back = E.migrate(JSON.parse(JSON.stringify(db)));
  const a = all[3], b = back.schedules[a.date];
  ['v2', 'gate', 'nextGate', 'messIds', 'nextMessIds', 'outing', 'fixed', 'assign', 'night'].forEach(k => assert.deepStrictEqual(b[k], a[k], k));
  assert.strictEqual(back.settings.v2.since, '2027-03-01');
  // 전환 후 buildStats는 v2 통계
  assert.strictEqual(E.buildStats(null), E.buildStats2(null));
  assert.ok(E.buildStats(null, '2027-03')['g0'].denom > 0);
  all.forEach(s => {
    assert.ok(Array.isArray(E.validateSchedule(s)));
    E.SCHED_KEYS.forEach(k => { const x = E.explainAssignment(s, k); assert.ok(x && Array.isArray(x.lines) && x.lines.length, s.date + ' ' + k); });
    const h = E.schedHoursByWorker(s);
    Object.entries(s.gate).forEach(([k, id]) => assert.ok(h[id] >= E.v2GateHours(k, s.date)));
    assert.ok(E.personalKeys(s, s.gate.A || s.gate.H).some(k => /^R:gate/.test(k)));
    assert.ok(E.personalKeys(s, s.messIds[0]).includes('R:mess'));
  });
  // 편집 키
  const t = JSON.parse(JSON.stringify(a));
  E.schedKeySet(t, 'gateA', 'g9'); assert.strictEqual(E.schedKeyGet(t, 'gateA'), 'g9');
  E.schedKeySet(t, 'mess1', 'g8'); assert.strictEqual(E.schedKeyGet(t, 'mess1'), 'g8');
  E.schedKeySet(t, 'mess0', null); assert.deepStrictEqual(t.messIds, ['g8']);
  E.schedKeySet(t, 'E:20:30', 'g7'); assert.strictEqual(t.fixed['20:30'], 'g7');
  // 일괄 생성 입력
  db.prebook.push(E.normPrebook({ kind: 'vacation', wid: 'g3', start: '2027-03-11', end: '2027-03-13' }));
  db.prebook.push(E.normPrebook({ kind: 'situation', wid: 's2', start: '2027-03-11' }));
  const inp = E.autoInputFor('2027-03-11');
  assert.strictEqual(inp.situationId, 's2'); assert.deepStrictEqual(inp.bothEx, ['g3']);
  const s = E.generateDay2(inp);
  assert.ok(!E.validateSchedule(s).some(m => /사전등록 충돌/.test(m)));
});

test('v2: 평일과 주말·휴일 카운트 분리, 야간 번초 2시간', () => {
  const db = setup();
  const all = runDays(db, '2027-03-01', 28);
  const wd = E.buildStats2(null, null, 'wd'), we = E.buildStats2(null, null, 'we'), al = E.buildStats2(null);
  db.workers.forEach(w => {
    assert.strictEqual(wd[w.id].denom + we[w.id].denom, al[w.id].denom);
    assert.strictEqual(wd[w.id].hours + we[w.id].hours, al[w.id].hours);
    assert.strictEqual(we[w.id].pHours, 0);
    assert.strictEqual(wd[w.id].gate.H.num, 0); assert.strictEqual(we[w.id].gate.A.num, 0);
  });
  // 야간 2시간: 표 한 장의 시간 합 = 주간 11 + 07:30 가산 0.5 + 저녁 5 + 17:30 가산 0.5 + 순찰 0.5 + 야간 4×2 + 위병조장
  const s = all[0], h = E.schedHoursByWorker(s);
  const gateH = Object.keys(s.gate).reduce((a, k) => a + E.v2GateHours(k, s.date), 0), messH = s.messIds.length * E.v2MessHours(s.date);
  assert.strictEqual(Object.values(h).reduce((a, b) => a + b, 0), 11 + 0.5 + 5 + 0.5 + 0.5 + 8 + gateH + messH);
  assert.ok(h[s.night[1]] >= 2);
  // 주말 근무표를 만들 때는 평일 기록이 순위에 영향을 주지 않는다: 평일 표를 바꿔도 주말 표는 같게 나온다
  const sat = all.find(x => x.date === '2027-03-20');
  const input = { date: sat.date, workHoliday: true, nextWorkHoliday: true, situationId: sat.situationId, nextSituationId: sat.nextSituationId,
    gate: sat.gate, nextGate: sat.nextGate, messIds: sat.messIds, nextMessIds: sat.nextMessIds };
  const a = E.generateDay2(input);
  ['2027-03-15', '2027-03-16', '2027-03-17', '2027-03-18'].forEach(d => { const t = db.schedules[d]; E.DAY_SLOTS.forEach((sl, i) => { t.assign[sl] = 'g' + (i % 3); }); });
  E.invalidateStats();
  const b = E.generateDay2(input);
  assert.deepStrictEqual(b.assign, a.assign); assert.deepStrictEqual(b.fixed, a.fixed);
});

test('v2: 상황병은 개인정비 칸(평일 17:30~19:30, 금 16:30 포함)과 금요일 추가순찰에 들어가지 않는다', () => {
  const db = setup();
  runDays(db, '2027-03-01', 40).forEach(s => {
    E.pStrictSlots(s.date, s.workHoliday).forEach(sl => {
      const id = E.DAY_SLOTS.includes(sl) ? s.assign[sl] : s.fixed[sl];
      assert.ok(id && /^g/.test(id), s.date + ' ' + sl + ' ' + id);
    });
    if (E.pHoursMap(s.date, s.workHoliday).P) assert.ok(!/^s/.test(s.patrolExtra || ''), s.date + ' 순찰');
    assert.ok(!E.validateSchedule2(s).soft.some(m => /상황병인데/.test(m)));
  });
  // 30분만 겹치는 20:30에는 상황병도 들어간다
  assert.ok(Object.values(db.schedules).some(s => /^s/.test(s.fixed['20:30'] || '')));
});

test('v2: 배식조 시간(토 2h, 그 외 3h)은 평균 근무시간에 들어가고, 그날은 근무일로 센다', () => {
  assert.strictEqual(E.v2MessHours('2027-03-06'), 2);   // 토
  assert.strictEqual(E.v2MessHours('2027-03-07'), 3);   // 일
  assert.strictEqual(E.v2MessHours('2027-03-03'), 3);   // 수
  const db = setup();
  const all = runDays(db, '2027-03-01', 14);
  const st = E.buildStats2(null);
  const want = {}, days = {};
  all.forEach(s => { Object.entries(E.schedHoursByWorker(s)).forEach(([id, h]) => { want[id] = (want[id] || 0) + h; });
    s.messIds.forEach(id => { days[id] = (days[id] || 0) + 1; }); });
  db.workers.forEach(w => assert.strictEqual(st[w.id].hours, want[w.id] || 0, w.id));
  const id = Object.keys(days)[0], s0 = all.find(s => s.messIds.includes(id));
  assert.ok(E.presentOn(E.W(id), s0.date, s0));
  assert.ok(E.schedHoursByWorker(s0)[id] >= E.v2MessHours(s0.date));
});

/* ---------- 카운트 초기화(신병→일반병 전환) ---------- */
test('v2: 카운트 초기화 — 기준일 이전 CCTV 횟수·분모·근무시간·위병조장 분모는 0, 06:30·마지막 근무일·배식조·개인정비 순번은 유지', () => {
  const db = setup(7, 14, 3);
  runDays(db, '2027-03-01', 28);
  const before = E.buildStats2(null)['r0'];
  Object.assign(db.workers.find(w => w.id === 'r0'), { roleReady: true, roleType: 'duty', countResetAt: '2027-03-29' }); E.invalidateStats();
  const r = E.buildStats2(null)['r0'];
  assert.ok(before.hours > 0 && before.denom > 0 && before.nightNum + Object.values(before.slotNum).reduce((a, b) => a + b, 0) > 0);
  assert.strictEqual(r.hours, 0); assert.strictEqual(r.denom, 0); assert.strictEqual(r.slotDen, 0); assert.strictEqual(r.nightDen, 0);
  assert.strictEqual(r.nightNum, 0); assert.strictEqual(r.patrolNum, 0);
  assert.strictEqual(Object.values(r.slotNum).reduce((a, b) => a + b, 0), 0);
  ['rotAllNum', 'rotAllDen', 'pHours', 'pDen'].forEach(k => assert.strictEqual(r[k], before[k], k));
  assert.deepStrictEqual(r.messNum, before.messNum); assert.deepStrictEqual(r.messDen, before.messDen);
  assert.deepStrictEqual(r.tieDay, before.tieDay); assert.deepStrictEqual(r.tieNight, before.tieNight);
  ['A', 'B', 'H'].forEach(g => assert.strictEqual(r.gate[g].den, 0, '위병조장 분모 ' + g));
});

test('v2: 신병→일반병 전환 후 같은 기간 일반병과 비슷하게 받는다(신병 시절 많이 선 시간을 갚지 않음)', () => {
  const db = setup(7, 9, 5);   // 신병이 일반병보다 하루 근무시간이 많은 구성
  runDays(db, '2027-03-01', 120);
  const conv = '2027-06-29', end = '2027-08-27';
  const r0 = db.workers.find(w => w.id === 'r0'); r0.roleReady = true; r0.roleType = 'duty'; r0.countResetAt = conv; E.invalidateStats();
  runDays(db, conv, 60);
  const st = E.buildStats2(null, { from: conv, to: end });
  const avg = id => st[id].hours / st[id].denom;
  const gen = db.workers.filter(w => /^g/.test(w.id)).map(w => avg(w.id));
  const ratio = avg('r0') / (gen.reduce((a, b) => a + b, 0) / gen.length);
  // 위병조장: 신병 시절이 '설 수 있었는데 안 선 날'로 소급되면 전환 후 계속 몰아받는다(수정 전 1.3배 안팎)
  const gc = id => { const g = st[id].gate; return (g.A.num + g.B.num + g.H.num) / st[id].denom; };
  const gAvg = db.workers.filter(w => /^g/.test(w.id)).map(w => gc(w.id)).reduce((a, b) => a + b, 0) / 9;
  // 초기화가 없으면 신병 시절 기록 때문에 0.95 안팎까지 떨어진다
  // 위병조장 1회가 4.5~6h 덩어리라 1회 차이로도 평균이 4% 안팎 움직인다(위병조장 횟수 자체는 아래에서 종류별로 확인)
  assert.ok(ratio > 0.975 && ratio < 1.08, '전환자 ÷ 일반병 = ' + ratio.toFixed(3));
  assert.ok(gc('r0') / gAvg < 1.25, '위병조장 전환자 ÷ 일반병 = ' + (gc('r0') / gAvg).toFixed(3));
  // 평일 위병조장이 하루 2명이라 1회 차이도 10% 넘게 보인다 — 종류별로 일반병 최다 횟수를 넘지 않으면 된다
  ['A', 'B', 'H'].forEach(k => assert.ok(st.r0.gate[k].num <= Math.max(...db.workers.filter(w => /^g/.test(w.id)).map(w => st[w.id].gate[k].num)), '전환자 위병조장' + k));
});

test('nightPool: 야간 후보 티어 — 실제 야간 근무자는 후보에 있고, 제외 사유가 엔진 규칙과 맞다', () => {
  const db = setup();
  const all = runDays(db, '2027-03-01', 21);
  all.forEach((s, i) => {
    const P = E.nightPool(s), ids = P.tiers.flatMap(t => t.list.map(e => e.id)), bl = P.blocked.map(b => b.id);
    assert.ok(Object.values(s.night).every(id => ids.includes(id)), s.date);
    assert.ok(P.tiers.flatMap(t => t.list).filter(e => e.on).length === Object.values(s.night).filter(Boolean).length);
    assert.ok(bl.includes(s.situationId) && bl.includes(s.nextSituationId));
    s.messIds.concat(s.nextMessIds).forEach(id => assert.ok(bl.includes(id) || Object.values(s.night).includes(id)));
    const tierOf = id => (P.tiers.find(t => t.list.some(e => e.id === id)) || {}).key;
    Object.values(s.gate).forEach(id => { if (ids.includes(id)) assert.strictEqual(tierOf(id), 'gate', s.date); });
    if (!isHol(s.date)) assert.strictEqual(P.tiers[P.tiers.length - 1].key, 'gate');   // 평일 위병조장은 맨 마지막 티어
    if (i > 0) Object.values(all[i - 1].night).forEach(id => { if (ids.includes(id)) assert.ok(['c2', 'c3'].includes(P.tiers.find(t => t.list.some(e => e.id === id)).key)); });
    assert.strictEqual(new Set(ids.concat(bl)).size, ids.length + bl.length);   // 한 사람은 한 곳에만
  });
});

test('mealForecast: 실제 데이터는 그대로 두고, 예상 순번이 실제로 근무표를 만들었을 때와 같다', () => {
  // 지금 체계(v1)
  const ws = []; for (let i = 0; i < 16; i++) ws.push(E.normWorker({ id: 'm' + i, name: 'm' + i, roleReady: true, roleType: i % 2 ? 'duty' : 'situation', canMeal: true, active: true }, i));
  const db = { version: 2, workers: ws, schedules: {}, prebook: [], holidays: {}, settings: JSON.parse(JSON.stringify(E.DEFAULT_SETTINGS)) };
  E.setDB(db);
  for (let i = 0; i < 5; i++) { const d = E.addDays('2027-03-01', i); db.schedules[d] = E.generateDay(E.autoInputFor(d)); E.invalidateStats(); }
  const before = JSON.stringify(db);
  const F = E.mealForecast('2027-03-04', 7);
  assert.strictEqual(JSON.stringify(E.getDB()), before);
  assert.deepStrictEqual(F.map(x => x.state), ['fixed', 'fixed', 'next', 'guess', 'guess', 'guess', 'guess']);
  assert.strictEqual(F[2].list[0].id, db.schedules['2027-03-05'].nextMealId);
  for (let i = 5; i < 10; i++) { const d = E.addDays('2027-03-01', i); db.schedules[d] = E.generateDay(E.autoInputFor(d)); E.invalidateStats(); }
  F.forEach(x => assert.strictEqual(x.list[0].id, db.schedules[x.date].mealId, x.date));
  // 새 체계(v2)
  const db2 = setup();
  runDays(db2, '2027-03-01', 3);
  const b2 = JSON.stringify(db2), F2 = E.mealForecast('2027-03-03', 7);
  assert.strictEqual(JSON.stringify(E.getDB()), b2);
  for (let i = 3; i < 10; i++) { const d = E.addDays('2027-03-01', i); db2.schedules[d] = E.generateDay2(E.autoInputFor(d)); E.invalidateStats(); }
  F2.forEach(x => assert.deepStrictEqual(x.list.map(e => e.k + e.id), Object.keys(db2.schedules[x.date].gate).filter(k => 'ABCH'.includes(k)).sort((a, b) => 'ABCH'.indexOf(a) - 'ABCH'.indexOf(b)).map(k => k + db2.schedules[x.date].gate[k]), x.date));
});

test('v2 운항병: 평일 주간은 고정칸만, 야간은 금·토 중 주 1회, 위병조장 없음, 배식조는 주말·휴일만', () => {
  const db = setup();
  const nav = db.workers.find(w => w.id === 'g5'); nav.isNavigator = true;
  E.invalidateStats();
  const all = runDays(db, '2027-03-01', 56);
  let fixedDays = 0, eve = 0;
  all.forEach(s => {
    const wk = E.dayGroup(s.date, s.workHoliday) !== 'weekend', fx = E.navFixedDaySlots(s.date, s.workHoliday);
    if (wk) E.DAY_SLOTS.forEach(sl => { if (s.assign[sl] === 'g5') assert.ok(fx.includes(sl), s.date + ' ' + sl); });
    if (wk && fx.every(sl => s.assign[sl] === 'g5')) fixedDays++;
    if (Object.values(s.night).includes('g5')) assert.ok([5, 6].includes(E.dow(s.date)), s.date + ' 야간');
    assert.ok(!Object.values(s.gate).includes('g5') && !Object.values(s.nextGate).includes('g5'), s.date + ' 위병조장');
    if (wk) assert.ok(!s.messIds.includes('g5'), s.date + ' 평일 배식조');
    if (E.EVENING.some(sl => s.fixed[sl] === 'g5')) eve++;
    assert.deepStrictEqual(E.validateSchedule2(s).hard, [], s.date);
    assert.ok(!E.validateSchedule2(s).soft.some(m => /운항병인데/.test(m)), s.date);
  });
  // 주 단위로 금·토 야간 1회까지
  for (let w = 0; w < 8; w++) { const fri = E.addDays('2027-03-05', 7 * w), sat = E.addDays(fri, 1);
    assert.ok([fri, sat].filter(d => Object.values(db.schedules[d].night).includes('g5')).length <= 1, fri); }
  assert.ok(fixedDays >= 20, 'fixed ' + fixedDays);
  assert.ok(eve > 0, '저녁·개인정비 칸에도 들어간다');
  // 배정 사유·야간 후보도 운항병 규칙으로 설명
  const s0 = all.find(s => E.dayGroup(s.date, s.workHoliday) !== 'weekend' && s.assign['09:30'] === 'g5');
  assert.strictEqual(E.explainAssignment(s0, 'D:09:30').kind, 'rule');
  const P = E.nightPool(s0); if (!Object.values(s0.night).includes('g5')) assert.ok(P.blocked.some(b => b.id === 'g5'));
});

test('v2 주간·야간 상황병: 고정 CCTV(13:30·10:30), 면제, 근무일·카운트 처리', () => {
  const db = setup();
  const sit = k => 's' + (((k % 7) + 7) % 7);
  const plan = i => { const ds = E.addDays('2027-03-01', i), wk = !isHol(ds);
    // 평일: 주간 = sit(i+3), 야간 = sit(i) (5일마다 같은 사람이 둘 다) / 주말·휴일: 한 명
    return { night: sit(i), day: wk ? (i % 5 === 0 ? sit(i) : sit(i + 3)) : null }; };
  const all = [];
  for (let i = 0; i < 35; i++) {
    const ds = E.addDays('2027-03-01', i), nds = E.addDays(ds, 1), p = plan(i), q = plan(i + 1);
    const s = E.generateDay2({ date: ds, workHoliday: isHol(ds), nextWorkHoliday: isHol(nds),
      situationId: p.night, nextSituationId: q.night, daySitId: p.day, nextDaySitId: q.day });
    db.schedules[ds] = s; E.invalidateStats(); all.push(s);
  }
  all.forEach((s, i) => {
    const wk = !isHol(s.date), cells = [...E.DAY_SLOTS.map(sl => ['D:' + sl, s.assign[sl]]), ...E.EVENING.map(sl => ['E:' + sl, s.fixed[sl]]), ...Object.entries(s.night).map(([b, id]) => ['N:' + b, id])];
    const of = id => cells.filter(c => c[1] === id).map(c => c[0]);
    assert.deepStrictEqual(E.validateSchedule2(s).hard, [], s.date);
    if (wk) {
      assert.strictEqual(s.assign['10:30'], s.situationId, s.date + ' 10:30');
      const ds2 = E.v2DaySitSlot(s.date); assert.strictEqual(s.assign[ds2], s.daySitId, s.date + ' ' + ds2);
      assert.deepStrictEqual(of(s.situationId).filter(k => !['D:10:30', 'D:' + ds2].includes(k)), [], s.date + ' 야간 상황병 다른 칸');
      if (s.daySitId !== s.situationId) assert.ok(of(s.daySitId).every(k => ['D:' + ds2, 'E:21:30'].includes(k) || k[0] === 'N'), s.date + ' 주간 상황병 칸');
    } else {
      assert.strictEqual(s.daySitId, null); assert.deepStrictEqual(of(s.situationId), [], s.date + ' 주말 상황병 CCTV 없음');
    }
    if (i > 0) { const pv = all[i - 1];
      assert.deepStrictEqual(of(pv.situationId), [], s.date + ' 전날 야간 상황병 다음날 면제');
      assert.ok(!Object.values(pv.night).includes(s.daySitId) || !s.daySitId, s.date + ' 주간 상황병 전날 야간 면제');
      assert.ok(!s.messIds.some(id => Object.values(pv.night).includes(id)), s.date + ' 배식조 전날 야간 불가'); }
    assert.ok(!s.messIds.includes(s.daySitId));
  });
  // 근무일·카운트: 주간만 = 분모 O·카운트 O, 야간(겸임 포함) = 당일·다음날 분모 X·카운트 X
  const one = all.find(s => !isHol(s.date) && s.daySitId && s.daySitId !== s.situationId), id = one.daySitId;
  const before = E.buildStats2(one.date), after = E.buildStats2(E.addDays(one.date, 1));
  assert.strictEqual(after[id].denom, before[id].denom + 1);
  const fx = E.v2DaySitSlot(one.date); assert.ok(after[id].slotNum[fx] === before[id].slotNum[fx] + 1);
  const nn = all.find(s => !isHol(s.date) && s.situationId), nid = nn.situationId;
  const b2 = E.buildStats2(nn.date), a2 = E.buildStats2(E.addDays(nn.date, 2));
  assert.strictEqual(a2[nid].denom, b2[nid].denom); assert.strictEqual(a2[nid].slotNum['10:30'], b2[nid].slotNum['10:30']);
});

test('전환 전날: 구 방식으로 만들되 17:30·18:30·19:30은 일반 배정(새 체계 상황병 제외), 전환일 상황병은 야간 제외', () => {
  const ws = []; for (let i = 0; i < 20; i++) ws.push(E.normWorker({ id: 'e' + i, name: 'e' + i, roleReady: true, roleType: i < 7 ? 'situation' : 'duty', canMeal: true, canXmess: true, active: true }, i));
  const db = { version: 2, workers: ws, schedules: {}, prebook: [], holidays: {}, settings: JSON.parse(JSON.stringify(E.DEFAULT_SETTINGS)) };
  E.setDB(db);
  // 구 방식 3일
  for (let i = 0; i < 3; i++) { const d = E.addDays('2027-03-01', i);
    db.prebook.push(E.normPrebook({ kind: 'duty', wid: 'e' + (7 + i), start: d }), E.normPrebook({ kind: 'situation', wid: 'e' + i, start: d }));
    db.schedules[d] = E.generateDay(E.autoInputFor(d)); E.invalidateStats(); }
  const since = '2027-03-05', eve = '2027-03-04';
  db.prebook.push(E.normPrebook({ kind: 'duty', wid: 'e10', start: eve }), E.normPrebook({ kind: 'situation', wid: 'e3', start: eve }));
  E.switchToV2(since);
  db.prebook = db.prebook.filter(p => !(p.kind === 'duty' && p.start >= since));
  db.prebook.push(E.normPrebook({ kind: 'sitday', wid: 'e4', start: since }), E.normPrebook({ kind: 'situation', wid: 'e5', start: since }));
  const s = E.generateTransitionEve(eve);
  assert.ok(!s.v2 && s.transitionEve);
  assert.strictEqual(s.dutyId, 'e10'); assert.strictEqual(s.situationId, 'e3');
  assert.ok(!s.nextDutyId && !s.nextMealId && !s.nextSituationId);
  ['17:30', '18:30', '19:30'].forEach(sl => { const id = s.fixed[sl]; assert.ok(id, sl); assert.ok(!E.isSituationW(E.W(id)), sl + ' 상황병 아님'); });
  ['e4', 'e5'].forEach(id => assert.ok(!Object.values(s.night).includes(id), id + ' 전환일 상황병은 오늘 야간 제외'));
  assert.ok(!E.validateSchedule(s).some(m => /인접|이중 야간|금지|열외인데/.test(m)), E.validateSchedule(s).join(' / '));
  db.schedules[eve] = s; E.invalidateStats();
  const t = E.generateDay2(E.autoInputFor(since));
  assert.deepStrictEqual(E.validateSchedule2(t).hard, []);
  assert.strictEqual(t.daySitId, 'e4'); assert.strictEqual(t.situationId, 'e5');
});

test('v2: 위병조장 A(07:00~08:30·14:30~18:30 5.5h)·B(08:30~14:30 6h) — 둘 다 전날 야간자 불가, 평일 당일 야간은 번초가 빌 때만', () => {
  assert.strictEqual(E.v2GateHours('A', '2027-03-04'), 5.5); assert.strictEqual(E.v2GateHours('B', '2027-03-04'), 6);   // 목
  assert.strictEqual(E.v2GateHours('A', '2027-03-05'), 4.5); assert.strictEqual(E.v2GateHours('B', '2027-03-05'), 5.5);   // 금 A 07:00~08:30·14:00~17:00, B 08:30~14:00
  assert.strictEqual(E.v2GateHours('H', '2027-03-06'), 2); assert.strictEqual(E.v2GateALoss('2027-03-05'), 1.5); assert.strictEqual(E.v2GateALoss('2027-03-04'), 1);
  const db = setup();
  const all = runDays(db, '2027-03-01', 42);
  all.forEach((s, i) => {
    assert.ok(!('C' in s.gate) && !('C' in (s.nextGate || {})), s.date);
    if (i > 0) { const pn = Object.values(all[i - 1].night); Object.values(s.gate).forEach(id => assert.ok(!pn.includes(id), s.date + ' 전날 야간자 위병조장')); }
    const nk = Object.values(s.night);
    if (!isHol(s.date)) Object.values(s.gate).forEach(id => assert.ok(!nk.includes(id), s.date + ' 인원이 충분한데 평일 위병조장 야간 투입'));
    Object.values(s.nextGate || {}).forEach(id => assert.ok(!nk.includes(id), s.date + ' 다음날 위병조장 야간'));
  });
  const st = E.buildStats2(null);
  const gen = db.workers.filter(w => /^g/.test(w.id));
  const spread = n => Math.max(...n) - Math.min(...n);
  assert.ok(spread(gen.map(w => st[w.id].gate.A.num)) <= 1, 'A 횟수 편차');   // A는 엄격 순번
  assert.ok(spread(gen.map(w => st[w.id].gate.B.num)) <= 2, 'B 횟수 편차');
  assert.ok(spread(gen.map(w => st[w.id].gate.A.num + st[w.id].gate.B.num)) <= 2, 'A+B 횟수 편차');
});

test('v2: 일반병이 모자라 야간이 빌 때만 당일 평일 위병조장을 야간에 넣는다', () => {
  const db = setup(7, 8);
  const off = ds => db.workers.filter(w => /^g[4-7]$/.test(w.id)).map(w => w.id);   // 일반병 절반이 계속 빠짐
  const all = runDays(db, '2027-03-01', 10, off);
  all.filter(s => !isHol(s.date)).forEach(s => {
    const nk = Object.values(s.night), used = Object.values(s.gate).filter(id => nk.includes(id));
    if (used.length) assert.ok(s.warnings.some(w => /위병조장 인원을 야간/.test(w)), s.date);
  });
});

test('v2 안식교: 토요일 07:30~14:30 열외, 토요일 위병조장·배식조 제외(다른 요일은 평소대로)', () => {
  const db = setup();
  const sab = db.workers.find(w => w.id === 'g0'); sab.isSabbath = true; sab.canXmess = true;
  const all = runDays(db, '2027-03-01', 35);
  let other = 0;
  all.forEach(s => {
    const sat = E.dow(s.date) === 6;
    const ids = Object.values(s.gate).concat(s.messIds);
    if (sat) {
      assert.ok(!ids.includes(sab.id), s.date + ' 토요일 위병조장·배식조');
      E.SABBATH_SAT_SLOTS.forEach(sl => assert.notStrictEqual(s.assign[sl], sab.id, s.date + ' ' + sl));
      assert.ok(!E.validateSchedule2(s).soft.some(m => /안식교/.test(m)));
    } else if (ids.includes(sab.id)) other++;
  });
  assert.ok(other > 0, '다른 요일에는 위병조장·배식조를 선다');
});
