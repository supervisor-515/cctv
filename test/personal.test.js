"use strict";
/* 내 근무(개인 홈) — 실제 날짜 경계, 앞뒤 근무자, 지난 확인 이후 변경 판정, 기간 통계 */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

function db(workers, schedules) {
  const d = E.migrate({ workers: workers.map((id, i) => ({ id, name: id, roleReady: true, roleType: i % 2 ? 'duty' : 'situation', canMeal: true, active: true })) });
  Object.entries(schedules || {}).forEach(([ds, s]) => { d.schedules[ds] = E.normSched(Object.assign({ date: ds }, s)); });
  E.setDB(d); E.invalidateStats();
  return d;
}

test('실제 날짜: 번초 한 개는 두 시각, 새벽 칸은 다음날(월말·연말 경계 포함)', () => {
  db(['me', 'a'], { '2026-12-31': { night: { 3: 'me' }, assign: { '09:30': 'me' } } });
  const it = E.personalItems('2026-12-31', E.getDB().schedules['2026-12-31'], 'me');
  assert.deepEqual(it.map(x => [x.key, x.t, x.date]), [
    ['D:09:30', '09:30', '2026-12-31'], ['N:3', '00:30', '2027-01-01'], ['N:3', '04:30', '2027-01-01']]);
  assert.equal(E.personalKeys(E.getDB().schedules['2026-12-31'], 'me').filter(k => k[0] === 'N').length, 1, '번초 키는 하나');
  assert.equal(E.realDateOf('2026-02-28', '05:30'), '2026-03-01');
});

test('앞뒤 근무자: 날짜 경계를 넘고, 표 없음·미배정을 구분, 17:00 순찰은 교대 순서에 없음', () => {
  db(['me', 'a', 'b'], {
    '2026-09-30': { night: { 4: 'a' } },                                    // 01:30·05:30
    '2026-10-01': { assign: { '06:30': 'me', '16:30': 'b' }, fixed: { '17:30': 'a' }, patrolExtra: 'me' },
  });
  assert.deepEqual(E.cctvNeighbor('2026-10-01', '06:30', -1), { ds: '2026-09-30', t: '05:30', state: 'ok', id: 'a' });
  assert.equal(E.cctvNeighbor('2026-10-01', '06:30', 1).state, 'empty');   // 07:30 비어 있음
  assert.deepEqual(E.cctvNeighbor('2026-10-01', '05:30', 1), { ds: '2026-10-02', t: '06:30', state: 'nosched', id: null });
  assert.deepEqual(E.cctvNeighbor('2026-10-01', '16:30', 1), { ds: '2026-10-01', t: '17:30', state: 'ok', id: 'a' });
});

const W = ['me', 'a', 'b', 'c'];
function base3() {   // 10/1~10/3 표, 확인 범위 9/30~10/13
  return db(W, {
    '2026-10-01': { assign: { '09:30': 'me' }, night: { 1: 'a' }, mealId: 'me' },
    '2026-10-02': { night: { 2: 'me' } },
    '2026-10-03': { assign: { '10:30': 'b' } },
  });
}

test('최초 기준과 같은 표면 변경 없음 — 대량 알림 안 생김', () => {
  base3();
  const b = E.personalSnap('me', '2026-09-30', '2026-10-13');
  assert.deepEqual(E.diffPersonal(b, E.personalSnap('me', '2026-09-30', '2026-10-13'), true), []);
  assert.deepEqual(E.diffPersonal(null, b, true), [], '기준 없음 → 비교하지 않음');
});

test('배정 추가·해제·역할 변경·번초 변경 탐지 (번초는 한 건)', () => {
  const d = base3();
  const b = E.personalSnap('me', '2026-09-30', '2026-10-13');
  d.schedules['2026-10-01'].assign['09:30'] = 'b';          // 해제
  d.schedules['2026-10-01'].mealId = 'a';                   // 역할 해제
  d.schedules['2026-10-02'].night = { 3: 'me' };            // 2번초 → 3번초
  d.schedules['2026-10-03'].assign['14:30'] = 'me';         // 새 배정
  const ch = E.diffPersonal(b, E.personalSnap('me', '2026-09-30', '2026-10-13'), true).map(x => x.ds + ' ' + x.type + ' ' + x.key);
  assert.deepEqual(ch.sort(), ['2026-10-01 remove D:09:30', '2026-10-01 remove R:meal', '2026-10-02 add N:3', '2026-10-02 remove N:2', '2026-10-03 add D:14:30'].sort());
});

test('날짜 경과·조회 범위 이동·재생성(generatedAt만 다름)은 변경이 아님', () => {
  const d = base3();
  const b = E.personalSnap('me', '2026-09-30', '2026-10-13');
  d.schedules['2026-10-01'].generatedAt = '2099-01-01T00:00:00Z';
  d.schedules['2026-10-14'] = E.normSched({ date: '2026-10-14', assign: { '06:30': 'me' } });   // 범위 밖이었다가 보이게 됨
  const cur = E.personalSnap('me', '2026-10-02', '2026-10-16');                                  // 이틀 지남
  assert.deepEqual(E.diffPersonal(b, cur, true), []);
  // 굴리기: 새로 보이는 날짜를 기준에 넣되 이미 있던 날짜는 그대로 → 이후 그 날짜 수정은 잡힌다
  const r = E.rollPersonal(b, cur);
  assert.ok(r.has.includes('2026-10-14') && !r.has.includes('2026-10-01'));
  d.schedules['2026-10-14'].assign['06:30'] = 'a';
  assert.deepEqual(E.diffPersonal(r, E.personalSnap('me', '2026-10-02', '2026-10-16'), true).map(x => x.type + ' ' + x.key), ['remove D:06:30']);
});

