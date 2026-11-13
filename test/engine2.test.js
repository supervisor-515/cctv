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
    Object.entries(pm).forEach(([sl, h]) => { const id = sl === 'P' ? s.patrolExtra : E.DAY_SLOTS.includes(sl) ? s.assign[sl] : s.fixed[sl]; if (id) want[id] = (want[id] || 0) + h; }); });
  db.workers.forEach(w => assert.strictEqual(st[w.id].pHours, want[w.id] || 0, w.id));
});

test('v2: 개인정비 시간이 사람마다 고르게 돈다(90일, 대상일당 편차 작음)', () => {
  const db = setup();
  runDays(db, '2027-03-01', 90);
  const st = E.buildStats2(null);
  const a = db.workers.map(w => st[w.id].pHours / st[w.id].pDen);
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
