const ACTIVE = new Set(['queued', 'collecting', 'deploying', 'verifying']);
const terminal = new Set(['complete', 'unchanged', 'failed', 'timeout']);
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const safeInt = (value, fallback, min, max) => /^\d+$/.test(String(value)) && +value >= min && +value <= max ? +value : fallback;
function checkConfig(env) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.REPOSITORY ?? '') || !/^[\w./-]+$/.test(env.BRANCH ?? '') || !/^[\w.-]+\.ya?ml$/.test(env.WORKFLOW ?? '') || !env.GITHUB_TOKEN) throw new Error('운영자 GitHub 설정 또는 Secret이 없습니다.');
  const pages = new URL(env.PAGES_DATA_URL);
  if (pages.protocol !== 'https:' || pages.origin !== env.ALLOWED_ORIGIN || pages.pathname !== `/${env.REPOSITORY.split('/')[1]}/data/data.json` || pages.search || pages.hash) throw new Error('운영자 Pages 데이터 주소 설정 오류');
}
async function rateIdentity(request) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url); const origin = request.headers.get('Origin');
    const cors = { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' };
    if (origin && origin !== env.ALLOWED_ORIGIN) return response({ message: '허용되지 않은 Origin입니다.' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!((url.pathname === '/refresh' && request.method === 'POST') || (url.pathname === '/status' && request.method === 'GET'))) return response({ message: '지원하지 않는 경로 또는 메서드입니다.' }, 404, cors);
    try {
      checkConfig(env);
      let rateChecked = false;
      if (request.method === 'POST') {
        if (!request.headers.get('Content-Type')?.startsWith('application/json')) return response({ message: 'JSON 요청이 필요합니다.' }, 415, cors);
        const reader = request.body?.getReader(); const chunks = []; let size = 0;
        if (reader) while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 4096) { await reader.cancel(); return response({ message: '요청 크기 제한 초과' }, 413, cors); } chunks.push(value);
        }
        const combined = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
        const body = new TextDecoder().decode(combined);
        let parsed; try { parsed = JSON.parse(body); } catch { return response({ message: '잘못된 JSON 요청' }, 400, cors); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(k => k !== 'turnstileToken')) return response({ message: '요청에 허용되지 않은 필드가 있습니다.' }, 400, cors);
        if (env.TURNSTILE_SECRET) {
          const stub = env.REFRESH_COORDINATOR.get(env.REFRESH_COORDINATOR.idFromName('global-refresh-v1'));
          const gate = await stub.fetch(new Request('https://coordinator/rate', { method: 'POST', headers: { 'X-Rate-Key': await rateIdentity(request) } }));
          if (gate.status !== 200) return new Response(gate.body, { status: gate.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
          rateChecked = true;
          if (typeof parsed.turnstileToken !== 'string' || !parsed.turnstileToken) return response({ message: '봇 방지 확인을 완료하세요.' }, 403, cors);
          const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: parsed.turnstileToken, remoteip: request.headers.get('CF-Connecting-IP') ?? '' }), signal: AbortSignal.timeout(6000) }).then(r => r.json());
          if (!result.success || result.hostname !== new URL(env.ALLOWED_ORIGIN).hostname) return response({ message: '봇 방지 검증 실패' }, 403, cors);
        }
      }
      // Cloudflare supplies this header. Never forward a visitor-supplied target URL.
      const key = await rateIdentity(request);
      const stub = env.REFRESH_COORDINATOR.get(env.REFRESH_COORDINATOR.idFromName('global-refresh-v1'));
      const result = await stub.fetch(new Request(`https://coordinator${url.pathname}`, { method: request.method, headers: { 'X-Rate-Key': key, 'X-Rate-Checked': rateChecked ? '1' : '0' } }));
      return new Response(result.body, { status: result.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    } catch { return response({ state: 'failed', message: '갱신 서버 설정 또는 연결 오류입니다. 기존 데이터로 계산할 수 있습니다.' }, 503, cors); }
  }
};
export class RefreshCoordinator {
  constructor(state, env) { this.ctx = state; this.env = env; }
  async github(path, options = {}) {
    const result = await fetch(`https://api.github.com/repos/${this.env.REPOSITORY}${path}`, {
      ...options, signal: AbortSignal.timeout(6000), headers: { Authorization: `Bearer ${this.env.GITHUB_TOKEN}`, Accept: options.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'SynchroCalculator-refresh', 'Content-Type': 'application/json' }
    });
    if (!result.ok) throw new Error(`GitHub API HTTP ${result.status}`);
    return result.status === 204 ? null : result.json();
  }
  async limited(key, method, now) {
    const globalKey = `rate:global:${method}`;
    const globalOld = await this.ctx.storage.get(globalKey);
    const bucket = !globalOld || now - globalOld.start >= 60000 ? { start: now, count: 0, expires: now + 600000 } : globalOld;
    bucket.count++; await this.ctx.storage.put(globalKey, bucket);
    if (bucket.count > (method === 'POST' ? 60 : 600)) return true;
    const id = `rate:${key}:${method}`; const old = await this.ctx.storage.get(id);
    const entry = !old || now - old.start >= 60000 ? { start: now, count: 0, expires: now + 600000 } : old;
    entry.count++; await this.ctx.storage.put(id, entry);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(now + 600000);
    return entry.count > (method === 'POST' ? 3 : 10);
  }
  async alarm() {
    const now = Date.now(); const entries = await this.ctx.storage.list({ prefix: 'rate:' });
    const expired = [...entries].filter(([, value]) => value.expires <= now).map(([key]) => key);
    for (let i = 0; i < expired.length; i += 128) await this.ctx.storage.delete(expired.slice(i, i + 128));
    if (entries.size > expired.length) await this.ctx.storage.setAlarm(now + 600000);
  }
  async fetch(request) {
    // Durable Object's persistent input gate serializes reads, reservation, and
    // dispatch across isolates. An accepted job is persisted BEFORE any API call.
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now(); const path = new URL(request.url).pathname;
      let job = await this.ctx.storage.get('job');
      if (request.headers.get('X-Rate-Checked') !== '1' && await this.limited(request.headers.get('X-Rate-Key') ?? 'unknown', request.method, now)) return response({ ...(job ?? { state: 'idle' }), rateLimited: true, message: '요청 빈도 제한입니다. 잠시 뒤 다시 시도하세요.' }, 429);
      if (path === '/rate') return response({ allowed: true });
      if (job && ACTIVE.has(job.state)) {
        if (now - job.startedAt > safeInt(this.env.TIMEOUT_SECONDS, 1200, 60, 3600) * 1000) job = { ...job, state: 'timeout', message: '전체 갱신 대기시간 초과. 기존 데이터는 유지됩니다.' };
        else if (now >= (job.nextPoll ?? 0)) job = await this.poll(job, now);
        await this.ctx.storage.put('job', job);
      }
      if (path === '/status' || (job && ACTIVE.has(job.state))) return response(job ?? { state: 'idle' });
      // A UI deadline does not cancel the GitHub run. Before replacing a timed
      // out job, prove that the previous execution is no longer active.
      if (job?.state === 'timeout') {
        try {
          let running;
          if (job.runId) running = (await this.github(`/actions/runs/${job.runId}`)).status !== 'completed';
          else {
            const lists = await Promise.all(['in_progress', 'queued', 'waiting', 'requested', 'pending'].map(status => this.github(`/actions/workflows/${this.env.WORKFLOW}/runs?branch=${encodeURIComponent(this.env.BRANCH)}&event=workflow_dispatch&status=${status}&per_page=100`)));
            running = lists.some(list => list.workflow_runs.length > 0);
          }
          if (running) return response({ ...job, message: '대기시간은 초과했지만 이전 Actions 실행이 아직 진행 중입니다. 중복 실행을 요청하지 않습니다.' });
        } catch {
          return response({ ...job, message: '이전 실행의 종료를 확인하지 못했습니다. 중복 실행을 막고 기존 데이터를 유지합니다.' });
        }
      }
      const nextAllowed = (await this.ctx.storage.get('lastAccepted') ?? 0) + safeInt(this.env.COOLDOWN_SECONDS, 1800, 60, 86400) * 1000;
      if (now < nextAllowed) return response({ ...(job ?? {}), state: 'cooldown', retryAfter: Math.ceil((nextAllowed - now) / 1000), message: `다음 갱신까지 ${Math.ceil((nextAllowed - now) / 60000)}분. 기존 상태는 /status에서 확인할 수 있습니다.` }, 429);
      job = { id: crypto.randomUUID(), state: 'queued', startedAt: now, nextPoll: now + 15000 };
      await this.ctx.storage.put({ job, lastAccepted: now });
      try {
        await this.github(`/actions/workflows/${this.env.WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: this.env.BRANCH, inputs: { job_id: job.id } }) });
      } catch (error) {
        // Network timeouts may happen AFTER GitHub accepts the dispatch; do not
        // resend. Poll by correlation id until the overall deadline instead.
        if (error.message.startsWith('GitHub API HTTP')) job = { ...job, state: 'failed', message: 'GitHub 실행 요청 실패. 운영자가 Actions 권한과 workflow를 확인해야 합니다.' };
        else job.message = '실행 요청 응답을 확인하지 못했습니다. 중복 요청 없이 실행 상태를 확인합니다.';
        await this.ctx.storage.put('job', job);
      }
      return response(job, terminal.has(job.state) ? 502 : 202);
    });
  }
  async poll(job, now) {
    const next = { ...job, nextPoll: now + 15000 }; delete next.message;
    try {
      if (!next.runId) {
        const runs = await this.github(`/actions/workflows/${this.env.WORKFLOW}/runs?branch=${encodeURIComponent(this.env.BRANCH)}&event=workflow_dispatch&per_page=100`);
        const run = runs.workflow_runs.find(r => r.display_title === `data-update ${job.id}`);
        if (!run) return next;
        next.runId = run.id;
      }
      const run = await this.github(`/actions/runs/${next.runId}`);
      if (run.status !== 'completed') {
        next.state = run.status === 'queued' || run.status === 'waiting' ? 'queued' : 'collecting';
        const jobs = await this.github(`/actions/runs/${next.runId}/jobs`);
        if (jobs.jobs.some(j => /deploy/i.test(j.name) && j.status !== 'queued') || jobs.jobs.some(j => j.steps?.some(s => /Deploy Pages|Build site|Upload Pages/i.test(s.name) && s.status !== 'queued' && s.status !== 'pending'))) next.state = 'deploying';
        return next;
      }
      if (run.conclusion !== 'success') return { ...next, state: 'failed', message: '수집·검증 또는 Pages 배포 실패. 기존 정상 데이터는 유지됩니다.' };
      next.state = 'verifying';
      const expected = await this.github(`/contents/public/data/data.json?ref=${encodeURIComponent(this.env.BRANCH)}`, { raw: true });
      if (!/^[a-f0-9]{64}$/.test(expected.contentVersion ?? '') || !Number.isFinite(Date.parse(expected.checkedAt))) throw new Error('데이터 메타데이터 오류');
      const url = new URL(this.env.PAGES_DATA_URL); url.searchParams.set('checked', expected.checkedAt);
      const served = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!served.ok) return next;
      const actual = await served.json();
      if (actual.contentVersion !== expected.contentVersion || actual.checkedAt !== expected.checkedAt) return next;
      const previous = await this.ctx.storage.get('lastVersion');
      // changedAt remains stable when a collector confirms unchanged data.
      const unchanged = previous ? previous === actual.contentVersion : actual.changedAt !== actual.checkedAt;
      await this.ctx.storage.put('lastVersion', actual.contentVersion);
      return { ...next, state: unchanged ? 'unchanged' : 'complete', checkedAt: actual.checkedAt, changedAt: actual.changedAt, contentVersion: actual.contentVersion, message: unchanged ? '최신 데이터 확인 완료' : 'Pages의 새 데이터를 확인했습니다.' };
    } catch { return { ...next, message: '실행 상태 연결을 재시도합니다. 기존 데이터는 유지됩니다.' }; }
  }
}
