import { RESOURCES, HOURS, RULES, SCALE, caseValue, hourlyIncome, fixed, totalCosts, supportedLevels } from './data.mjs';
// Integer MILP: minimize time value (microhours), then opened boxes and used cases.
// The time objective may stop within 36 seconds of the optimum for the whole
// plan. Integer box/case tie objectives remain exact. Reject timed-out incumbents.
export const TIME_VALUE_TOLERANCE = 10_000; // microhours = 0.01 h = 36 s
const max0 = n => n > 0n ? n : 0n;
const gcd = (a, b) => b === 0n ? a : gcd(b, a % b);
const ceilDiv = (a, b) => (a + b - 1n) / b;
// Compare at 0.000001-hour precision per item; round half up without floating point.
export function growTimeValue(data, input, resource) {
  const income = hourlyIncome(data, input.outpost, input.academy, resource);
  if (income <= 0n) throw new Error('시간 환산 수익이 0입니다.');
  const numerator = fixed(RULES.grow[resource]) * BigInt(SCALE);
  const value = (numerator + income / 2n) / income;
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('그로우 업 박스 시간 가치가 계산 범위를 벗어났습니다.');
  return value;
}
export function plan(data, input, target, highs, { allCases = false, feasibilityOnly = false } = {}) {
  const costs = totalCosts(data, input.current, target);
  const vars = []; const constraints = []; const bounds = []; const limits = {};
  const add = (name, max) => { vars.push(name); limits[name] = max; bounds.push(`0 <= ${name} <= ${max}`); return name; };
  const ds = [], ss = [], gs = [], cs = [], times = [], timeObjective = [], per = {};
  const growStock = input.grow ?? 0;
  for (const r of RESOURCES) {
    const payouts = HOURS.map(h => caseValue(data, input.outpost, input.academy, r, h));
    const forcedGain = allCases ? HOURS.reduce((sum, h, i) => sum + BigInt(input.cases[r][h]) * payouts[i], 0n) : 0n;
    const remainingNeed = max0(costs[r] - input.stock[r] - forcedGain);
    // Positive-cost optional items never need to individually cover more than
    // the entire residual deficit. Tighter bounds also remove unused resources.
    const cap = (stock, value) => Number(BigInt(stock) < ceilDiv(remainingNeed, value) ? BigInt(stock) : ceilDiv(remainingNeed, value));
    const d = add(`d_${r}`, cap(input.day, payouts[0] * BigInt(RULES.day[r])));
    const s = add(`s_${r}`, cap(input.supply, payouts[0] * BigInt(RULES.supply[r])));
    ds.push(d); ss.push(s);
    times.push([d, RULES.day[r] * SCALE], [s, RULES.supply[r] * SCALE]);
    const grow = r in RULES.grow ? add(`grow_${r}`, cap(growStock, fixed(RULES.grow[r]))) : null;
    if (grow) { gs.push(grow); times.push([grow, Number(growTimeValue(data, input, r))]); timeObjective.push([grow, Number(growTimeValue(data, input, r))]); }
    const generated = add(`g_${r}`, cap(input.day * RULES.day[r] + input.supply * RULES.supply[r], payouts[0])); cs.push(generated);
    constraints.push(`generated_${r}: ${generated} - ${RULES.day[r]} ${d} - ${RULES.supply[r]} ${s} <= 0`);
    const growPayout = grow ? fixed(RULES.grow[r]) : 0n;
    const quantum = [...payouts, growPayout].reduce(gcd);
    if (quantum === 0n) throw new Error('전초기지 케이스 수익이 0입니다.');
    const terms = [`${payouts[0] / quantum} ${generated}`];
    if (grow) terms.push(`${growPayout / quantum} ${grow}`);
    const use = [];
    for (const h of HOURS) {
      const name = add(`c_${r}_${h}`, allCases ? input.cases[r][h] : cap(input.cases[r][h], payouts[HOURS.indexOf(h)])); cs.push(name); use.push(name); times.push([name, h * SCALE]);
      terms.push(`${caseValue(data, input.outpost, input.academy, r, h) / quantum} ${name}`);
      if (allCases) constraints.push(`all_${name}: ${name} = ${input.cases[r][h]}`);
    }
    // Expose the integer number of nominal hours to the solver. Without this
    // redundant aggregate it branches on many equivalent case combinations.
    const normalTerms = [[d, RULES.day[r]], [s, RULES.supply[r]], ...HOURS.map(h => [`c_${r}_${h}`, h])];
    const hours = add(`hours_${r}`, normalTerms.reduce((sum, [v, h]) => sum + limits[v] * h, 0));
    constraints.push(`hours_${r}: ${hours}${normalTerms.map(([v, h]) => ` - ${h} ${v}`).join('')} = 0`);
    timeObjective.push([hours, SCALE]);
    per[r] = { d, s, grow, generated, use, hours, normalTerms };
    constraints.push(`need_${r}: ${terms.join(' + ')} >= ${ceilDiv(max0(costs[r] - input.stock[r]), quantum)}`);
  }
  constraints.push(`day_stock: ${ds.join(' + ')} <= ${input.day}`, `supply_stock: ${ss.join(' + ')} <= ${input.supply}`, `grow_stock: ${gs.join(' + ')} <= ${growStock}`);
  let answer; const locks = [];
  const solve = (entries, label) => {
    const weighted = entries.map(e => typeof e === 'string' ? [e, 1] : e);
    const divisor = weighted.reduce((g, [, w]) => gcd(g, BigInt(w)), 0n) || 1n;
    const terms = weighted.map(([v, w]) => [v, Number(BigInt(w) / divisor)]);
    const objective = terms.map(([v, w]) => `${w} ${v}`).join(' + ') || `0 ${vars[0]}`;
    const lp = `Minimize\n obj: ${objective}\nSubject To\n ${constraints.join('\n ')}\nBounds\n ${bounds.join('\n ')}\nGenerals\n ${vars.join(' ')}\nEnd`;
    // Objective coefficients were divided by gcd; convert the global budget
    // to the same units. Below one integer unit, 0.5 still proves exactness.
    const absoluteGap = label === 'time' ? Math.max(0.5, TIME_VALUE_TOLERANCE / Number(divisor)) : 0.5;
    const result = highs.solve(lp, { output_flag: false, mip_rel_gap: 0, mip_abs_gap: absoluteGap, mip_feasibility_tolerance: 1e-9, primal_feasibility_tolerance: 1e-9, time_limit: 20, random_seed: 0 });
    if (result.Status === 'Infeasible') return false;
    if (result.Status !== 'Optimal') {
      const step = { time: '시간 가치', boxes: '상자 개봉 수', cases: '케이스 사용 수', feasible: '도달 가능 여부' }[label];
      throw new Error(`${target}레벨 ${step} 최적화를 완료하지 못했습니다 (${result.Status})`);
    }
    answer = Object.fromEntries(vars.map(v => {
      const n = result.Columns[v]?.Primal ?? 0; const rounded = Math.round(n);
      if (!Number.isSafeInteger(rounded) || Math.abs(n - rounded) > 1e-7 || rounded < 0 || rounded > limits[v]) throw new Error('정수 해 검증 실패');
      return [v, rounded];
    }));
    for (const lock of locks) {
      if (lock.terms.reduce((sum, [v, w]) => sum + BigInt(answer[v]) * BigInt(w), 0n) !== lock.exact) throw new Error('최적화 시간 가치·동률 조건을 정밀 검증하지 못했습니다.');
    }
    const exact = terms.reduce((sum, [v, w]) => sum + BigInt(answer[v]) * BigInt(w), 0n);
    if (exact > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('시간 가치 합계가 안전한 최적화 범위를 넘었습니다. 아이템 개수를 줄여주세요.');
    const optimum = Number(exact); locks.push({ terms, exact });
    constraints.push(`fix_${label}: ${objective} = ${optimum}`);
    return true;
  };
  if (feasibilityOnly) { if (!solve([], 'feasible')) return null; }
  else if (!solve(timeObjective, 'time') || !solve([...ds, ...ss, ...gs], 'boxes') || !solve(cs, 'cases')) return null;
  const opened = { day: {}, supply: {}, grow: { battle: 0, core: 0 } }; const used = {}, remainingCases = {}, remaining = {}, generatedCases = {};
  for (const r of RESOURCES) {
    const { d, s, grow, generated, hours, normalTerms } = per[r];
    if (normalTerms.reduce((sum, [v, h]) => sum + answer[v] * h, 0) !== answer[hours]) throw new Error('시간 합계 검증 실패'); opened.day[r] = answer[d]; opened.supply[r] = answer[s];
    if (grow) opened.grow[r] = answer[grow];
    const made = answer[d] * RULES.day[r] + answer[s] * RULES.supply[r];
    generatedCases[r] = { received: made, used: answer[generated], remaining: made - answer[generated] };
    used[r] = Object.fromEntries(HOURS.map(h => [h, answer[`c_${r}_${h}`]]));
    remainingCases[r] = Object.fromEntries(HOURS.map(h => [h, input.cases[r][h] - used[r][h] + (h === 1 ? made - answer[generated] : 0)]));
    let gained = BigInt(grow ? answer[grow] : 0) * fixed(RULES.grow[r] ?? 0) + BigInt(answer[generated]) * caseValue(data, input.outpost, input.academy, r, 1);
    for (const h of HOURS) {
      if (used[r][h] < 0 || used[r][h] > input.cases[r][h]) throw new Error('재고 제약 검증 실패');
      gained += BigInt(used[r][h]) * caseValue(data, input.outpost, input.academy, r, h);
    }
    remaining[r] = input.stock[r] + gained - costs[r];
    // Independent fixed-point check rejects any tolerance-induced underfunding.
    if (remaining[r] < 0 || made < answer[generated] || made < 0) throw new Error('최적화 결과가 실제 비용을 충족하지 못했습니다.');
  }
  const dayUsed = Object.values(opened.day).reduce((a, b) => a + b, 0); const supplyUsed = Object.values(opened.supply).reduce((a, b) => a + b, 0);
  const growUsed = gs.reduce((sum, v) => sum + answer[v], 0);
  if (growUsed > growStock || dayUsed > input.day || supplyUsed > input.supply) throw new Error('상자 재고 제약 검증 실패');
  const timeValue = times.reduce((sum, [v, w]) => sum + BigInt(answer[v]) * BigInt(w), 0n);
  if (timeValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('시간 가치 합계가 안전한 최적화 범위를 넘었습니다. 아이템 개수를 줄여주세요.');
  return { target, costs, deficits: Object.fromEntries(RESOURCES.map(r => [r, max0(costs[r] - input.stock[r])])), opened, used, generatedCases, remainingCases, remaining, remainingBoxes: { day: input.day - dayUsed, supply: input.supply - supplyUsed, grow: growStock - growUsed }, growGained: Object.fromEntries(Object.keys(RULES.grow).map(r => [r, BigInt(opened.grow[r]) * fixed(RULES.grow[r])])), timeValue, timeToleranceSeconds: TIME_VALUE_TOLERANCE * 3600 / SCALE, objective: [Number(timeValue), dayUsed + supplyUsed + growUsed, cs.reduce((a, v) => a + answer[v], 0)] };
}
export function calculate(data, input, highs) {
  const targetPlan = plan(data, input, input.target, highs);
  let low = input.current, high = supportedLevels(data).max;
  // Integer feasibility is monotone because all costs are nonnegative.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (plan(data, input, mid, highs, { feasibilityOnly: true })) low = mid; else high = mid - 1;
  }
  const maxPlan = plan(data, input, low, highs, { allCases: true });
  const deficits = Object.fromEntries(RESOURCES.map(r => [r, max0(totalCosts(data, input.current, input.target)[r] - input.stock[r])]));
  // A shortfall cannot be a single independent vector: box choices trade resources.
  // Show one optimum maximum-level allocation, all cases and all remaining boxes
  // assigned by deterministic resource order; label this as a scenario, not a unique deficit.
  const scenario = structuredClone(maxPlan);
  const avail = { ...scenario.remaining };
  let leftoverDay = scenario.remainingBoxes.day, leftoverSupply = scenario.remainingBoxes.supply;
  for (const r of RESOURCES) {
    const remainingCost = max0(totalCosts(data, input.current, input.target)[r] - totalCosts(data, input.current, low)[r] - avail[r] - BigInt(maxPlan.generatedCases[r].remaining) * caseValue(data, input.outpost, input.academy, r, 1));
    const rate = caseValue(data, input.outpost, input.academy, r, 1);
    const d = Math.min(leftoverDay, Number(ceilDiv(remainingCost, rate * BigInt(RULES.day[r]))));
    const s = Math.min(leftoverSupply, Number(ceilDiv(max0(remainingCost - BigInt(d) * rate * BigInt(RULES.day[r])), rate * BigInt(RULES.supply[r]))));
    leftoverDay -= d; leftoverSupply -= s; avail[r] += BigInt(d * RULES.day[r] + s * RULES.supply[r]) * rate;
    scenario.opened.day[r] += d; scenario.opened.supply[r] += s;
  }
  // Consume the unused generated cases from the maximum plan in this scenario.
  for (const r of RESOURCES) avail[r] += BigInt(maxPlan.generatedCases[r].remaining) * caseValue(data, input.outpost, input.academy, r, 1);
  if (leftoverDay || leftoverSupply) {
    avail.core += BigInt(leftoverDay * RULES.day.core + leftoverSupply * RULES.supply.core) * caseValue(data, input.outpost, input.academy, 'core', 1);
    scenario.opened.day.core += leftoverDay; scenario.opened.supply.core += leftoverSupply;
  }
  let leftoverGrow = scenario.remainingBoxes.grow;
  for (const r of ['battle', 'core']) {
    const need = max0(totalCosts(data, input.current, input.target)[r] - totalCosts(data, input.current, low)[r] - avail[r]);
    const count = Math.min(leftoverGrow, Number(ceilDiv(need, fixed(RULES.grow[r]))));
    scenario.opened.grow[r] += count; leftoverGrow -= count;
    avail[r] += BigInt(count) * fixed(RULES.grow[r]);
  }
  scenario.opened.grow.core += leftoverGrow; avail.core += BigInt(leftoverGrow) * fixed(RULES.grow.core);
  const targetCosts = totalCosts(data, input.current, input.target), maxCosts = totalCosts(data, input.current, low);
  const shortfall = Object.fromEntries(RESOURCES.map(r => [r, max0(targetCosts[r] - maxCosts[r] - avail[r])]));
  return { possible: !!targetPlan, targetPlan, costs: targetCosts, deficits, maximum: { level: low, atDataCap: low === supportedLevels(data).max, plan: maxPlan }, shortfall, shortfallAllocation: scenario.opened };
}
