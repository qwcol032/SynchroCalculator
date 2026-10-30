import { test } from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import { amount, integer, fixed, validateData, caseValue, totalCosts, parseInput, hourlyIncome, SCALE, RESOURCES, HOURS } from '../src/data.mjs';
import { plan, calculate, growTimeValue } from '../src/optimizer.mjs';
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
    const result = plan(data, input, 201, engine); assert.ok(result); assert.equal(result.objective[1], 0);
    for (const r of RESOURCES) assert.ok(result.used[r][h] <= 10);
  }
  const input = inventory({ stock: { credit: fixed(10), battle: fixed(10), core: 0n } }); input.cases.core[2] = 2; input.cases.core[8] = 1; input.cases.core[24] = 1;
  const result = plan(data, input, 201, engine); assert.equal(result.objective[0], 4 * SCALE); assert.equal(result.used.core[2], 2); assert.equal(result.used.core[8] + result.used.core[24], 0);
});
test('보급물자, 30DAY 선택형 상자, 생성 케이스 잔여, 상자 분할 금지', () => {
  let input = inventory({ supply: 8 }); const supplyPlan = plan(data, input, 201, engine); assert.deepEqual(supplyPlan.objective.slice(0, 2), [10 * SCALE, 8]);
  input = inventory({ day: 3 }); const dayPlan = plan(data, input, 201, engine); assert.deepEqual(dayPlan.objective.slice(0, 2), [50 * SCALE, 3]);
  assert.equal(dayPlan.opened.day.credit, 1); assert.equal(dayPlan.opened.day.battle, 1); assert.equal(dayPlan.opened.day.core, 1); assert.equal(dayPlan.generatedCases.credit.remaining, 29);
  assert.equal(plan(data, inventory({ day: 1 }), 201, engine), null);
  assert.equal(plan(data, inventory({ supply: 7 }), 201, engine), null);
});
test('총 시간 가치 우선: 긴 케이스보다 짧은 보급물자를 사용할 수 있음', () => {
  const input = inventory({ supply: 100, day: 100 }); for (const r of RESOURCES) input.cases[r][1] = 10;
  assert.deepEqual(plan(data, input, 201, engine).objective, [8 * SCALE, 0, 8]);
  const other = inventory({ supply: 8, day: 100 }); assert.equal(plan(data, other, 201, engine).objective[0], 10 * SCALE);
  const onlyCore = inventory({ supply: 5, stock: { credit: fixed(10), battle: fixed(10), core: 0n } }); onlyCore.cases.core[8] = 1;
  const result = plan(data, onlyCore, 201, engine); assert.equal(result.timeValue, 5n * BigInt(SCALE)); assert.equal(result.opened.supply.core, 5); assert.equal(result.used.core[8], 0);
});
test('최대 도달 레벨과 데이터 상한, 목표와 최대 배분 분리', () => {
  let input = inventory({ stock: { credit: fixed(10000), battle: fixed(10000), core: fixed(10000) } });
  let result = calculate(data, input, engine); assert.equal(result.maximum.level, 205); assert.equal(result.maximum.atDataCap, true);
  input = inventory({ stock: { credit: fixed(20), battle: fixed(20), core: fixed(20) }, target: 203 }); result = calculate(data, input, engine); assert.equal(result.maximum.level, 202); assert.equal(result.possible, false); assert.ok(result.shortfall.core > 0);
});
// Independent exhaustive enumerator: every box allocation and every bounded case
// choice, including leftover generated cases. No MILP/model code is reused.
const lexLess = (a, b) => !b || a.some((v, i) => v !== b[i] && a.slice(0, i).every((x, j) => x === b[j]) && v < b[i]);
function brute(d, stock) {
  const need = totalCosts(d, stock.current, stock.target); let best = null;
  const allocations = n => { const all = []; for (let a = 0; a <= n; a++) for (let b = 0; b <= n - a; b++) for (let c = 0; c <= n - a - b; c++) all.push([a,b,c]); return all; };
  const grows = []; for (let battle = 0; battle <= (stock.grow ?? 0); battle++) for (let core = 0; core <= (stock.grow ?? 0) - battle; core++) grows.push([0, battle, core]);
  // Independent formula (fixture rates have at most one decimal, even with bonus).
  const growHours = r => Math.round(({ battle: 88458, core: 16 }[r]) / (Number(d.outpost[stock.outpost - 1][r]) * (stock.academy ? 1.45 : 1)) * SCALE);
  for (const days of allocations(stock.day)) for (const supplies of allocations(stock.supply)) for (const grow of grows) {
    let caseCount = 0, time = grow[1] * growHours('battle') + grow[2] * growHours('core'), feasible = true;
    for (let i = 0; i < 3; i++) {
      const r = RESOURCES[i]; const generated = days[i] * (i === 0 ? 30 : 10) + supplies[i] * (i === 0 ? 3 : 1);
      time += generated * SCALE;
      let min = null;
      function choose(k, gained, used, hours) {
        if (k === HOURS.length) {
          for (let g = 0; g <= generated; g++) if (gained + BigInt(g) * caseValue(d, stock.outpost, stock.academy, r, 1) + stock.stock[r] >= need[r]) {
            const candidate = [hours, used + g]; if (lexLess(candidate, min)) min = candidate;
          }
          return;
        }
        const h = HOURS[k]; for (let n = 0; n <= stock.cases[r][h]; n++) choose(k + 1, gained + BigInt(n) * caseValue(d, stock.outpost, stock.academy, r, h), used + n, hours + h * n * SCALE);
      }
      choose(0, fixed((i === 1 ? 88458 : i === 2 ? 16 : 0) * grow[i]), 0, 0);
      if (!min) { feasible = false; break; } time += min[0]; caseCount += min[1];
    }
    if (feasible) { const objective = [time, [...days, ...supplies, ...grow].reduce((a,b)=>a+b), caseCount]; if (lexLess(objective, best)) best = objective; }
  }
  return best;
}
test('작은 재고 완전탐색과 정수 최적화 비교 (36개 고정 난수 입력)', () => {
  let seed = 12345; const random = n => { seed = (1664525 * seed + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * n); };
  for (let i = 0; i < 36; i++) {
    const input = inventory({ target: 201 + random(3), day: random(3), supply: random(4), grow: random(3), academy: !!random(2) });
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
    const input = inventory({ day: i % 3, supply: i % 4, grow: i % 3, target: 203 });
    for (const r of RESOURCES) { input.cases[r][2] = i % 2; input.cases[r][8] = Math.floor(i / 3) % 2; input.stock[r] = fixed(i * 2); }
    let expected = 200;
    for (let target = 201; target <= 205; target++) if (brute(data, { ...input, target })) expected = target;
    assert.equal(calculate(data, input, engine).maximum.level, expected, `maximum ${i}`);
  }
});

