import { test } from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import { amount, integer, fixed, validateData, caseValue, totalCosts, parseInput, SCALE, RESOURCES, HOURS } from '../src/data.mjs';
import { plan, calculate } from '../src/optimizer.mjs';
import { fixture, inventory } from './fixtures.mjs';
const engine = await loadHighs();
const data = fixture();
test('단위 환산, 빈 재화와 아이템, 숫자 유효성', () => {
  assert.equal(amount('1.25', 'K'), BigInt(1250) * BigInt(SCALE)); assert.equal(amount('0.001', 'M'), BigInt(1000) * BigInt(SCALE)); assert.equal(amount(''), 0n); assert.equal(integer('', '아이템', true), 0);
  for (const bad of ['-1', 'NaN', 'Infinity', '1e3', '0.0000001']) assert.throws(() => amount(bad));
  for (const bad of ['', '-1', '0.5', 'Infinity']) assert.throws(() => integer(bad, '레벨'));
  assert.throws(() => amount('9007199254740991', 'M'));
  const input = parseInput({ current: '200', target: '201', outpost: '1', academy: true }, data); assert.equal(input.supply, 0); assert.equal(input.stock.core, 0n);
  assert.throws(() => parseInput({ current: '', target: '201', outpost: '1' }, data));
});
test('도달 비용 200→201 및 변화 경계, 같은 레벨, 낮은 목표', () => {
  assert.deepEqual(totalCosts(data, 200, 201), { credit: BigInt(10) * BigInt(SCALE), battle: BigInt(10) * BigInt(SCALE), core: BigInt(10) * BigInt(SCALE) });
  assert.deepEqual(totalCosts(data, 202, 203), { credit: BigInt(25) * BigInt(SCALE), battle: BigInt(20) * BigInt(SCALE), core: BigInt(15) * BigInt(SCALE) });
  assert.equal(totalCosts(data, 200, 200).core, 0n); assert.throws(() => totalCosts(data, 201, 200));
  const departure = { ...data, costDirection: 'departure' }; assert.equal(totalCosts(departure, 201, 202).credit, BigInt(10) * BigInt(SCALE));
  assert.throws(() => totalCosts(data, 200, 206));
});
test('연구 보너스 및 케이스 개별 버림, 중복 연구 방지', () => {
  assert.equal(caseValue(data, 1, true, 'credit', 1), BigInt(16) * BigInt(SCALE));
  assert.equal(caseValue(data, 1, true, 'battle', 1), BigInt(10) * BigInt(SCALE));
  assert.equal(caseValue(data, 1, true, 'core', 1), BigInt(3) * BigInt(SCALE));
  assert.equal(caseValue(data, 1, false, 'credit', 2), BigInt(21) * BigInt(SCALE));
  for (const h of HOURS) assert.equal(caseValue(data, 1, false, 'core', h), BigInt(Math.floor(2.5 * h)) * BigInt(SCALE));
  const bonusIncluded = { ...data, researchIncluded: true }; assert.equal(caseValue(bonusIncluded, 1, true, 'credit', 1), BigInt(10) * BigInt(SCALE));
});
test('보유 재화만으로 목표 달성 및 같은 레벨 제로 사용', () => {
  const input = inventory({ stock: { credit: fixed(100), battle: fixed(100), core: fixed(100) }, supply: 2, day: 2 });
  const result = plan(data, input, 201, engine); assert.deepEqual(result.objective, [0, 0, 0]); assert.equal(result.remaining.core, fixed(90));
  const same = plan(data, input, 200, engine); assert.deepEqual(same.objective, [0, 0, 0]);
});
test('각 시간 케이스, 케이스만으로 달성, 재고 제한과 비탐욕적 선택', () => {
  for (const h of HOURS) {
    const input = inventory(); for (const r of RESOURCES) input.cases[r][h] = 10;
    const result = plan(data, input, 201, engine); assert.ok(result); assert.deepEqual(result.objective.slice(0, 2), [0, 0]);
    for (const r of RESOURCES) assert.ok(result.used[r][h] <= 10);
  }
  const input = inventory({ stock: { credit: fixed(10), battle: fixed(10), core: 0n } }); input.cases.core[2] = 2; input.cases.core[8] = 1; input.cases.core[24] = 1;
  const result = plan(data, input, 201, engine); assert.equal(result.objective[2], 1); assert.equal(result.used.core[8] + result.used.core[24], 1);
});
test('보급물자, 30DAY 선택형 상자, 생성 케이스 잔여, 상자 분할 금지', () => {
  let input = inventory({ supply: 8 }); const supplyPlan = plan(data, input, 201, engine); assert.deepEqual(supplyPlan.objective.slice(0, 2), [0, 8]);
  input = inventory({ day: 3 }); const dayPlan = plan(data, input, 201, engine); assert.deepEqual(dayPlan.objective.slice(0, 2), [3, 0]);
  assert.equal(dayPlan.opened.day.credit, 1); assert.equal(dayPlan.opened.day.battle, 1); assert.equal(dayPlan.opened.day.core, 1); assert.equal(dayPlan.generatedCases.credit.remaining, 29);
  assert.equal(plan(data, inventory({ day: 1 }), 201, engine), null);
  assert.equal(plan(data, inventory({ supply: 7 }), 201, engine), null);
});
test('사전식 최소화: 케이스가 많아도 30DAY, 보급물자 최소가 우선', () => {
  const input = inventory({ supply: 100, day: 100 }); for (const r of RESOURCES) input.cases[r][1] = 10;
  assert.deepEqual(plan(data, input, 201, engine).objective, [0, 0, 8]);
  const other = inventory({ supply: 8, day: 100 }); assert.equal(plan(data, other, 201, engine).objective[0], 0);
});
test('최대 도달 레벨과 데이터 상한, 목표와 최대 배분 분리', () => {
  let input = inventory({ stock: { credit: fixed(10000), battle: fixed(10000), core: fixed(10000) } });
  let result = calculate(data, input, engine); assert.equal(result.maximum.level, 205); assert.equal(result.maximum.atDataCap, true);
  input = inventory({ stock: { credit: fixed(20), battle: fixed(20), core: fixed(20) }, target: 203 }); result = calculate(data, input, engine); assert.equal(result.maximum.level, 202); assert.equal(result.possible, false); assert.ok(result.shortfall.core > 0);
});
// Independent exhaustive enumerator: every box allocation and every bounded case
// choice, including leftover generated cases. No MILP/model code is reused.
function brute(d, stock) {
  const need = totalCosts(d, stock.current, stock.target); let best = null;
  const allocations = n => { const all = []; for (let a = 0; a <= n; a++) for (let b = 0; b <= n - a; b++) for (let c = 0; c <= n - a - b; c++) all.push([a,b,c]); return all; };
  for (const days of allocations(stock.day)) for (const supplies of allocations(stock.supply)) {
    let caseCount = 0, feasible = true;
    for (let i = 0; i < 3; i++) {
      const r = RESOURCES[i]; const generated = days[i] * (i === 0 ? 30 : 10) + supplies[i] * (i === 0 ? 3 : 1);
      let min = Infinity;
      function choose(k, gained, used) {
        if (k === HOURS.length) {
          for (let g = 0; g <= generated; g++) if (gained + BigInt(g) * caseValue(d, stock.outpost, stock.academy, r, 1) + stock.stock[r] >= need[r]) min = Math.min(min, used + g);
          return;
        }
        const h = HOURS[k]; for (let n = 0; n <= stock.cases[r][h]; n++) choose(k + 1, gained + BigInt(n) * caseValue(d, stock.outpost, stock.academy, r, h), used + n);
      }
      choose(0, 0n, 0); if (min === Infinity) { feasible = false; break; } caseCount += min;
    }
    if (feasible) { const objective = [days.reduce((a,b)=>a+b), supplies.reduce((a,b)=>a+b), caseCount]; if (!best || objective.some((v,i)=>v !== best[i] && objective.slice(0,i).every((x,j)=>x===best[j]) && v < best[i])) best = objective; }
  }
  return best;
}
test('작은 재고 완전탐색과 정수 최적화 비교 (36개 고정 난수 입력)', () => {
  let seed = 12345; const random = n => { seed = (1664525 * seed + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * n); };
  for (let i = 0; i < 36; i++) {
    const input = inventory({ target: 201 + random(3), day: random(3), supply: random(4), academy: !!random(2) });
    for (const r of RESOURCES) { input.stock[r] = fixed(random(25)); input.cases[r][1] = random(3); input.cases[r][2] = random(2); input.cases[r][8] = random(2); }
    assert.deepEqual(plan(data, input, input.target, engine, { tieBreak: false })?.objective ?? null, brute(data, input), `case ${i}`);
  }
});
test('데이터 검증: 중복, 누락, 필수 필드, 음수, NaN', () => {
  assert.equal(validateData(fixture()).schemaVersion, 1);
  for (const bad of [null, undefined, -1, NaN, Infinity]) { const candidate = fixture(); candidate.synchro[0].credit = bad; assert.throws(() => validateData(candidate)); }
  const duplicate = fixture(); duplicate.synchro[1].level = 201; assert.throws(() => validateData(duplicate));
  const missing = fixture(); missing.synchro.pop(); assert.throws(() => validateData(missing));
});
test('작은 재고 최대 레벨도 완전탐색과 비교 (12개 입력)', () => {
  for (let i = 0; i < 12; i++) {
    const input = inventory({ day: i % 3, supply: i % 4, target: 203 });
    for (const r of RESOURCES) { input.cases[r][2] = i % 2; input.cases[r][8] = Math.floor(i / 3) % 2; input.stock[r] = fixed(i * 2); }
    let expected = 200;
    for (let target = 201; target <= 205; target++) if (brute(data, { ...input, target })) expected = target;
    assert.equal(calculate(data, input, engine).maximum.level, expected, `maximum ${i}`);
  }
});
