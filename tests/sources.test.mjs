import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractOutpost, ensureCoverage, collectSources } from '../scripts/sources.mjs';
import { updateData } from '../scripts/collect.mjs';
import { config, sourceFetcher } from './fixtures.mjs';
test('최신 페이지 실제 참조 탐색 및 0.018/0.006 환산', async () => {
  const result = await collectSources(config, sourceFetcher()); assert.equal(result.sources.synchro.url, 'https://test.invalid/latest.json');
  assert.equal(result.outpost[0].credit, '18.000000'); assert.equal(result.outpost[0].core, '6.000000'); assert.equal(result.sources.synchro.discovery, 'page-reference');
});
test('축약 변수명 설정 가능, 임의 코드 실행 금지, 수치 오류 거부', () => {
  const cfg = { ...config, outpostArrays: { credit: 'a', battle: 'b', core: 'c' } };
  assert.equal(extractOutpost('const a=[1000,2000],b=[1000,2000],c=[1000,2000];', cfg)[0].credit, '18.000000');
  assert.throws(() => extractOutpost('const a=[process.exit()],b=[1],c=[1];', cfg));
  assert.throws(() => extractOutpost('const a=[1],b=[1],c=[1];', config));
  assert.throws(() => ensureCoverage([{ level: 201, credit: -1, battle: 1, core: 1 }], [201,201], 'test'));
});
test('원본 비용 방향과 연구 수익 근거가 없으면 갱신 거부', async () => {
  await assert.rejects(collectSources({ ...config, costDirection: null }, sourceFetcher()), /미확인/);
});
test('정상 갱신, 변경 없는 확인과 실제 변경 시각 구분, 실패 시 기존 파일 보존', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synchro-data-')); const output = join(dir, 'data.json');
  const first = await updateData(config, output, sourceFetcher(), '2026-01-01T00:00:00.000Z'); assert.equal(first.changed, true);
  const second = await updateData(config, output, sourceFetcher(), '2026-01-02T00:00:00.000Z'); assert.equal(second.changed, false); assert.equal(second.data.changedAt, first.data.changedAt); assert.notEqual(second.data.checkedAt, first.data.checkedAt);
  const saved = await readFile(output, 'utf8');
  await assert.rejects(updateData(config, output, sourceFetcher({ malformed: true }))); assert.equal(await readFile(output, 'utf8'), saved);
  await assert.rejects(updateData(config, output, async () => new Response('', { status: 503 }))); assert.equal(await readFile(output, 'utf8'), saved);
  const third = await updateData(config, output, sourceFetcher({ credit: 2000 }), '2026-01-03T00:00:00.000Z'); assert.equal(third.changed, true); assert.equal(third.data.changedAt, third.data.checkedAt);
});