test('그로우 입력: 빈 값·기존 저장값 호환, 음수·소수·과다 재고 거부', () => {
  const raw = { current: '200', target: '201', outpost: '1' };
  assert.equal(parseInput(raw, data).grow, 0);
  assert.equal(parseInput({ ...raw, grow: '3' }, data).grow, 3);
  for (const grow of ['-1', '0.5', 'NaN', 'Infinity', '100000001']) assert.throws(() => parseInput({ ...raw, grow }, data));
});
test('그로우 고정 지급량, 전초기지·연구에 따라 시간 가치만 변화', () => {
  for (const outpost of [1, 2]) for (const academy of [false, true]) {
    const input = inventory({ outpost, academy, grow: 1, stock: { credit: fixed(10), battle: fixed(10), core: 0n } });
    const result = plan(data, input, 201, engine); assert.equal(result.opened.grow.core, 1);
    assert.equal(result.growGained.core, fixed(16)); assert.equal(result.remaining.core, fixed(6));
  }
  const input = inventory(); const base = growTimeValue(data, input, 'battle');
  assert.ok(growTimeValue(data, { ...input, academy: true }, 'battle') < base);
  assert.equal(growTimeValue(data, { ...input, outpost: 2 }, 'battle'), base / 2n);
});
test('그로우 분할 금지와 배틀/코어 혼합 배분, 크레딧 지급 불가', () => {
  const input = inventory({ grow: 1, stock: { credit: fixed(10), battle: 0n, core: 0n } });
  assert.equal(plan(data, input, 201, engine), null);
  input.grow = 2; const p = plan(data, input, 201, engine);
  assert.deepEqual(p.opened.grow, { battle: 1, core: 1 }); assert.equal(p.growGained.battle, fixed(88458));
  assert.equal(p.remainingBoxes.grow, 0);
  assert.equal(plan(data, inventory({ grow: 100 }), 201, engine), null);
});
test('전초기지별 배틀/코어 교환 효율 역전 시 선택도 변경', () => {
  const d = fixture();
  // Both choices cover the deficit in one grow box, but free hour cases can
  // cover the other resource. Which resource costs less is reversed by income.
  d.outpost[0] = { level: 1, credit: 10, battle: 88458, core: 8 };
  d.outpost[1] = { level: 2, credit: 10, battle: 44229, core: 16 };
  for (const [outpost, expected] of [[1, 'battle'], [2, 'core']]) {
    const input = inventory({ outpost, grow: 1, stock: { credit: fixed(10), battle: 0n, core: 0n } });
    input.cases.battle[2] = 1; input.cases.core[2] = 1;
    const result = plan(d, input, 201, engine); assert.equal(result.opened.grow[expected], 1);
  }
});
test('최대 레벨 탐색에 그로우가 반영되고 부족 배분 예시에 전체 상자가 포함됨', () => {
  const input = inventory({ grow: 2, stock: { credit: fixed(100), battle: 0n, core: 0n }, target: 205 });
  const result = calculate(data, input, engine); assert.equal(result.maximum.level, 201);
  assert.equal(result.shortfallAllocation.grow.battle + result.shortfallAllocation.grow.core, 2);
  assert.ok(result.shortfall.core > 0n);
});
