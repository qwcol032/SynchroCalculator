import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker, { RefreshCoordinator } from '../worker/index.mjs';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const env = { REPOSITORY: 'qwcol032/SynchroCalculator', BRANCH: 'main', WORKFLOW: 'update-data.yml', GITHUB_TOKEN: 'TEST_ONLY_NOT_A_CREDENTIAL', ALLOWED_ORIGIN: 'https://qwcol032.github.io', PAGES_DATA_URL: 'https://qwcol032.github.io/SynchroCalculator/data/data.json', COOLDOWN_SECONDS: '1800', TIMEOUT_SECONDS: '1200' };
class State {
  constructor() {
    this.values = new Map(); this.queue = Promise.resolve(); this.alarmTime = null;
    this.storage = {
      get: async key => structuredClone(this.values.get(key)),
      put: async (key, value) => { if (typeof key === 'string') this.values.set(key, structuredClone(value)); else for (const [k,v] of Object.entries(key)) this.values.set(k, structuredClone(v)); },
      delete: async keys => (Array.isArray(keys) ? keys : [keys]).forEach(k => this.values.delete(k)),
      list: async ({ prefix }) => new Map([...this.values].filter(([k]) => k.startsWith(prefix))),
      getAlarm: async () => this.alarmTime,
      setAlarm: async time => { this.alarmTime = time; }
    };
  }
  blockConcurrencyWhile(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
}
const req = (path = '/refresh', key = 'one') => new Request(`https://do${path}`, { method: path === '/refresh' ? 'POST' : 'GET', headers: { 'X-Rate-Key': key } });
test('동시 요청 10개는 1회만 dispatch, 같은 영속 작업 반환', async () => {
  const state = new State(); const coordinator = new RefreshCoordinator(state, env); let calls = 0;
  globalThis.fetch = async (url, options) => { assert.match(url, /dispatches$/); assert.equal(JSON.parse(options.body).ref, 'main'); calls++; return new Response(null, { status: 204 }); };
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => coordinator.fetch(req('/refresh', `visitor${i}`)).then(r => r.json())));
  assert.equal(calls, 1); assert.equal(new Set(results.map(x => x.id)).size, 1); assert.ok(results.every(x => x.state === 'queued'));
  const reloaded = new RefreshCoordinator(state, env); await reloaded.fetch(req('/refresh', 'newVisitor')); assert.equal(calls, 1);
});
test('dispatch HTTP 실패, 불확실한 응답은 중복 재전송 금지', async () => {
  let state = new State(), coordinator = new RefreshCoordinator(state, env);
  globalThis.fetch = async () => new Response('', { status: 403 }); assert.equal((await coordinator.fetch(req()).then(r=>r.json())).state, 'failed');
  state = new State(); coordinator = new RefreshCoordinator(state, env); let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('timeout'); };
  assert.equal((await coordinator.fetch(req()).then(r=>r.json())).state, 'queued'); await coordinator.fetch(req('/refresh', 'second')); assert.equal(calls, 1);
});
async function active() {
  const state = new State(); await state.storage.put('job', { id: 'fixture-job', runId: 1, state: 'collecting', startedAt: Date.now(), nextPoll: 0 }); await state.storage.put('lastAccepted', Date.now()); return { state, coordinator: new RefreshCoordinator(state, env) };
}
const metadata = { contentVersion: 'b'.repeat(64), checkedAt: '2026-02-02T00:00:00.000Z', changedAt: '2026-02-01T00:00:00.000Z' };
test('변경 없는 갱신: Pages 동일 버전 및 최신 checkedAt 확인 후 완료', async () => {
  const { coordinator } = await active();
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/actions/runs/') ? { status: 'completed', conclusion: 'success' } : metadata));
  const status = await coordinator.fetch(req('/status')).then(r=>r.json()); assert.equal(status.state, 'unchanged'); assert.equal(status.checkedAt, metadata.checkedAt);
});
test('Pages 아직 이전 시각이면 완료 아님, 이전 데이터 유지', async () => {
  const { coordinator } = await active();
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/actions/runs/') ? { status: 'completed', conclusion: 'success' } : String(url).includes('api.github.com') ? metadata : { ...metadata, checkedAt: '2026-02-01T00:00:00.000Z' }));
  const status = await coordinator.fetch(req('/status')).then(r=>r.json()); assert.equal(status.state, 'verifying'); assert.equal(status.contentVersion, undefined);
});
test('수집/배포 실패와 시간 초과를 구분, 완료로 표시하지 않음', async () => {
  let { state, coordinator } = await active(); globalThis.fetch = async () => new Response(JSON.stringify({ status: 'completed', conclusion: 'failure' }));
  assert.equal((await coordinator.fetch(req('/status')).then(r=>r.json())).state, 'failed');
  await state.storage.put('job', { id: 'old', state: 'queued', startedAt: Date.now() - 1201000 });
  assert.equal((await coordinator.fetch(req('/status')).then(r=>r.json())).state, 'timeout');
});
test('배포 단계 상태와 진행중 요청의 기존 job 반환', async () => {
  const { coordinator } = await active();
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).endsWith('/jobs') ? { jobs: [{ name: 'Deploy updated Pages / Deploy Pages', status: 'in_progress' }] } : { status: 'in_progress' }));
  const status = await coordinator.fetch(req('/refresh')).then(r=>r.json()); assert.equal(status.state, 'deploying'); assert.equal(status.id, 'fixture-job');
});
test('IP 빈도 제한과 전역 30분 갱신 간격', async () => {
  const state = new State(), coordinator = new RefreshCoordinator(state, env); globalThis.fetch = async () => new Response(null, { status: 204 });
  for (let i=0; i<3; i++) await coordinator.fetch(req()); assert.equal((await coordinator.fetch(req())).status, 429);
  await state.storage.put('job', { state: 'complete', startedAt: Date.now() }); const result = await coordinator.fetch(req('/refresh','new')).then(r=>r.json()); assert.equal(result.state, 'cooldown'); assert.ok(result.retryAfter > 1700);
});
test('공개 API 방문자 임의 저장소/URL/재화 거부 및 CORS 설정', async () => {
  const request = new Request('https://refresh/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.ALLOWED_ORIGIN }, body: JSON.stringify({ repository: 'other/repo', stock: 100 }) });
  const response = await worker.fetch(request, env); assert.equal(response.status, 400); assert.equal(response.headers.get('Access-Control-Allow-Origin'), env.ALLOWED_ORIGIN);
  assert.equal((await worker.fetch(new Request('https://refresh/status', { headers: { Origin: 'https://bad.invalid' } }), env)).status, 403);
  const preflight = await worker.fetch(new Request('https://refresh/refresh', { method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGIN } }), env); assert.equal(preflight.status, 204);
});
test('UI 시간 초과 뒤에도 이전 Actions 실행 중이면 새 dispatch 금지', async () => {
  const state = new State(); await state.storage.put('job', { id: 'old', runId: 55, state: 'timeout', startedAt: Date.now() - 3600000 }); await state.storage.put('lastAccepted', Date.now() - 3600000);
  const coordinator = new RefreshCoordinator(state, env); let calls = 0;
  globalThis.fetch = async url => { assert.ok(!String(url).endsWith('dispatches')); calls++; return new Response(JSON.stringify({ status: 'in_progress' })); };
  assert.equal((await coordinator.fetch(req()).then(r => r.json())).state, 'timeout'); assert.equal(calls, 1);
});
test('Turnstile 검증 요청도 사전에 빈도 제한, Secret/계산 입력 전달 없음', async () => {
  let verifies = 0;
  const state = new State(); const coordinator = new RefreshCoordinator(state, env);
  const configured = { ...env, TURNSTILE_SECRET: 'TEST_ONLY_TURNSTILE', REFRESH_COORDINATOR: { idFromName: name => name, get: () => ({ fetch: request => coordinator.fetch(request) }) } };
  globalThis.fetch = async url => { assert.equal(String(url), 'https://challenges.cloudflare.com/turnstile/v0/siteverify'); verifies++; return new Response(JSON.stringify({ success: false })); };
  for (let i = 0; i < 3; i++) {
    const request = new Request('https://refresh/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' }, body: '{"turnstileToken":"test"}' });
    assert.equal((await worker.fetch(request, configured)).status, 403);
  }
  const fourth = new Request('https://refresh/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' }, body: '{"turnstileToken":"test"}' });
  assert.equal((await worker.fetch(fourth, configured)).status, 429); assert.equal(verifies, 3);
});
