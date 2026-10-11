import './style.css';
import { RESOURCES, HOURS, SCALE, parseInput, supportedLevels, validateData } from './data.mjs';
const $ = id => document.getElementById(id);
const labels = { credit: '크레딧', battle: '배틀 데이터', core: '코어 더스트' };
const base = import.meta.env.BASE_URL;
const form = $('calculator'); let data, config = {}, calculationWorker, requestId = 0, busy = false, turnstileId;
const node = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
for (const r of RESOURCES) {
  const label = node('label', labels[r]); const group = node('div', undefined, 'amount-input');
  const input = node('input'); input.name = `stock_${r}`; input.type = 'number'; input.min = '0'; input.step = 'any'; input.placeholder = '0'; input.setAttribute('aria-label', `보유 ${labels[r]}`);
  const select = node('select'); select.name = `unit_${r}`; select.setAttribute('aria-label', `${labels[r]} 단위`);
  for (const unit of r === 'core' ? ['base', 'K'] : ['K', 'M']) { const option = node('option', unit === 'base' ? '기본' : unit); option.value = unit; select.append(option); }
  group.append(input, select); label.append(group); $('resources').append(label);
  const section = node('div', undefined, 'case-group'); const title = node('h3'); title.append(node('span', '', `dot ${r}`), node('span', labels[r])); section.append(title);
  const grid = node('div', undefined, 'case-grid');
  for (const h of HOURS) { const label = node('label', `${h}시간`); const input = node('input'); input.type = 'number'; input.name = `case_${r}_${h}`; input.min = '0'; input.step = '1'; input.placeholder = '0'; input.setAttribute('aria-label', `${labels[r]} ${h}시간 케이스 개수`); label.append(input); grid.append(label); }
  section.append(grid); $('cases').append(section);
}
try { const saved = JSON.parse(localStorage.getItem('synchro-input') ?? '{}'); for (const [key, value] of Object.entries(saved)) { const e = form.elements.namedItem(key); if (e) { if (e.type === 'checkbox') e.checked = !!value; else e.value = value; } } } catch { /* Storage unavailable: calculations remain usable. */ }
function readInput() {
  const raw = Object.fromEntries(new FormData(form)); raw.academy = form.elements.academy.checked; raw.stock = {}; raw.units = {}; raw.cases = {};
  for (const r of RESOURCES) { raw.stock[r] = raw[`stock_${r}`]; raw.units[r] = raw[`unit_${r}`]; raw.cases[r] = Object.fromEntries(HOURS.map(h => [h, raw[`case_${r}_${h}`]])); }
  return raw;
}
form.addEventListener('input', () => { try { const saved = Object.fromEntries(new FormData(form)); saved.academy = form.elements.academy.checked; localStorage.setItem('synchro-input', JSON.stringify(saved)); } catch { /* No external persistence. */ } });
function error(id, text) { $(id).textContent = text ?? ''; $(id).hidden = !text; }
const fmt = value => { const n = BigInt(value); const fraction = String(n % BigInt(SCALE)).padStart(6, '0').replace(/0+$/, ''); return (n / BigInt(SCALE)).toLocaleString('ko-KR') + (fraction ? `.${fraction}` : ''); };
function table(headers, rows) { const t = node('table'); const head = node('thead'), tr = node('tr'); for (const h of headers) tr.append(node('th', h)); head.append(tr); t.append(head); const body = node('tbody'); for (const row of rows) { const tr = node('tr'); for (const value of row) tr.append(node('td', value)); body.append(tr); } t.append(body); return t; }
function planView(plan, title) {
  const card = node('section', undefined, 'card'); card.append(node('h2', title, 'result-title'));
  card.append(node('h3', '재화 사용 후 잔여량'), table(['재화', '필요량', '잔여량'], RESOURCES.map(r => [labels[r], fmt(plan.costs[r]), fmt(plan.remaining[r])])));
  card.append(node('h3', '기존 케이스 사용 개수'), table(['재화', ...HOURS.map(h => `${h}h`)], RESOURCES.map(r => [labels[r], ...HOURS.map(h => plan.used[r][h])])));
  card.append(node('h3', '선택형 상자 개봉'), table(['재화 선택', '보급물자', '30DAY'], RESOURCES.map(r => [labels[r], plan.opened.supply[r], plan.opened.day[r]])));
  card.append(node('h3', '상자에서 받은 1시간 케이스'), table(['재화', '획득', '사용', '남음'], RESOURCES.map(r => [labels[r], plan.generatedCases[r].received, plan.generatedCases[r].used, plan.generatedCases[r].remaining])));
  card.append(node('h3', '잔여 케이스 (상자에서 받은 케이스 포함)'), table(['재화', ...HOURS.map(h => `${h}h`)], RESOURCES.map(r => [labels[r], ...HOURS.map(h => plan.remainingCases[r][h])])));
  card.append(node('p', `남은 보급물자 ${plan.remainingBoxes.supply}개 · 30DAY ${plan.remainingBoxes.day}개`));
  return card;
}
function render(result) {
  $('result-placeholder').hidden = true; $('results').replaceChildren();
  const overview = node('section', undefined, 'card'); overview.append(node('h2', result.possible ? '목표 레벨 달성 가능' : '현재 재고로 목표 달성 불가', `result-title ${result.possible ? '' : 'fail'}`));
  overview.append(table(['재화', '총 필요량', '보유 차감 후 부족'], RESOURCES.map(r => [labels[r], fmt(result.costs[r]), fmt(result.deficits[r])]))); $('results').append(overview);
  if (result.targetPlan) $('results').append(planView(result.targetPlan, '목표 달성 · 최소 사용 계획'));
  else {
    const section = node('section', undefined, 'card'); section.append(node('h3', '전체 아이템 활용 시 부족량 (배분 예시)'), table(['재화', '부족량'], RESOURCES.map(r => [labels[r], fmt(result.shortfall[r])])), table(['재화 선택', '보급물자', '30DAY'], RESOURCES.map(r => [labels[r], result.shortfallAllocation.supply[r], result.shortfallAllocation.day[r]])), node('p', '선택형 상자 배분에 따라 부족 재화가 달라집니다. 최대 레벨 계획을 기준으로 남은 상자를 크레딧 → 배틀 → 코어에 배분한 예시입니다.')); $('results').append(section);
  }
  const max = node('section', undefined, 'card'); max.append(node('h3', '모든 재고를 활용한 최대 도달'), node('div', `${result.maximum.level} LV`, 'max-level'), node('p', result.maximum.atDataCap ? `최소 ${result.maximum.level}레벨 도달 가능, 이후 데이터 필요` : '세 재화의 누적 비용을 모두 충족하는 최대 레벨입니다. 자연 획득은 제외합니다.')); $('results').append(max);
  const details = node('details'); details.append(node('summary', '최대 레벨용 별도 배분 계획 보기'), planView(result.maximum.plan, '최대 레벨 · 전체 기존 케이스 활용')); $('results').append(details);
}
async function runCalculation() {
  if (!data || busy) return;
  try {
    const input = parseInput(readInput(), data); error('input-error'); busy = true; $('calculate').disabled = true; $('calculate').textContent = '최적 사용 계획을 계산하는 중…';
    calculationWorker?.terminate(); calculationWorker = new Worker(new URL('./calculation-worker.mjs', import.meta.url), { type: 'module' });
    const id = ++requestId;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { calculationWorker.terminate(); reject(new Error('계산 제한 시간(90초)을 넘었습니다. 재고와 레벨을 확인한 뒤 다시 시도하세요.')); }, 90000);
      calculationWorker.onmessage = e => { if (e.data.id === id) { clearTimeout(timer); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result); } };
      calculationWorker.onerror = () => { clearTimeout(timer); reject(new Error('계산 엔진을 불러오지 못했습니다. 네트워크 연결 후 다시 시도하세요.')); };
      calculationWorker.postMessage({ id, data, input });
    }); render(result);
  } catch (e) { error('input-error', e.message); } finally { busy = false; $('calculate').disabled = !data; $('calculate').textContent = '사용 계획 계산하기 →'; }
}
form.addEventListener('submit', e => { e.preventDefault(); runCalculation(); });
async function loadData(expected) {
  const response = await fetch(`${base}data/data.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.headers.get('Content-Type')?.includes('json')) throw new Error('검증된 실제 데이터가 아직 없습니다. 운영자가 원본 수집과 검증을 완료해야 합니다.');
  const candidate = validateData(await response.json());
  if (expected && (candidate.contentVersion !== expected.contentVersion || candidate.checkedAt !== expected.checkedAt)) throw new Error('Pages에 새 확인 버전이 아직 반영되지 않았습니다. 기존 데이터를 유지합니다.');
  data = candidate; $('calculate').disabled = false; error('data-error');
  const range = supportedLevels(data);
  $('data-info').textContent = `싱크로 ${range.min}~${range.max} · 전초기지 ${data.ranges.outpost.min}~${data.ranges.outpost.max} | 마지막 확인 ${new Date(data.checkedAt).toLocaleString('ko-KR')} | 실제 변경 ${new Date(data.changedAt).toLocaleString('ko-KR')}`;
  $('assumptions').replaceChildren(...data.assumptions.map(a => node('li', a)));
  form.elements.current.max = range.max; form.elements.target.max = range.max; form.elements.outpost.max = data.ranges.outpost.max;
}
const states = { queued: '갱신 대기 중', collecting: '원본 수집·검증 중', deploying: 'Pages 배포 중', verifying: 'Pages 새 버전 확인 중', complete: '갱신 완료', unchanged: '최신 데이터 확인 완료 (변경 없음)', failed: '갱신 실패', timeout: '갱신 시간 초과', idle: '갱신 대기', cooldown: '갱신 간격 제한' };
async function refreshRequest(path, options = {}) {
  const response = await fetch(`${config.workerUrl.replace(/\/$/, '')}${path}`, { ...options, signal: AbortSignal.timeout(15000) });
  const status = await response.json(); if (!response.ok && ![409, 429].includes(response.status)) throw new Error(status.message ?? '갱신 서버 요청 실패');
  return status;
}
$('refresh').addEventListener('click', async () => {
  if (!config.workerUrl) { $('update-state').textContent = '공개 갱신 서버가 설정되지 않았습니다. 저장된 데이터로 계산할 수 있습니다.'; return; }
  $('refresh').disabled = true;
  try {
    const token = turnstileId !== undefined ? window.turnstile?.getResponse(turnstileId) : undefined;
    let status = await refreshRequest('/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(token ? { turnstileToken: token } : {}) });
    const started = Date.now(); let errors = 0;
    for (let attempt = 0; attempt < 80 && Date.now() - started < 20 * 60000; attempt++) {
      $('update-state').textContent = `${states[status.state] ?? '상태 확인 중'}${status.message ? ` · ${status.message}` : ''}`;
      if (['complete', 'unchanged'].includes(status.state)) { await loadData(status); if ($('results').childElementCount) await runCalculation(); return; }
      if (['failed', 'timeout', 'cooldown', 'idle'].includes(status.state) || status.rateLimited) return;
      await new Promise(resolve => setTimeout(resolve, 15000));
      try { status = await refreshRequest('/status'); errors = 0; } catch (e) { if (++errors >= 3) throw e; $('update-state').textContent = '상태 연결 재시도 중 · 기존 데이터와 입력은 유지됩니다.'; }
    }
    throw new Error('전체 갱신 대기시간을 초과했습니다. 기존 데이터와 입력은 유지됩니다.');
  } catch (e) { $('update-state').textContent = `${e.message} 기존 데이터와 입력은 유지됩니다.`; } finally { $('refresh').disabled = false; if (turnstileId !== undefined) window.turnstile?.reset(turnstileId); }
});
try { config = await fetch(`${base}config.json`).then(r => r.json()); if (config.workerUrl && !/^https:\/\//.test(config.workerUrl)) throw new Error('Worker URL은 HTTPS여야 합니다.'); } catch { config = {}; }
if (!config.workerUrl) $('update-state').textContent = '공개 갱신 서버 미설정 · 저장된 데이터로 계산 가능';
if (config.turnstileSiteKey) {
  const container = node('div'); $('refresh').before(container); const script = node('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.onload = () => { turnstileId = window.turnstile.render(container, { sitekey: config.turnstileSiteKey }); }; document.head.append(script);
}
try { await loadData(); } catch (e) { error('data-error', e.message); $('data-info').textContent = '실제 원본 데이터 수집 대기 · 샘플 데이터는 사용하지 않습니다.'; }
