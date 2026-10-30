import { test, expect } from '@playwright/test';
import { fixture } from '../fixtures.mjs';
import { readFileSync } from 'node:fs';
const realData = JSON.parse(readFileSync(new URL('../../public/data/data.json', import.meta.url)));
test('실제 데이터가 없으면 샘플 계산 없이 안내', async ({ page }) => {
  await page.route('**/data/data.json?*', route => route.fulfill({ status: 404, body: '' }));
  await page.goto('/SynchroCalculator/'); await expect(page.locator('#data-error')).toContainText('검증된 실제 데이터'); await expect(page.locator('#calculate')).toBeDisabled();
  await page.locator('#refresh').click(); await expect(page.locator('#update-state')).toContainText('설정되지 않았습니다');
});
test('하위 경로, WASM 정수 계산, 재고만 목표 달성, 입력 유지와 모바일', async ({ page }) => {
  // Only this test intercepts data. No fixture exists in the public site.
  await page.route('**/data/data.json?*', route => route.fulfill({ json: fixture() }));
  await page.goto('/SynchroCalculator/'); await expect(page.locator('#calculate')).toBeEnabled();
  await page.locator('[name=outpost]').fill('1'); await page.locator('[name=current]').fill('200'); await page.locator('[name=target]').fill('201');
  await page.locator('[name=stock_credit]').fill('0.1'); await page.locator('[name=stock_battle]').fill('0.1'); await page.locator('[name=stock_core]').fill('100');
  const outgoing = []; page.on('request', request => { if (new URL(request.url()).origin !== 'http://127.0.0.1:4173') outgoing.push(request.url()); });
  await page.locator('#calculate').click(); await expect(page.locator('#results')).toContainText('목표 레벨 달성 가능', { timeout: 30000 }); await expect(page.locator('#results')).toContainText('최소 205레벨 도달 가능');
  await page.reload(); await expect(page.locator('[name=stock_core]')).toHaveValue('100');
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(outgoing).toEqual([]);
});
test('빈 필수 레벨 오류, 목표 낮음, 음수 아이템', async ({ page }) => {
  await page.route('**/data/data.json?*', route => route.fulfill({ json: fixture() })); await page.goto('/SynchroCalculator/'); await page.locator('#calculate').click(); await expect(page.locator('#input-error')).toContainText('현재 싱크로');
  await page.locator('[name=current]').fill('202'); await page.locator('[name=target]').fill('201'); await page.locator('[name=outpost]').fill('1'); await page.locator('#calculate').click(); await expect(page.locator('#input-error')).toContainText('목표 레벨');
  await page.locator('[name=target]').fill('203'); await page.locator('[name=supply]').fill('-1'); await page.locator('#calculate').click(); await expect(page.locator('#input-error')).toContainText('보급물자');
});
test('Worker 실패에도 기존 데이터와 사용자 입력 유지', async ({ page }) => {
  await page.route('**/config.json', route => route.fulfill({ json: { workerUrl: 'https://worker.test' } }));
  await page.route('**/data/data.json?*', route => route.fulfill({ json: fixture() }));
  await page.route('https://worker.test/refresh', route => { expect(JSON.parse(route.request().postData())).toEqual({}); return route.fulfill({ status: 502, json: { state: 'failed', message: '배포 실패' }, headers: { 'Access-Control-Allow-Origin': '*' } }); });
  await page.goto('/SynchroCalculator/'); await page.locator('[name=stock_core]').fill('123'); await page.locator('#refresh').click(); await expect(page.locator('#update-state')).toContainText('기존 데이터와 입력은 유지'); await expect(page.locator('[name=stock_core]')).toHaveValue('123'); await expect(page.locator('#calculate')).toBeEnabled();
});
test('저장된 실제 JSON과 브라우저 WASM으로 200→201 계산', async ({ page }) => {
  await page.goto('/SynchroCalculator/'); await expect(page.locator('#calculate')).toBeEnabled();
  await page.locator('[name=outpost]').fill('800'); await page.locator('[name=current]').fill('200'); await page.locator('[name=target]').fill('201');
  const row = realData.synchro.find(r => r.level === 200);
  await page.locator('[name=stock_credit]').fill(String(row.credit / 1000)); await page.locator('[name=stock_battle]').fill(String(row.battle / 1000)); await page.locator('[name=stock_core]').fill(String(row.core));
  await page.locator('#calculate').click(); await expect(page.locator('#results')).toContainText('목표 레벨 달성 가능', { timeout: 30000 }); await expect(page.locator('#results')).toContainText(row.battle.toLocaleString('ko-KR'));
});

test('그로우 입력 유지·고정 지급·시간 가치 계획과 모바일 표시', async ({ page }) => {
  await page.route('**/data/data.json?*', route => route.fulfill({ json: fixture() }));
  await page.goto('/SynchroCalculator/'); await expect(page.locator('#calculate')).toBeEnabled();
  await page.locator('[name=academy]').uncheck();
  await page.locator('[name=outpost]').fill('1'); await page.locator('[name=current]').fill('200'); await page.locator('[name=target]').fill('201');
  await page.locator('[name=stock_credit]').fill('0.01'); await page.locator('[name=grow]').fill('2');
  await expect(page.locator('#grow-value')).toContainText('11794.400000시간');
  await page.locator('#calculate').click();
  await expect(page.locator('#results')).toContainText('목표 달성 · 최소 시간 가치 계획', { timeout: 30000 });
  await expect(page.locator('#results')).toContainText('88,458'); await expect(page.locator('#results')).toContainText('그로우 업 0개');
  await page.reload(); await expect(page.locator('[name=grow]')).toHaveValue('2');
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('회귀: 747 전초기지 867→881 전체 계산과 36초 기준 표시', async ({ page }) => {
  test.setTimeout(90000);
  const raw = { outpost: '747', current: '867', target: '881', academy: true,
    stock_credit: '21298', unit_credit: 'K', stock_battle: '29938', unit_battle: 'K', stock_core: '4683', unit_core: 'base',
    case_credit_1: '451', case_credit_2: '111', case_credit_8: '10', case_credit_12: '5', case_credit_24: '2',
    case_battle_1: '574', case_battle_2: '333', case_battle_8: '8', case_battle_12: '15', case_battle_24: '2',
    case_core_1: '618', case_core_2: '60', case_core_8: '1', case_core_12: '3', case_core_24: '2', supply: '398', day: '248', grow: '450' };
  await page.goto('/SynchroCalculator/'); await expect(page.locator('#calculate')).toBeEnabled();
  for (const [name, value] of Object.entries(raw)) {
    const field = page.locator(`[name=${name}]`);
    if (name === 'academy') await field.setChecked(value);
    else if (name.startsWith('unit_')) await field.selectOption(value);
    else await field.fill(value);
  }
  await page.locator('#calculate').click();
  await expect(page.locator('#results')).toContainText('목표 레벨 달성 가능', { timeout: 60000 });
  await expect(page.locator('#results .max-level')).toHaveText('883 LV');
  await expect(page.locator('#results')).toContainText('계획 전체 최대 36초');
  await expect(page.locator('#input-error')).toBeHidden();
});
