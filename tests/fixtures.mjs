// SYNTHETIC TEST DATA ONLY. Never copied to public/ or production bundles.
export function fixture() {
  return { schemaVersion: 1, costDirection: 'arrival', rounding: 'floor-per-case', researchIncluded: false, contentVersion: 'a'.repeat(64), checkedAt: '2026-01-01T00:00:00.000Z', changedAt: '2026-01-01T00:00:00.000Z',
    sources: { synchro: { url: 'https://test.invalid/synchro' }, outpost: { url: 'https://test.invalid/outpost' } },
    ranges: { synchro: { min: 201, max: 205 }, outpost: { min: 1, max: 2 } }, assumptions: ['테스트 전용 가상 데이터'],
    synchro: [201, 202, 203, 204, 205].map(level => ({ level, credit: level < 203 ? 10 : 25, battle: level < 203 ? 10 : 20, core: level < 203 ? 10 : 15 })),
    outpost: [1, 2].map(level => ({ level, credit: 10.5 * level, battle: 7.5 * level, core: 2.5 * level })) };
}
export function inventory(overrides = {}) {
  return { current: 200, target: 201, outpost: 1, academy: false, stock: { credit: 0n, battle: 0n, core: 0n }, cases: Object.fromEntries(['credit', 'battle', 'core'].map(r => [r, { 1: 0, 2: 0, 8: 0, 12: 0, 24: 0 }])), day: 0, supply: 0, ...overrides };
}
export const config = { synchroPage: 'https://test.invalid/synchro-page', synchroFallback: 'https://test.invalid/synchro.json', outpostPage: 'https://test.invalid/outpost', outpostScript: null, outpostArrays: null, outpostStartLevel: 1, costDirection: 'arrival', costDirectionEvidence: '테스트 전용 도달 비용', researchIncluded: false, researchEvidence: '테스트 전용 기본 수익', rounding: 'floor-per-case', minimumSynchroRange: [201, 202], minimumOutpostRange: [1, 2] };
export function sourceFetcher({ malformed = false, credit = 1000 } = {}) {
  return async url => {
    const path = new URL(url).pathname;
    const values = {
      '/synchro-page': '<script src="/sync.js"></script>',
      '/sync.js': 'const source="/latest.json";',
      '/latest.json': JSON.stringify({ table: [201, 202].map(level => ({ SynchroLevel: level, gold: credit, character_exp: 1000, character_exp_2: malformed ? null : 100 })) }),
      '/synchro.json': JSON.stringify({ table: [201, 202].map(level => ({ SynchroLevel: level, gold: credit, character_exp: 1000, character_exp_2: malformed ? null : 100 })) }),
      '/outpost': '<script src="/outpost.js"></script>',
      '/outpost.js': 'const credits=[1000,2000], battleData=[500,600], coreDust=[1000,1200];'
    };
    return new Response(values[path] ?? '', { status: path in values ? 200 : 404 });
  };
}
