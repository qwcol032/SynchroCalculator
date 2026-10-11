import { parse } from 'acorn';
import { createHash } from 'node:crypto';
export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export async function fetchText(url, fetcher = fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('원본 수집에는 HTTPS만 허용됩니다.');
  const response = await fetcher(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'SynchroCalculator-data-collector/1.0' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}. 네트워크 허용 목록과 원본 접근을 확인하세요.`);
  const text = await response.text();
  if (text.length > 20_000_000) throw new Error('원본 크기 제한 초과');
  return text;
}
export function scriptURLs(html, page) {
  return [...new Set([...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(m => new URL(m[1].replaceAll('&amp;', '&'), page).href))];
}
export function jsonURLs(text, base) {
  const decoded = text.replaceAll('\\/', '/').replaceAll('\\u002F', '/');
  return [...new Set([...decoded.matchAll(/(?:https:\/\/[^\s"'<>`\\]+|\/[\w./-]+)\.json(?:\?[^\s"'<>`\\]*)?/g)].map(m => new URL(m[0], base).href))];
}
export function extractSynchro(text, config = {}) {
  const data = JSON.parse(text); const tables = [];
  if (Array.isArray(data.records) && data.records.some(r => r.type === 'SynchroLevel')) {
    const records = data.records.filter(r => r.type === 'SynchroLevel' || (config.costDirection === 'departure' && r.type === 'CharacterLevel' && r.level === 200));
    return records.map(row => ({ level: row.level, credit: row.gold, battle: row.character_exp, core: row.character_exp_2, sourceType: row.type }));
  }
  const visit = v => {
    if (!v || typeof v !== 'object') return;
    const values = Array.isArray(v) ? v : Object.values(v);
    if (values.length && values.every(x => x && typeof x === 'object' && 'SynchroLevel' in x)) tables.push(values);
    else values.forEach(visit);
  };
  visit(data);
  if (tables.length !== 1) throw new Error(`SynchroLevel 테이블이 ${tables.length}개입니다. 원본 구조를 확인하세요.`);
  return tables[0].map(row => ({ level: Number(row.SynchroLevel), credit: row.gold, battle: row.character_exp, core: row.character_exp_2 }));
}
function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (node.type) fn(node);
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(child => walk(child, fn)); else if (value && typeof value === 'object') walk(value, fn);
}
function literal(node) {
  if (node?.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (node?.type === 'ArrayExpression') return node.elements.map(literal);
  if (node?.type === 'ObjectExpression') return Object.fromEntries(node.properties.map(p => {
    if (p.type !== 'Property' || p.computed) throw new Error('동적 원본 배열은 지원하지 않습니다.');
    return [p.key.name ?? p.key.value, literal(p.value)];
  }));
  throw new Error('정적 숫자 원본이 아닙니다.');
}
export function extractOutpost(text, config) {
  let ast;
  try { ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' }); } catch { ast = parse(text, { ecmaVersion: 'latest', sourceType: 'script' }); }
  const arrays = new Map();
  walk(ast, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') try {
      const value = literal(node.init); if (Array.isArray(value)) arrays.set(node.id.name, value);
    } catch { /* Never evaluate downloaded JavaScript. */ }
  });
  // Semantic discovery only. Opaque/minified identifiers require the configurable mapping.
  const aliases = { credit: /^(?:credits?|gold)(?:income|data|rates?|array)?$/i, battle: /^(?:battledata|characterexp)(?:income|data|rates?|array)?$/i, core: /^(?:coredust|characterexp2)(?:income|data|rates?|array)?$/i };
  const semantic = {};
  walk(ast, node => {
    if (node.type !== 'Property') return;
    const r = ({ credits: 'credit', battleData: 'battle', coreDust: 'core' })[node.key.name ?? node.key.value];
    if (!r || node.value?.type !== 'CallExpression' || node.value.callee?.type !== 'MemberExpression' || node.value.callee.property.name !== 'map') return;
    const name = node.value.callee.object.name; if (arrays.get(name)?.length >= config.minimumOutpostRange[1]) semantic[r] = name;
  });
  const mapping = config.outpostArrays ?? (Object.keys(semantic).length === 3 ? semantic : null) ?? Object.fromEntries(Object.entries(aliases).map(([r, re]) => {
    const candidates = [...arrays.keys()].filter(name => re.test(name.replaceAll('_', '')));
    if (candidates.length !== 1) throw new Error(`${r} 수익 배열을 의미로 확인할 수 없습니다. source-config.json의 outpostScript/outpostArrays를 지정하세요. 정적 배열 후보: ${[...arrays.keys()].join(', ') || '없음'}`);
    return [r, candidates[0]];
  }));
  const selected = Object.fromEntries(Object.entries(mapping).map(([r, name]) => [r, arrays.get(name)]));
  for (const r of ['credit', 'battle', 'core']) if (!Array.isArray(selected[r]) || !selected[r].length || !selected[r].every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0)) throw new Error(`${r}: 선택된 원본 배열이 유효한 비음수 숫자 배열이 아닙니다.`);
  const n = selected.credit.length;
  if (selected.battle.length !== n || selected.core.length !== n) throw new Error('전초기지 배열 길이 불일치');
  // Decimal arithmetic, not binary floating point multiplication.
  const multiply = (v, factor) => {
    const str = String(v); if (!/^\d+(?:\.\d{1,3})?$/.test(str)) throw new Error('환산 전 수치가 소수 3자리를 넘습니다. 환산 정확도를 검토하세요.');
    const [a, b = ''] = str.split('.'); const milli = BigInt(a) * 1000n + BigInt(b.padEnd(3, '0'));
    const micro = milli * BigInt(factor); return `${micro / 1000000n}.${String(micro % 1000000n).padStart(6, '0')}`;
  };
  return Array.from({ length: n }, (_, i) => ({ level: config.outpostStartLevel + i, credit: multiply(selected.credit[i], 18), battle: multiply(selected.battle[i], 18), core: multiply(selected.core[i], 6) }));
}
export function ensureCoverage(rows, minimum, label) {
  rows.sort((a, b) => a.level - b.level);
  if (!rows.length || rows[0].level > minimum[0] || rows.at(-1).level < minimum[1]) throw new Error(`${label}: 필수 지원 범위 ${minimum.join('~')}가 원본에 없습니다.`);
  for (let i = 0; i < rows.length; i++) {
    if (!Number.isSafeInteger(rows[i].level) || (i && rows[i].level !== rows[i - 1].level + 1)) throw new Error(`${label}: 중복/누락/비정수 레벨`);
    for (const r of ['credit', 'battle', 'core']) if (rows[i][r] === null || rows[i][r] === undefined || !/^\d+(?:\.\d{1,6})?$/.test(String(rows[i][r]))) throw new Error(`${label}: ${rows[i].level} ${r} 필수 수치 오류`);
  }
  return { min: rows[0].level, max: rows.at(-1).level };
}
export async function collectSources(config, fetcher = fetch) {
  const diagnostics = [];
  let synchroPage = '', candidates = [];
  try {
    synchroPage = await fetchText(config.synchroPage, fetcher);
    candidates.push(...jsonURLs(synchroPage, config.synchroPage));
    for (const url of scriptURLs(synchroPage, config.synchroPage).filter(u => new URL(u).origin === new URL(config.synchroPage).origin).slice(0, 30)) {
      try { const bundle = await fetchText(url, fetcher); candidates.push(...jsonURLs(bundle, url));
        const resolved = blablaDataURL(bundle); if (resolved) candidates.unshift(resolved); } catch (error) { diagnostics.push(error.message); }
    }
  } catch (error) { diagnostics.push(error.message); }
  candidates = [...new Set(candidates)];
  const discovered = new Set(candidates);
  if (config.synchroFallback && !discovered.has(config.synchroFallback)) candidates.push(config.synchroFallback);
  let synchro, synchroSource;
  for (const url of candidates) {
    try { const text = await fetchText(url, fetcher); const rows = extractSynchro(text, config); ensureCoverage(rows, config.minimumSynchroRange, '싱크로'); synchro = rows; synchroSource = { url, version: JSON.parse(text).version ?? null, sha256: sha256(text), discovery: discovered.has(url) ? 'page-reference' : 'configured-fallback' }; break; } catch (error) { diagnostics.push(error.message); }
  }
  if (!synchro) throw new Error(`싱크로 원본 탐색 실패:\n${diagnostics.join('\n')}`);
  const html = await fetchText(config.outpostPage, fetcher);
  let outpostCandidates = config.outpostScript ? [config.outpostScript] : [config.outpostPage, ...scriptURLs(html, config.outpostPage)];
  if (!config.outpostScript) {
    const scripts = new Map();
    for (const url of scriptURLs(html, config.outpostPage).filter(u => u.includes('/dotgg-game/') && /(?:runtime|main)\./.test(u))) scripts.set(url, await fetchText(url, fetcher));
    const main = [...scripts].find(([u]) => /\/main\./.test(u)); const runtime = [...scripts].find(([u]) => /\/runtime\./.test(u));
    if (main && runtime) { const discovered = webpackToolChunk(main[1], runtime[1], runtime[0]); if (discovered) outpostCandidates.unshift(discovered); }
  }
  let outpost, outpostSource;
  for (const url of outpostCandidates) try {
    const text = url === config.outpostPage ? [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n') : await fetchText(url, fetcher);
    const rows = extractOutpost(text, config); ensureCoverage(rows, config.minimumOutpostRange, '전초기지');
    outpost = rows; outpostSource = { url, page: config.outpostPage, sha256: sha256(text) }; break;
  } catch (error) { diagnostics.push(error.message); }
  if (!outpost) throw new Error(`전초기지 원본 탐색 실패:\n${diagnostics.join('\n')}`);
  if (!['arrival', 'departure'].includes(config.costDirection) || !config.costDirectionEvidence || typeof config.researchIncluded !== 'boolean' || !config.researchEvidence) throw new Error('원본은 읽었지만 비용 방향/연구 포함 여부가 미확인입니다. source-config.json의 costDirection, costDirectionEvidence, researchIncluded, researchEvidence를 원본 근거로 설정하세요. 초기값을 추정하지 않습니다.');
  return { synchro, outpost, sources: { synchro: synchroSource, outpost: outpostSource }, diagnostics };
}
// The page obfuscates a logical resource path rather than publishing a manifest.
// Reproduce only its audited hash transform; never eval/execute remote code.
export function blablaDataURL(bundle) {
  const logical = bundle.match(/getLevelCost\(\)[\s\S]{0,160}?getGameJsonResource\([`"']([^`"']+)[`"']/)?.[1];
  const host = bundle.match(/getNikkeStaticGameResouce=\w+=>`(https:\/\/[^`$]+)\$/)?.[1];
  const prime = bundle.match(/LARGE_PRIMES=\[(\d+),/)?.[1];
  if (!logical || !host || !prime || !bundle.includes('createNormalObfuscatedPath=function') || !bundle.includes('str2md5(ee)') || !bundle.includes('ie*33+ee.charCodeAt(ae)&4294967295')) return null;
  const path = logical.replace(/^\//, ''); const parts = path.split('/');
  if (parts.length !== 2) return null;
  const p = Number(prime); let n = p;
  for (let i = 0; i < path.length; i++) n = (n * 33 + path.charCodeAt(i)) & 4294967295;
  const m = ((n % p) + p) % p;
  const folder = String.fromCharCode(97 + Math.floor(m / 26) % 26, 97 + m % 26) + '-' + String(m % 99).padStart(2, '0');
  return `${host}/${folder}/${createHash('md5').update(path).digest('hex')}.${parts[1].split('.').slice(1).join('.')}`;
}
function staticExpression(node, variables) {
  if (node.type === 'Literal') return node.value;
  if (node.type === 'Identifier' && node.name in variables) return variables[node.name];
  if (node.type === 'BinaryExpression' && node.operator === '+') return staticExpression(node.left, variables) + staticExpression(node.right, variables);
  if (node.type === 'ObjectExpression') return Object.fromEntries(node.properties.map(p => [p.key.value ?? p.key.name, staticExpression(p.value, variables)]));
  if (node.type === 'MemberExpression') return staticExpression(node.object, variables)[node.computed ? staticExpression(node.property, variables) : node.property.name];
  throw new Error('지원하지 않는 chunk URL 정적 표현식');
}
export function webpackToolChunk(main, runtime, url) {
  const id = main.match(/\.e\((\d+)\)\.then\(\(\)=>\w+\(\d+\)\)[\s\S]{0,160}?OutpostCalculator/)?.[1];
  if (!id) return null;
  const ast = parse(runtime, { ecmaVersion: 'latest' }); let prefix, suffix;
  walk(ast, node => {
    if (node.type !== 'AssignmentExpression' || node.left.type !== 'MemberExpression') return;
    if (node.left.property.name === 'p' && node.right.type === 'Literal') prefix = node.right.value;
    if (node.left.property.name === 'u' && node.right.type === 'ArrowFunctionExpression' && node.right.params.length === 1) {
      try { suffix = staticExpression(node.right.body, { [node.right.params[0].name]: +id }); } catch { /* No speculative execution. */ }
    }
  });
  return prefix && suffix && !suffix.includes('undefined') ? new URL(prefix + suffix, url).href : null;
}
