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

test('v2: 평일은 위병조장 A·B·C(일반병 3명), 토·일·휴일은 1명 / 배식조 매일 2명 / 당직·고정칸 없음', () => {
  const db = setup();
  runDays(db, '2027-03-01', 14).forEach(s => {
    const g = Object.values(s.gate);
    if (isHol(s.date)) assert.deepStrictEqual(Object.keys(s.gate), ['H']);
    else { assert.deepStrictEqual(Object.keys(s.gate).sort(), ['A', 'B', 'C']); assert.strictEqual(new Set(g).size, 3); }
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
    assert.ok(!h.includes(s.situationId), s.date + ' 당일 상황병');
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
    if (Object.keys(pm).length) [s.gate.A, ...s.messIds].forEach(id => { if (id) want[id] = (want[id] || 0) + 1; }); });   // 평일 위병조장A·배식조: 1h 침해
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
  ['g0', 's6', 's0'].forEach(id => assert.ok(!h.includes(id), id));
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
    Object.entries(s.gate).forEach(([k, id]) => assert.ok(h[id] >= E.GATE_HOURS[k]));
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
  const gateH = Object.keys(s.gate).reduce((a, k) => a + E.GATE_HOURS[k], 0), messH = s.messIds.length * E.v2MessHours(s.date);
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
test('v2: 카운트 초기화 — 기준일 이전 CCTV 횟수·분모·근무시간은 0, 06:30·마지막 근무일·배식조·개인정비 순번은 유지', () => {
  const db = setup(7, 14, 3);
  runDays(db, '2027-03-01', 28);
  const before = E.buildStats2(null)['r0'];
  db.workers.find(w => w.id === 'r0').countResetAt = '2027-03-29'; E.invalidateStats();
  const r = E.buildStats2(null)['r0'];
  assert.ok(before.hours > 0 && before.denom > 0 && before.nightNum + Object.values(before.slotNum).reduce((a, b) => a + b, 0) > 0);
  assert.strictEqual(r.hours, 0); assert.strictEqual(r.denom, 0); assert.strictEqual(r.slotDen, 0); assert.strictEqual(r.nightDen, 0);
  assert.strictEqual(r.nightNum, 0); assert.strictEqual(r.patrolNum, 0);
  assert.strictEqual(Object.values(r.slotNum).reduce((a, b) => a + b, 0), 0);
  ['rotAllNum', 'rotAllDen', 'pHours', 'pDen'].forEach(k => assert.strictEqual(r[k], before[k], k));
  assert.deepStrictEqual(r.messNum, before.messNum); assert.deepStrictEqual(r.messDen, before.messDen);
  assert.deepStrictEqual(r.tieDay, before.tieDay); assert.deepStrictEqual(r.tieNight, before.tieNight);
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
  // 초기화가 없으면 신병 시절 기록 때문에 0.95 안팎까지 떨어진다
  assert.ok(ratio > 0.975 && ratio < 1.06, '전환자 ÷ 일반병 = ' + ratio.toFixed(3));
});
