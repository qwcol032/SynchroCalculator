import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import loadHighs from 'highs';
import { validateData, totalCosts, supportedLevels, caseValue, fixed, SCALE } from '../src/data.mjs';
import { calculate } from '../src/optimizer.mjs';
import { inventory } from './fixtures.mjs';
import { blablaDataURL, webpackToolChunk } from '../scripts/sources.mjs';
const data = validateData(JSON.parse(await readFile(new URL('../public/data/data.json', import.meta.url), 'utf8')));
test('실제 초기 원본: 싱크로/전초기지 연속성과 상한', () => {
  assert.ok(data.synchro.length >= 1201); assert.ok(data.outpost.length >= 800); assert.deepEqual(supportedLevels(data), { min: 200, max: data.ranges.synchro.max + 1 });
  assert.equal(data.synchro[0].sourceType, 'CharacterLevel'); assert.ok(data.synchro.slice(1).every(r => r.sourceType === 'SynchroLevel'));
});
test('실제 한 레벨 상승과 비용 변화 경계: 출발 행 350/351, 400/401', () => {
  const row = level => data.synchro.find(r => r.level === level);
  assert.deepEqual(totalCosts(data, 200, 201), { credit: fixed(row(200).credit), battle: fixed(row(200).battle), core: fixed(row(200).core) });
  assert.equal(totalCosts(data, 350, 351).core, fixed(row(350).core)); assert.equal(totalCosts(data, 351, 352).core, fixed(row(351).core));
  assert.equal(totalCosts(data, 400, 401).core, fixed(row(400).core)); assert.equal(totalCosts(data, 401, 402).core, fixed(row(401).core));
  const cap = supportedLevels(data).max;
  assert.equal(totalCosts(data, cap - 1, cap).core, fixed(row(cap - 1).core)); assert.throws(() => totalCosts(data, cap - 1, cap + 1));
  if (data.sources.synchro.sha256 === '524713c04d35d2c3ad57a706c377bc87896c8f0f8f6812f17aeaa50b2b0a80c9') {
    assert.equal(totalCosts(data, 350, 351).core, fixed(10000)); assert.equal(totalCosts(data, 351, 352).core, fixed(11000));
    assert.equal(totalCosts(data, 400, 401).core, fixed(11000)); assert.equal(totalCosts(data, 401, 402).core, fixed(12000));
  }
});
test('실제 전초기지 연구 보너스 및 K/M 표시와 무관한 정밀 지급량', () => {
  const expectedBattle = fixed(data.outpost[0].battle) / BigInt(SCALE) * BigInt(SCALE);
  assert.equal(caseValue(data, 1, false, 'battle', 1), expectedBattle);
  if (data.sources.outpost.sha256 === '67197dec7ddaa8c4b4b566dec5bcf150ba0a77cc349eee89af5ec2ba4d9e4b7c') {
    assert.equal(caseValue(data, 1, true, 'credit', 1), fixed(3456));
    assert.equal(caseValue(data, 800, true, 'core', 24), fixed(3020));
  }
});
test('실제 데이터 상한 전체 누적 비용의 큰 정수 계산과 최대 레벨', async () => {
  const engine = await loadHighs(); const cap = supportedLevels(data).max; const costs = totalCosts(data, 200, cap);
  assert.ok(costs.battle > BigInt(Number.MAX_SAFE_INTEGER));
  const result = calculate(data, inventory({ target: cap, outpost: 800, academy: true, stock: costs }), engine);
  assert.equal(result.possible, true); assert.equal(result.maximum.level, cap); assert.equal(result.maximum.atDataCap, true); assert.deepEqual(result.targetPlan.objective, [0,0,0]);
});
test('Blabla 논리 원본 경로의 페이지 해시 변환 탐색 (단축변수/고정 해시 미사용)', () => {
  const script = 'async function getLevelCost(){return(await getGameJsonResource(`/character/CharacterLevelTable.json`))?.records??[]}; getNikkeStaticGameResouce=xyz=>`https://sg-tools-cdn.blablalink.com${xyz}`; LARGE_PRIMES=[224737,2]; createNormalObfuscatedPath=function(){}; str2md5(ee); ie*33+ee.charCodeAt(ae)&4294967295';
  assert.equal(blablaDataURL(script), 'https://sg-tools-cdn.blablalink.com/dv-15/e8b9e7f748f8734b2848842b47bf1cb2.json');
  assert.equal(blablaDataURL('unrecognized format'), null);
});
test('Webpack 런타임과 OutpostCalculator 실제 참조로 청크 URL 탐색', () => {
  const main = 'X={loader:async()=>await n.e(123).then(()=>n(234)),render(e){return e.OutpostCalculator}}';
  const runtime = 'f.u=e=>"common/js/async/"+e+"."+{123:"latesthash"}[e]+".js";f.p="/wp-content/plugins/dotgg-game/";';
  assert.equal(webpackToolChunk(main, runtime, 'https://nikke.gg/runtime.js'), 'https://nikke.gg/wp-content/plugins/dotgg-game/common/js/async/123.latesthash.js');
});
