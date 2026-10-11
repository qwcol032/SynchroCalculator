import { readFile, writeFile, rename, mkdir, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectSources, sha256, ensureCoverage } from './sources.mjs';
import { validateData } from '../src/data.mjs';
export async function updateData(config, output, fetcher = fetch, now = new Date().toISOString()) {
  const source = await collectSources(config, fetcher);
  const payload = { synchro: source.synchro, outpost: source.outpost, costDirection: config.costDirection, researchIncluded: config.researchIncluded, rounding: config.rounding };
  const version = sha256(payload);
  let old; try { old = JSON.parse(await readFile(output, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const data = { schemaVersion: 1, ...payload, sources: source.sources, checkedAt: now, changedAt: old?.contentVersion === version ? old.changedAt : now, contentVersion: version,
    ranges: { synchro: ensureCoverage(payload.synchro, config.minimumSynchroRange, '싱크로'), outpost: ensureCoverage(payload.outpost, config.minimumOutpostRange, '전초기지') },
    evidence: { costDirection: config.costDirectionEvidence, research: config.researchEvidence },
    assumptions: [config.costDirection === 'departure' ? '레벨 비용은 원본 웹 앱의 출발 레벨 인덱싱을 따릅니다. 게임 클라이언트의 싱크로 경계 비용과 직접 대조하지 않았습니다.' : '레벨 비용은 도달 레벨 행으로 합산합니다. 상세 근거는 데이터 evidence에 기록됩니다.', '실제 지급 규칙 미확인: 케이스 한 개별 소수 버림을 보수적으로 가정합니다. source-config.json의 rounding으로 변경할 수 있습니다.', '입력한 전초기지 레벨은 계산 중 고정됩니다. 자연 획득 재화는 제외합니다.'] };
  validateData(data); // All checks happen before replacing the last known-good file.
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, `${JSON.stringify(data)}\n`, { flag: 'w' });
  await rename(`${output}.tmp`, output);
  return { changed: old?.contentVersion !== version, data, diagnostics: source.diagnostics };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const config = JSON.parse(await readFile(resolve('scripts/source-config.json'), 'utf8'));
    if (process.env.SYNCHRO_SOURCE_URL) config.synchroFallback = process.env.SYNCHRO_SOURCE_URL;
    if (process.env.OUTPOST_SCRIPT_URL) config.outpostScript = process.env.OUTPOST_SCRIPT_URL;
    if (process.env.OUTPOST_ARRAYS) config.outpostArrays = JSON.parse(process.env.OUTPOST_ARRAYS);
    const result = await updateData(config, resolve('public/data/data.json'));
    console.log(result.changed ? '데이터 변경 확인 및 검증 완료' : '최신 데이터 확인 완료 (변경 없음)');
    for (const diagnostic of result.diagnostics) console.warn(diagnostic);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${result.changed}\ncontent_version=${result.data.contentVersion}\nchecked_at=${result.data.checkedAt}\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
