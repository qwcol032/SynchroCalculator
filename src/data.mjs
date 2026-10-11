export const RESOURCES = ['credit', 'battle', 'core'];
export const HOURS = [1, 2, 8, 12, 24];
export const SCALE = 1_000_000;
export const RULES = Object.freeze({ rounding: 'floor-per-case', bonus: { credit: 160, battle: 145, core: 145 }, supply: { credit: 3, battle: 1, core: 1 }, day: { credit: 30, battle: 10, core: 10 } });
export function fixed(value, name = '수치') {
  const text = String(value ?? '').trim();
  if (!/^(?:\d+)(?:\.\d{1,6})?$/.test(text)) throw new Error(`${name}: 0 이상의 숫자를 소수 6자리 이내로 입력하세요.`);
  const [whole, fraction = ''] = text.split('.');
  const n = BigInt(whole) * BigInt(SCALE) + BigInt(fraction.padEnd(6, '0'));
  if (n > 9_000_000_000_000_000n * BigInt(SCALE)) throw new Error(`${name}: 안전하게 계산할 수 있는 범위를 넘었습니다.`);
  return n;
}
export function integer(value, name, optional = false) {
  const text = String(value ?? '').trim();
  if (!text && optional) return 0;
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(`${name}: 0 이상의 정수가 필요합니다.`);
  return Number(text);
}
export function amount(value, unit = 'base') {
  if (!['base', 'K', 'M'].includes(unit)) throw new Error('지원하지 않는 단위입니다.');
  const n = fixed(String(value ?? '').trim() || '0', '보유 재화') * BigInt({ base: 1, K: 1000, M: 1000000 }[unit]);
  if (n > 9_000_000_000_000_000n * BigInt(SCALE)) throw new Error('보유 재화가 계산 가능 범위를 넘었습니다.');
  return n;
}
export function validateData(data) {
  if (data.schemaVersion !== 1 || !['arrival', 'departure'].includes(data.costDirection)) throw new Error('데이터 스키마 또는 레벨 비용 방향을 확인할 수 없습니다.');
  if (!['floor-per-case', 'exact'].includes(data.rounding)) throw new Error('지급량 규칙이 없습니다.');
  if (!data.assumptions?.length || typeof data.researchIncluded !== 'boolean') throw new Error('연구 보너스 및 가정 메타데이터가 없습니다.');
  for (const name of ['checkedAt', 'changedAt']) if (!Number.isFinite(Date.parse(data[name]))) throw new Error(`${name} 확인 시각 오류`);
  if (!/^[a-f0-9]{64}$/.test(data.contentVersion ?? '')) throw new Error('콘텐츠 버전 오류');
  if (!data.sources?.synchro?.url || !data.sources?.outpost?.url) throw new Error('원본 URL이 없습니다.');
  for (const kind of ['synchro', 'outpost']) {
    const rows = data[kind]; const range = data.ranges?.[kind];
    if (!Array.isArray(rows) || !rows.length || !range || rows.length !== range.max - range.min + 1) throw new Error(`${kind}: 지원 범위 또는 연속성 오류`);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].level !== range.min + i) throw new Error(`${kind}: 중복 또는 누락된 레벨`);
      for (const r of RESOURCES) fixed(rows[i][r], `${kind} ${rows[i].level} ${r}`);
    }
  }
  if (data.rounding === 'floor-per-case' && data.outpost.some(row => RESOURCES.some(r => caseValue(data, row.level, false, r, 1) === 0n))) throw new Error('1시간 케이스 수익이 0입니다. 원본 또는 지급량 규칙을 확인하세요.');
  return data;
}
export function supportedLevels(data) {
  return { min: Math.max(200, data.ranges.synchro.min - (data.costDirection === 'arrival' ? 1 : 0)), max: data.ranges.synchro.max + (data.costDirection === 'departure' ? 1 : 0) };
}
export function caseValue(data, level, academy, resource, hours) {
  const row = data.outpost[level - data.ranges.outpost.min];
  if (!row || row.level !== level) throw new Error('전초기지 데이터가 없습니다. 최신 데이터 확인이 필요합니다.');
  let n = fixed(row[resource]) * BigInt(hours);
  if (data.researchIncluded) {
    // Published rows with the full academy bonus can also serve the unchecked setting.
    if (!academy) n = n * 100n / BigInt(RULES.bonus[resource]);
  } else if (academy) n = n * BigInt(RULES.bonus[resource]) / 100n;
  if (data.rounding === 'floor-per-case') n = n / BigInt(SCALE) * BigInt(SCALE);
  return n;
}
export function totalCosts(data, current, target) {
  const range = supportedLevels(data);
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(target) || current < range.min || target > range.max) throw new Error(`지원 싱크로 범위는 ${range.min}~${range.max}입니다. 마지막으로 확인한 원본에는 요청 레벨 비용이 없습니다. 최신 데이터 확인이 필요합니다.`);
  if (target < current) throw new Error('목표 레벨은 현재 레벨 이상이어야 합니다.');
  const totals = Object.fromEntries(RESOURCES.map(r => [r, 0n]));
  for (let next = current + 1; next <= target; next++) {
    const level = data.costDirection === 'arrival' ? next : next - 1;
    const row = data.synchro[level - data.ranges.synchro.min];
    if (!row || row.level !== level) throw new Error(`${level}레벨 비용이 없습니다. 데이터 갱신이 필요합니다.`);
    for (const r of RESOURCES) {
      totals[r] += fixed(row[r]);
    }
  }
  return totals;
}
export function parseInput(raw, data) {
  const current = integer(raw.current, '현재 싱크로 레벨'); const target = integer(raw.target, '목표 싱크로 레벨');
  const outpost = integer(raw.outpost, '전초기지 레벨');
  totalCosts(data, current, target);
  if (outpost < data.ranges.outpost.min || outpost > data.ranges.outpost.max) throw new Error(`전초기지 지원 범위는 ${data.ranges.outpost.min}~${data.ranges.outpost.max}입니다. 마지막으로 확인한 원본에는 요청 레벨 수익이 없습니다. 최신 데이터 확인이 필요합니다.`);
  const stock = {}; const cases = {};
  for (const r of RESOURCES) {
    stock[r] = amount(raw.stock?.[r], raw.units?.[r] ?? 'base');
    cases[r] = Object.fromEntries(HOURS.map(h => [h, integer(raw.cases?.[r]?.[h], `${r} ${h}시간 케이스`, true)]));
    for (const h of HOURS) if (cases[r][h] > 100000000) throw new Error(`${r} ${h}시간 케이스는 1억 개 이하로 입력하세요.`);
    // Exact amounts use BigInt; bound item variables for the numerical solver.
    for (const h of HOURS) if (BigInt(cases[r][h]) * caseValue(data, outpost, !!raw.academy, r, h) > 9_000_000_000_000_000n * BigInt(SCALE)) throw new Error('케이스 재고가 계산 가능 범위를 넘었습니다.');
  }
  for (const [count, name] of [[raw.supply, '보급물자'], [raw.day, '30DAY 상자']]) if (integer(count, name, true) > 100000000) throw new Error('선택형 상자는 1억 개 이하로 입력하세요.');
  return { current, target, outpost, academy: !!raw.academy, stock, cases, supply: integer(raw.supply, '보급물자', true), day: integer(raw.day, '30DAY 상자', true) };
}
