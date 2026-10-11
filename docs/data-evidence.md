# 원본 조사 및 계산 가정

2026-10-11 수집. 정규화 JSON의 `checkedAt`이 각 확인의 UTC 시각, `changedAt`은 재화/비용/계산 규칙이 바뀐 마지막 시각이다. 수집 원본 주소와 SHA-256은 `public/data/data.json`의 `sources`에 있다. 콘텐츠 버전은 정규화 재화 데이터와 규칙의 SHA-256이며, 표시 반올림과 무관하다.

## 싱크로

원본은 `{version: "0.0.1", records: [...]}`이며 `SynchroLevel`은 필드명이 아니라 `type`의 값이다. 해당 행은 201~1400의 1,200개. `gold` → 크레딧, `character_exp` → 배틀 데이터, `character_exp_2` → 코어 더스트.

관련 페이지의 최신 `index-*.js`:

```js
async function getLevelCost() {
  return (await getGameJsonResource('/character/CharacterLevelTable.json'))?.records ?? [];
}
```

페이지가 가져오는 `cube-icon-*.js`의 `upgrade_material` 계산:

```js
for (let r = current; r < target; r++) {
  const row = records.find(e => e.level === r);
  // row.gold, row.character_exp, row.character_exp_2 합산
}
```

이 **원본 웹 계산 함수의 출발 레벨 인덱싱**을 채택했다. 200→201에는 같은 원본의 `CharacterLevel` 200행을 사용한다. 200행과 `SynchroLevel` 201행의 비용은 같지만, 비용 변경 경계에서는 인덱싱이 중요하다:

| 상승 구간 | 사용 원본 행 | 코어 더스트 |
|---|---:|---:|
| 200→201 | CharacterLevel 200 | 10,000 |
| 350→351 | SynchroLevel 350 | 10,000 |
| 351→352 | SynchroLevel 351 | 11,000 |
| 400→401 | SynchroLevel 400 | 11,000 |
| 401→402 | SynchroLevel 401 | 12,000 |
| 1400→1401 | SynchroLevel 1400 | 24,000 |

따라서 현재 JSON의 계산 가능 레벨은 200~1401이다. 1401까지 도달해도 이후 비용이 없으므로 정확한 최대라고 표시하지 않는다. 이 해석은 원본 웹 앱의 계산 코드에 근거한다. 해당 UI의 함수는 개별 니케 미리보기에서도 쓰이므로 **실제 게임의 싱크로 경계 지급과 직접 대조한 결과는 아니다**. 운영 중 게임 화면과 다름이 확인되면 `scripts/source-config.json`의 `costDirection`을 `arrival`로 바꾸고 근거를 갱신한다. 이 경우 200 보조 행은 추출하지 않고, 201행을 200→201에 사용하며 상한은 1400이 된다. 인덱싱은 `src/data.mjs` 한곳에서 처리한다.

현재 주소는 MD5 해시지만 페이지의 논리 경로 및 해시 변환 참조로 발견한다. 원격 JavaScript를 실행하지 않고 감사한 경로 변환만 재현한다. 이 변환이 바뀌면 직접 JSON 참조를 찾고, 불가능하면 설정된 `synchroFallback`을 사용한다. 이때 `sources.synchro.discovery`와 수집 경고로 fallback을 구분한다. 원본 `version`도 메타데이터에 남긴다.

## 전초기지

`nikke.gg/tools/outpost/` → 페이지의 현재 `games/nikke/js/main.*.js` → `OutpostCalculator`의 지연 로딩 ID → 페이지의 현재 `runtime.*.js`의 `u`/`p` → 수익 청크 순으로 주소를 찾았다. 800개의 실제 배열 원소가 각각 레벨 1~800에 대응한다. 레벨은 1부터이며 UI도 `level - 1`로 배열을 조회한다. 축약 변수명 `t`, `a`, `l`은 탐색의 기준이 아니다. `credits`, `battleData`, `coreDust` 속성의 `.map` 참조로 각각의 원본 배열을 연결한다.

확인한 청크의 변환과 연구 보너스는 다음과 같다:

```js
const s = (value, interval) => value / interval * 3600 * 1e-4;
// credits: s(rawCredit, 20), battleData: s(rawBattle, 20)
// coreDust: s(rawCore, 60)
const bonuses = { credits: 1.6, battleData: 1.45, coreDust: 1.45 };
// Academy fully researched 체크시에만 별도 함수에서 bonuses 적용
```

따라서 배열은 **연구 보너스 미포함**이고 원본 환산계수는 각각 0.018, 0.018, 0.006이다. 문자열 기반 십진 정수로 환산해서 이진 부동소수 곱셈 오차를 제거했다. 원본 레벨 1의 기본 시간당 수익: 크레딧 2160, 배틀 4439.988, 코어 13.956. 레벨 800: 크레딧 49527.342, 배틀 564579, 코어 86.796.

## 실제 지급량 가정

원본 웹 앱은 시간당 수익의 소수를 그대로 계산하고 compact 표시만 반올림한다. 이 표시가 게임의 케이스 실제 지급 규칙을 증명하지는 않는다. 실제 게임에서 케이스 지급 시 버림/반올림/묶음 사용 처리 규칙은 확인하지 못했다.

기본은 **케이스 한 개별 `floor(기본 시간당 수익 × 연구 배수 × 시간)`**라는 보수적인 가정이다. 여러 케이스를 묶어서 계산한 뒤 한 번만 버리지 않는다. 상자에서 생성된 1시간 케이스에도 동일한 규칙을 적용한다. 가정은 UI에 표시된다. `source-config.json`의 `rounding: "exact"`로 바꾸면 소수를 유지하는 대조 계산이 가능하다. 이후 확인된 게임 규칙은 `caseValue()`를 수정하고 테스트/메타데이터를 함께 갱신한다. 연구 미체크를 지원하는 `researchIncluded` 처리도 이 함수에만 있다.

재화는 소수 6자리까지 BigInt 고정 소수점으로 처리한다. MILP 제약은 케이스 지급량의 최대공약수 단위로 나누고, 부족량을 그 단위의 정수 상한으로 바꾼다. 이것은 제약의 동치 변환이며 표시값 반올림이 아니다. 해는 원래 BigInt 비용·재고로 다시 검증한다. 테스트용 가상 데이터는 `tests/` 안에만 있다.
