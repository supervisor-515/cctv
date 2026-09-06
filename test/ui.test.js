"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../engine.js');

// DOM 라이브러리 없이 실제 화면의 change 핸들러를 실행한다.
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('function renderSchedTable('), html.indexOf('function schedToInput('));
function fixture() {
  return E.migrate({workers: ['old', 'new'].map(id => ({id, name:id, roleReady:true}))});
}
function editor(db, schedule) {
  E.setDB(db);
  const selects = [];
  function element() {
    return {
      children: [], handlers: {},
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(event, handler) { this.handlers[event] = handler; }
    };
  }
  const context = {
    ...E, DB:db, el:element, esc:String, roleTag:()=>null,
    DAYGROUP_KR:{mtth:'월화목', fri:'금'},
    workerSelect(id) {
      const node = element(); node.value=id; selects.push(node); return node;
    },
    save:E.invalidateStats, renderView(){}
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.renderSchedTable(schedule, false);
  return (slot, id) => {
    const select = selects[E.DAY_SLOTS.indexOf(slot)];
    select.value = id;
    select.handlers.change();
  };
}
for (const [date, slot] of [['2026-09-04','13:30'], ['2026-09-07','14:30']]) {
  test('고정칸 교체·미배정은 한 사람만 집계한다: '+slot, () => {
    const db=fixture(), s=E.normSched({date, fixed:{[slot]:'old'}});
    db.schedules[date]=s;
    const change=editor(db,s);
    change(slot,'new');
    assert.equal(s.fixed[slot],'new');
    assert.equal(s.assign[slot],undefined);
    let stats=E.buildStats();
    assert.equal(stats.old.hours,0);
    assert.equal(stats.new.hours,1);
    change(slot,'');
    assert.equal(s.fixed[slot],undefined);
    assert.equal(s.assign[slot],undefined);
    stats=E.buildStats();
    assert.equal(stats.old.hours,0);
    assert.equal(stats.new.hours,0);
  });
}
test('일반 주간칸은 교체 후에도 assign에만 저장된다', () => {
  const db=fixture(), date='2026-09-04';
  const s=E.normSched({date, assign:{'13:30':'old'}});
  db.schedules[date]=s;
  editor(db,s)('13:30','new');
  assert.equal(s.assign['13:30'],'new');
  assert.equal(s.fixed['13:30'],undefined);
  assert.equal(E.buildStats().new.hours,1);
});
test('구버전 고정칸 중복은 화면 배정자를 유지하고 한 번만 집계한다', () => {
  for(const slot of ['13:30','14:30']){
    for(const visible of ['old','new']){
      const raw={workers:fixture().workers,schedules:{
        '2026-09-04':{date:'2026-09-04',fixed:{[slot]:'old'},assign:{[slot]:visible,'09:30':'old'}}
      }};
      const before=JSON.stringify(raw);
      const db=E.migrate(raw), s=db.schedules['2026-09-04'];
      assert.equal(s.fixed[slot],visible);
      assert.equal(s.assign[slot],undefined);
      assert.equal(s.assign['09:30'],'old');
      assert.equal(JSON.stringify(raw),before,'원본 객체를 변경하지 않는다');
      assert.deepEqual(E.migrate(db),db,'반복 불러오기에도 결과가 같다');
      E.setDB(db);
      const stats=E.buildStats();
      assert.equal(stats.old.hours,visible==='old'?2:1);
      assert.equal(stats.new.hours,visible==='new'?1:0);
    }
  }
});