test('확인 뒤 새로 생성된 표는 new, 수신이 불완전하면 사라진 표를 해제로 보지 않음', () => {
  const d = base3();
  const b = E.personalSnap('me', '2026-09-30', '2026-10-13');
  d.schedules['2026-10-05'] = E.normSched({ date: '2026-10-05', night: { 1: 'me' } });
  delete d.schedules['2026-10-02'];
  const cur = E.personalSnap('me', '2026-09-30', '2026-10-13');
  assert.deepEqual(E.diffPersonal(b, cur, false).map(x => x.ds + ' ' + x.type), ['2026-10-05 new']);
  assert.deepEqual(E.diffPersonal(b, cur, true).map(x => x.ds + ' ' + x.type), ['2026-10-02 gone', '2026-10-05 new']);
  // 최신이 아닌 상태에서 확인해도 안 보이던 표의 기준은 유지 → 표가 다시 보여도 거짓 '새 근무표' 없음
  const acked = E.ackPersonal(b, cur, false);
  d.schedules['2026-10-02'] = E.normSched({ date: '2026-10-02', night: { 2: 'me' } });
  assert.deepEqual(E.diffPersonal(acked, E.personalSnap('me', '2026-09-30', '2026-10-13'), true), []);
});

test('확인 처리 중 새 변경이 들어오면 본 범위까지만 확인', () => {
  const d = base3();
  const b = E.personalSnap('me', '2026-09-30', '2026-10-13');
  d.schedules['2026-10-03'].assign['14:30'] = 'me';
  const shown = E.personalSnap('me', '2026-09-30', '2026-10-13');   // 사용자가 본 화면
  d.schedules['2026-10-01'].assign['09:30'] = 'c';                   // 확인 누르기 직전 수신
  const nb = E.ackPersonal(b, shown, true);
  assert.deepEqual(E.diffPersonal(nb, E.personalSnap('me', '2026-09-30', '2026-10-13'), true).map(x => x.type + ' ' + x.key), ['remove D:09:30']);
});

test('다른 사람 기준으로는 비교하지 않음(계정 전환)', () => {
  base3();
  const mine = E.personalSnap('me', '2026-09-30', '2026-10-13');
  assert.deepEqual(E.diffPersonal(mine, E.personalSnap('a', '2026-09-30', '2026-10-13'), true), []);
});

test('기간 통계: 이어진 두 기간의 분자·분모 합 = 합친 기간, 전체 범위 = 전체 통계', () => {
  const ws = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10', 'w11', 'w12', 'w13'];
  const d = db(ws, {});
  let ds = '2026-08-01';
  for (let i = 0; i < 30; i++) { d.schedules[ds] = E.generateDay(E.autoInputFor(ds)); E.invalidateStats(); ds = E.addDays(ds, 1); }
  const A = E.buildStats(null, { from: '2026-08-01', to: '2026-08-12' }), B = E.buildStats(null, { from: '2026-08-13', to: '2026-08-30' });
  const AB = E.buildStats(null, { from: '2026-08-01', to: '2026-08-30' }), ALL = E.buildStats(null, null);
  const f = ['denom', 'nightNum', 'nightDen', 'mealNum', 'mealDen', 'patrolNum', 'patrolDen'];
  ws.forEach(id => {
    f.forEach(k => assert.equal(A[id][k] + B[id][k], AB[id][k], id + ' ' + k));
    ['weekday', 'holiday'].forEach(g => assert.equal(A[id].nightGNum[g] + B[id].nightGNum[g], AB[id].nightGNum[g]));
    assert.ok(Math.abs(A[id].hours + B[id].hours - AB[id].hours) < 1e-9);
    f.forEach(k => assert.equal(AB[id][k], ALL[id][k], id + ' 전체 ' + k));
  });
});

test('당직사관·당직사령 명단: 저장·불러오기에서 유지, 빈 이름·중복 id 정리, 구버전 데이터는 빈 명단', () => {
  const d = E.migrate({ workers: [], officers: { sagwan: [{ id: 'a', name: ' 중위 김 ' }, { id: 'a', name: '중복' }, { name: '' }], saryeong: [{ id: 'b', name: '대위 이' }] } });
  assert.deepEqual(d.officers, { sagwan: [{ id: 'a', name: '중위 김' }], saryeong: [{ id: 'b', name: '대위 이' }] });
  assert.deepEqual(E.migrate(JSON.parse(JSON.stringify(d))).officers, d.officers, '다시 불러와도 같음');
  assert.deepEqual(E.migrate({ workers: [] }).officers, { sagwan: [], saryeong: [] });
});
