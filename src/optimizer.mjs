import { RESOURCES, HOURS, RULES, SCALE, caseValue, totalCosts, supportedLevels } from './data.mjs';
// Exact lexicographic MILP: solve an integer objective, then fix it as equality.
// Never accept a feasible incumbent or a nonzero MIP gap as an optimum.
const max0 = n => n > 0n ? n : 0n;
const gcd = (a, b) => b === 0n ? a : gcd(b, a % b);
const ceilDiv = (a, b) => (a + b - 1n) / b;
export function plan(data, input, target, highs, { allCases = false, tieBreak = true } = {}) {
  const costs = totalCosts(data, input.current, target);
  const vars = []; const constraints = []; const bounds = [];
  const add = (name, max) => { vars.push(name); bounds.push(`0 <= ${name} <= ${max}`); return name; };
  const ds = [], ss = [], cs = [], per = {};
  for (const r of RESOURCES) {
    const d = add(`d_${r}`, input.day); const s = add(`s_${r}`, input.supply); ds.push(d); ss.push(s);
    const generated = add(`g_${r}`, input.day * RULES.day[r] + input.supply * RULES.supply[r]); cs.push(generated);
    constraints.push(`generated_${r}: ${generated} - ${RULES.day[r]} ${d} - ${RULES.supply[r]} ${s} <= 0`);
    const payouts = HOURS.map(h => caseValue(data, input.outpost, input.academy, r, h));
    const quantum = payouts.reduce(gcd);
    if (quantum === 0n) throw new Error('전초기지 케이스 수익이 0입니다.');
    const terms = [`${payouts[0] / quantum} ${generated}`];
    const use = [];
    for (const h of HOURS) {
      const name = add(`c_${r}_${h}`, input.cases[r][h]); cs.push(name); use.push(name);
      terms.push(`${caseValue(data, input.outpost, input.academy, r, h) / quantum} ${name}`);
      if (allCases) constraints.push(`all_${name}: ${name} = ${input.cases[r][h]}`);
    }
    per[r] = { d, s, generated, use };
    constraints.push(`need_${r}: ${terms.join(' + ')} >= ${ceilDiv(max0(costs[r] - input.stock[r]), quantum)}`);
  }
  constraints.push(`day_stock: ${ds.join(' + ')} <= ${input.day}`, `supply_stock: ${ss.join(' + ')} <= ${input.supply}`);
  let answer;
  const solve = (names, label) => {
    const objective = names.join(' + ') || `0 ${vars[0]}`;
    const lp = `Minimize\n obj: ${objective}\nSubject To\n ${constraints.join('\n ')}\nBounds\n ${bounds.join('\n ')}\nGenerals\n ${vars.join(' ')}\nEnd`;
    const result = highs.solve(lp, { output_flag: false, mip_rel_gap: 0, mip_abs_gap: 0, mip_feasibility_tolerance: 1e-9, primal_feasibility_tolerance: 1e-9, time_limit: 5, random_seed: 0 });
    if (result.Status === 'Infeasible') return false;
    if (result.Status !== 'Optimal') throw new Error(`최적화를 완료하지 못했습니다 (${result.Status})`);
    answer = Object.fromEntries(vars.map(v => {
      const n = result.Columns[v]?.Primal ?? 0; const rounded = Math.round(n);
      if (!Number.isSafeInteger(rounded) || Math.abs(n - rounded) > 1e-7) throw new Error('정수 해 검증 실패');
      return [v, rounded];
    }));
    const optimum = names.reduce((sum, v) => sum + answer[v], 0);
    constraints.push(`fix_${label}: ${objective} = ${optimum}`);
    return true;
  };
  if (!solve(ds, 'days') || !solve(ss, 'supplies') || !solve(cs, 'cases')) return null;
  // Stable tie order: minimize individual allocations credit/battle/core, then
  // generated 1h and owned short/long cases in that order; no weighted approximation.
  const tieOrder = [...ds, ...ss, ...RESOURCES.map(r => per[r].generated), ...RESOURCES.flatMap(r => per[r].use)];
  if (tieBreak) for (let i = 0; i < tieOrder.length; i++) if (!solve([tieOrder[i]], `tie${i}`)) throw new Error('동률 해 검증 실패');
  const opened = { day: {}, supply: {} }; const used = {}, remainingCases = {}, remaining = {}, generatedCases = {};
  for (const r of RESOURCES) {
    const { d, s, generated } = per[r]; opened.day[r] = answer[d]; opened.supply[r] = answer[s];
    const made = answer[d] * RULES.day[r] + answer[s] * RULES.supply[r];
    generatedCases[r] = { received: made, used: answer[generated], remaining: made - answer[generated] };
    used[r] = Object.fromEntries(HOURS.map(h => [h, answer[`c_${r}_${h}`]]));
    remainingCases[r] = Object.fromEntries(HOURS.map(h => [h, input.cases[r][h] - used[r][h] + (h === 1 ? made - answer[generated] : 0)]));
    let gained = BigInt(answer[generated]) * caseValue(data, input.outpost, input.academy, r, 1);
    for (const h of HOURS) {
      if (used[r][h] < 0 || used[r][h] > input.cases[r][h]) throw new Error('재고 제약 검증 실패');
      gained += BigInt(used[r][h]) * caseValue(data, input.outpost, input.academy, r, h);
    }
    remaining[r] = input.stock[r] + gained - costs[r];
    // Independent fixed-point check rejects any tolerance-induced underfunding.
    if (remaining[r] < 0 || made < answer[generated] || made < 0) throw new Error('최적화 결과가 실제 비용을 충족하지 못했습니다.');
  }
  const dayUsed = Object.values(opened.day).reduce((a, b) => a + b, 0); const supplyUsed = Object.values(opened.supply).reduce((a, b) => a + b, 0);
  if (dayUsed > input.day || supplyUsed > input.supply) throw new Error('상자 재고 제약 검증 실패');
  return { target, costs, deficits: Object.fromEntries(RESOURCES.map(r => [r, max0(costs[r] - input.stock[r])])), opened, used, generatedCases, remainingCases, remaining, remainingBoxes: { day: input.day - dayUsed, supply: input.supply - supplyUsed }, objective: [dayUsed, supplyUsed, cs.reduce((a, v) => a + answer[v], 0)] };
}
export function calculate(data, input, highs) {
  const targetPlan = plan(data, input, input.target, highs);
  let low = input.current, high = supportedLevels(data).max;
  // Integer feasibility is monotone because all costs are nonnegative.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (plan(data, input, mid, highs, { tieBreak: false })) low = mid; else high = mid - 1;
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
  const targetCosts = totalCosts(data, input.current, input.target), maxCosts = totalCosts(data, input.current, low);
  const shortfall = Object.fromEntries(RESOURCES.map(r => [r, max0(targetCosts[r] - maxCosts[r] - avail[r])]));
  return { possible: !!targetPlan, targetPlan, costs: targetCosts, deficits, maximum: { level: low, atDataCap: low === supportedLevels(data).max, plan: maxPlan }, shortfall, shortfallAllocation: scenario.opened };
}
