# 니케 싱크로 계산기

한국어 반응형 계산기. 보유 재화·케이스·선택형 상자로 목표 레벨의 최소 아이템 사용 계획과 최대 도달 레벨을 계산합니다. 계산은 브라우저의 Web Worker + HiGHS WebAssembly에서 수행하며 재화/아이템 입력을 서버에 보내지 않습니다. 입력은 해당 브라우저의 localStorage에만 저장됩니다.

- 계산기: GitHub Pages (`/SynchroCalculator/`).
- 데이터 수집·검증·저장·배포: GitHub Actions.
- 비로그인 공개 갱신/상태: Cloudflare Worker + 단일 Durable Object.
- 실제 초기 데이터: `public/data/data.json`. 전초기지 1~800, SynchroLevel 201~1400 및 같은 원본의 CharacterLevel 200 보조 행.
- 원본 웹 계산 함수의 **출발 레벨 비용** 해석으로 계산 레벨 200~1401을 지원합니다. 게임 클라이언트 직접 대조는 미실시입니다. 경계 및 실제 지급량의 미확인 가정은 [원본 조사 기록](docs/data-evidence.md)을 먼저 확인하세요.

## 로컬 실행 (Windows PowerShell)

Node.js **24 이상 LTS**, Git을 설치합니다. 기본 계산에는 Cloudflare 계정이나 GitHub 토큰이 필요하지 않습니다.

```powershell
git clone https://github.com/qwcol032/SynchroCalculator.git
Set-Location SynchroCalculator
npm ci
npm run dev
```

터미널에 표시되는 개발 서버 주소에 `/SynchroCalculator/` 경로를 붙여 접속합니다. 이미 체크아웃된 환경에서는 기존 체크아웃을 사용하세요. cloud task는 자체 격리되어 있으므로 사용자가 요청하지 않았다면 별도 Git worktree를 만들지 않습니다.

```powershell
npm test
npm run build
npm run preview
npx playwright install chromium
npm run test:browser
npx wrangler deploy --dry-run --config worker/wrangler.toml
```

브라우저 테스트는 먼저 `npm run build`가 필요합니다. 기존 Chromium을 쓰는 Linux 클라우드에서는 `$env:CHROMIUM_PATH`에 실제 실행 파일을 지정할 수 있습니다(예: `/usr/bin/chromium`). 테스트는 Playwright가 기본적으로 내려받는 Chromium도 지원합니다. 워커 테스트는 네트워크 모의 응답으로 수행하고, 계산 테스트는 실제 HiGHS를 실행합니다. 작은 재고의 목표 계획 36건과 최대 레벨 12건은 독립적인 완전탐색과 결과를 비교합니다.

원본 데이터가 삭제되거나 검증에 실패하면 계산을 비활성화하고 안내합니다. 샘플을 실제 데이터로 대체하지 않습니다. 공개 Worker가 미설정이어도 저장된 실제 JSON으로 계산할 수 있습니다.

## 원본 수집과 갱신

```powershell
npm run collect
npm test
npm run build
```

수집기는 HTTPS/TLS 검증을 유지합니다. Node 24의 `--use-env-proxy`로 설정된 환경 프록시를 사용합니다. 기본 원본 도메인은 `www.blablalink.com`, `sg-tools-cdn.blablalink.com`, `nikke.gg`입니다. 접근 실패 시 HTTP/연결 원인을 출력하고 기존 JSON을 유지합니다. 기업 프록시에서 별도 신뢰 CA가 필요하면 운영자가 `NODE_EXTRA_CA_CERTS`로 검증된 CA 파일을 제공하세요. TLS 검증을 끄지 않습니다.

`scripts/source-config.json`에는 페이지 URL, fallback JSON, 원본 최소 범위, 비용 방향/근거, 연구 포함 여부/근거, 지급량 규칙이 있습니다. 최신 페이지의 실제 참조에서 JSON과 전초기지 청크를 탐색하며 원격 JavaScript를 실행하지 않습니다. 축약 변수명의 숫자 배열을 임의로 추정하지 않습니다. 불분명한 구조는 명확한 오류로 중단합니다.

자동 탐색이 막히거나 원본 구조가 바뀌면 설정 파일을 수정하거나 **비밀이 아닌** 런타임 설정을 사용합니다:

```powershell
$env:SYNCHRO_SOURCE_URL = 'https://sg-tools-cdn.blablalink.com/새로운-실제-원본.json'
$env:OUTPOST_SCRIPT_URL = 'https://nikke.gg/페이지가-참조하는-실제-청크.js'
$env:OUTPOST_ARRAYS = '{"credit":"검증한크레딧배열명","battle":"검증한배틀배열명","core":"검증한코어배열명"}'
npm run collect
```

값은 반드시 페이지 참조/코드를 확인한 후 지정하세요. 배열 이름만으로 재화 종류를 추정하지 않습니다. 비용 방향과 연구 포함 여부는 원본 근거 없이는 수집 성공으로 처리하지 않습니다. 모든 레벨의 연속성·중복·필수 필드·비음수 유한 수치·지원 범위를 검증한 뒤 하나의 JSON 파일을 원자적으로 교체합니다. 비용/수익/규칙의 콘텐츠 SHA-256, 실제 원본 URL/SHA-256, 원본 버전, 확인 시각, 변경 시각, 스키마 버전, 범위를 함께 저장합니다. 데이터가 같아도 `checkedAt`을 갱신하고 `changedAt`을 유지합니다.

수집 실패는 파일 교체 전에 종료하며, Actions의 commit 단계도 실행되지 않습니다. 배포가 실패하면 기존 Pages 배포는 유지되고 공개 갱신 상태는 실패입니다. 이때 저장소에는 검증된 새 JSON이 이미 커밋되어 있을 수 있습니다. 운영자가 배포 workflow를 다시 실행하면 됩니다.

## 계산 규칙

K=1000, M=1000000. 소수 재화(6자리까지)를 허용하며 빈 재화/아이템은 0, 빈 레벨은 오류입니다. 음수·NaN·무한대·소수 아이템은 거부합니다. 각 케이스/상자의 개수는 안전한 정수 최적화를 위해 1억 개 이하, 재화는 단위 환산 후 9천조 이하입니다. 정밀 재화 합산은 BigInt이므로 데이터 상한까지 큰 누적 비용도 처리합니다.

기본 지급량 규칙은 **각 케이스의 소수 버림 가정**입니다. 실제 게임의 묶음 사용 지급량은 확인되지 않았습니다. 표시용 K/M 또는 소수 반올림값을 계산에 쓰지 않습니다. 연구 미포함 원본 수익에 연구 체크 시 크레딧 ×1.60, 배틀/코어 ×1.45를 적용합니다. 연구 포함 원본을 사용하는 설정도 처리하며 중복 적용하지 않습니다.

한 상자는 한 재화로만 개봉합니다. 상자에서 생성된 1시간 케이스도 하나씩 사용할 수 있고 남은 케이스는 재고에 합쳐 표시합니다. 보유 재화를 먼저 차감하고, 정수 제약에 모든 케이스 재고·상자 재고·재화별 부족량을 동시에 넣습니다.

1. 개봉 30DAY 개수 최소화 → 그 최솟값을 등식으로 고정.
2. 보급물자 개수 최소화 → 그 최솟값을 등식으로 고정.
3. 실제 사용하는 케이스 개수(상자에서 생성된 케이스 포함) 최소화.

단순 가중치 합이나 24시간 우선 탐욕법을 쓰지 않습니다. `Optimal` 상태와 0 MIP gap만 허용하고, 실제 BigInt 비용/재고로 결과를 재검증합니다. 개별 solve 5초, UI 전체 90초를 넘으면 최적이라고 주장하지 않고 오류를 표시합니다.

동률은 다음 변수 순서로 각 개별 값을 추가 최소화하고 고정합니다: 30DAY 크레딧/배틀/코어 → 보급물자 크레딧/배틀/코어 → 생성 케이스 크레딧/배틀/코어 → 보유 케이스 크레딧/배틀/코어 각각 1·2·8·12·24시간 순서. 이는 여분 재화 최소화 규칙이 아닙니다.

최대 레벨은 세 재화 누적 비용의 정수 배분 가능성을 이분 탐색합니다. 목표용 최소 사용 계획과 별도로 **전체 기존 케이스를 사용하는** 최대 레벨 계획을 출력합니다. 상자 전체 개봉은 필요하지 않으며 사용할 수 있는 전체 재고를 제약으로 고려합니다. 상한 도달 시 “최소 ○○레벨 도달 가능, 이후 데이터 필요”라고 표시합니다.

목표 불가능 시 모든 기존 케이스와 모든 상자를 쓰는 한 배분 예시의 부족량도 제공합니다. 선택형 상자는 재화별 부족량을 서로 바꿀 수 있어 유일한 부족 벡터가 없습니다. 예시는 최대 레벨 계획 뒤 남은 상자를 크레딧→배틀→코어로 부족량에 배분하고, 그래도 남는 상자는 코어로 배분합니다. 최적 최대 레벨 결과와 이 예시를 구분하여 표시합니다. 자연 획득 재화는 포함하지 않습니다.

## GitHub Pages와 Actions 설정

코드를 `main`에 커밋하고 푸시합니다. 저장소 **Settings → Pages → Build and deployment → Source: GitHub Actions**를 선택하세요. 저장소 Actions 활성화와 `github-pages` environment의 배포 허용이 필요합니다. 브랜치 보호 규칙이 `GITHUB_TOKEN`의 데이터 커밋을 막는다면, 운영자가 해당 자동화의 생성 데이터 갱신을 허용해야 합니다. 보호 규칙을 우회하는 force push는 사용하지 않습니다.

- `.github/workflows/ci.yml`: 계산/수집/Worker 테스트, 사이트 빌드, Chromium UI 테스트, Worker bundle 검증.
- `.github/workflows/update-data.yml`: 수동 `workflow_dispatch`, 원본 수집/검증 → 생성 JSON만 커밋 → **재사용 Pages workflow를 직접 호출**.
- `.github/workflows/pages.yml`: main push/수동/재사용 호출 → 테스트와 빌드 → Pages artifact → Pages 배포.

`GITHUB_TOKEN`의 push가 새 push workflow를 시작할 것으로 기대하지 않습니다. 변경 없는 확인도 checkedAt 커밋과 재사용 배포를 실행하므로 최신 확인 시각이 Pages에 제공됩니다. 갱신 workflow는 `source-data-update`, 실제 Pages 배포는 `pages-deployment` 공유 concurrency 그룹을 사용하고 진행 중 실행을 취소하지 않습니다. GitHub concurrency는 여러 pending 실행 중 오래된 것을 대체할 수 있습니다. Worker는 전역 1개의 작업만 수락하며, 시간 초과 후에도 이전 Actions가 실행 중이면 새 작업을 dispatch하지 않습니다. 운영자는 중복 수동 실행을 피하세요. 동시에 main이 바뀌면 생성 커밋을 rebase하고, 충돌이면 중단하며 원격을 덮어쓰지 않습니다.

Actions 토큰은 수집 job에 `contents: write`, 배포에 `contents: read`, `pages: write`, `id-token: write`를 사용합니다. 계정 토큰을 Actions Secret으로 복제하지 않습니다. Pages에는 `dist/`만 올려 HTML/CSS/JS/WASM/데이터/공개 설정과 HiGHS 라이선스만 포함합니다. Worker 원본·비밀 설정·테스트·수집 원본 파일은 산출물에 포함되지 않습니다.

## Cloudflare Worker 배포 (PowerShell)

Cloudflare 계정의 Workers 및 Durable Objects를 사용할 수 있어야 합니다. 먼저 `worker/wrangler.toml`의 운영 대상과 Pages URL을 검토하세요. Worker의 repository/branch/workflow는 **운영자 설정에만** 존재하며 방문자가 지정할 수 없습니다.

```powershell
npx wrangler login
npm run worker:deploy
npx wrangler secret put GITHUB_TOKEN --config worker/wrangler.toml
```

마지막 명령의 보안 프롬프트에 GitHub fine-grained PAT를 입력합니다. 코드·공개 설정·Actions 로그에 넣지 않습니다. PAT는 **이 저장소 하나만 선택**, repository permission **Actions: Read and write**, **Contents: Read-only**, 기본 Metadata read를 부여합니다. Actions dispatch와 run/jobs 조회, 배포 검증용 JSON 조회에 필요한 권한입니다. 조직 승인 정책과 토큰 만료를 확인하세요. Worker 토큰에 Contents write, Pages write, Administration, 다른 저장소 접근 권한은 필요하지 않습니다. `GITHUB_TOKEN`이라는 이름의 이 PAT는 Worker Secret이며 Actions가 자동 제공하는 동일 이름의 토큰과 별개입니다.

배포된 Worker의 공개 HTTPS URL을 `public/config.json`의 `workerUrl`에 입력해 main에 커밋/배포합니다:

```json
{"workerUrl":"https://nikke-synchro-refresh.YOUR-SUBDOMAIN.workers.dev","turnstileSiteKey":""}
```

URL은 공개 주소이며 Secret이 아닙니다. Worker 미설정이면 버튼에 설정 상태를 안내하고 저장 JSON 계산은 계속 동작합니다. Pages 저장소 이름/사용자명이 바뀌면 Vite의 `base`, Wrangler의 고정 repository/Pages URL/Origin, workflow의 main 브랜치를 일관되게 변경하세요.

선택적으로 Cloudflare Turnstile 위젯을 로그인 없이 사용할 수 있습니다. 사이트 hostname을 Pages hostname으로 등록하고 공개 site key를 `turnstileSiteKey`에 저장합니다. 대응하는 Secret만 Worker에 추가합니다:

```powershell
npx wrangler secret put TURNSTILE_SECRET --config worker/wrangler.toml
```

외부 Turnstile에는 봇 검증 토큰/IP가 전달되며 계산 재화/아이템은 전달되지 않습니다.

## 공개 갱신 동작과 운영

`POST /refresh`의 JSON body는 빈 객체 또는 `turnstileToken`만 허용합니다. `GET /status`는 전역 작업 상태를 반환합니다. **CORS는 인증이나 남용 방지 수단이 아닙니다.** Durable Object에서 클라이언트 IP의 해시별 POST 3회/분, GET 10회/분과 전역 POST 60회/분, GET 600회/분을 제한합니다. 해시는 로그에 남기지 않고 만료 정리합니다. 대규모 분산 요청에는 Cloudflare WAF/Turnstile을 함께 운영하세요.

단일 Durable Object는 영속 입력 게이트에서 작업 예약을 저장한 **뒤** GitHub를 호출합니다. 프로세스 재시작에도 중복 실행 방지가 유지됩니다. 전역변수나 KV 읽기-쓰기 잠금이 아닙니다. 실행 중 새 요청은 같은 ID와 기존 상태를 반환합니다. GitHub 응답이 불확실해도 재dispatch하지 않고 UUID run-name으로 찾습니다.

`COOLDOWN_SECONDS` 기본 1800초(30분), `TIMEOUT_SECONDS` 기본 1200초(20분). 방문자가 값을 바꿀 수 없습니다. Worker는 15초 이내 중복 GitHub 조회를 캐시하며 브라우저는 15초 간격, 최대 80회/20분, 연속 연결 오류 최대 3회로 제한합니다.

상태: `queued` 대기 → `collecting` 수집/검증 → `deploying` 배포 → `verifying` Pages 확인 → `complete` 또는 `unchanged`. 실패는 `failed`, 전체 시간 초과는 `timeout`, 재요청 간격은 `cooldown`. Worker의 202 요청 수락은 완료가 아닙니다. workflow 성공 후 저장소 JSON의 버전과 확인 시각을 가져와 **Pages에서 동일 메타데이터가 실제 제공되는지** 검사합니다. 브라우저도 다시 검사한 뒤 새 데이터를 적용합니다. 실패/시간 초과/아직 미배포이면 기존 데이터·입력·결과를 유지합니다.

일반 재화 부족으로 자동 갱신하지 않습니다. 지원 범위를 벗어나거나 필수 데이터가 없으면 안내와 갱신 버튼을 제공합니다. 갱신 후에도 원본 범위를 넘으면 같은 지원 범위 오류를 유지하여 원본에도 없음을 알립니다. 운영자는 Actions에서 실패한 step을 확인하고 수집 원본 구조/접근, 토큰 범위, Pages environment 설정을 점검하세요.

실서비스 검증은 배포 후 버튼 클릭 → Actions run 생성 → 새 checkedAt JSON 커밋 → 재사용 Pages 배포 성공 → Worker `complete/unchanged` → 페이지 표시 확인 시각 변경 순서로 확인합니다. 변경 없는 갱신, 원본 차단, 배포 거절, 중복 클릭도 확인하세요. 로컬 모의 테스트만으로 계정 설정과 실제 배포 성공을 주장하지 않습니다.

## 구현 파일

| 경로 | 역할 |
|---|---|
| `src/data.mjs` | 입력·단위·원본 검증, 비용 합산, 연구/지급량 규칙 |
| `src/optimizer.mjs` | 정수 사전식 최적화, 최대 레벨, 결과 재검증 |
| `src/main.mjs`, `src/calculation-worker.mjs` | UI, 입력 보존, 갱신 polling, 브라우저 내부 계산 |
| `scripts/sources.mjs`, `scripts/collect.mjs` | 최신 원본 탐색, 정규화, 검증, 원자적 저장 |
| `public/data/data.json` | 실제 초기 수집 데이터 |
| `worker/index.mjs` | 공개 API, Durable Object, 빈도 제한, dispatch/Pages 확인 |
| `tests/` | 핵심·완전탐색·수집 실패·Worker·브라우저 테스트 |

HiGHS/highs-js는 MIT 라이선스이며 사이트에 라이선스 파일을 함께 제공합니다. 원본 데이터 제공처: [BlablaLink](https://www.blablalink.com/shiftyspad/nikke?from=list&nikke=90), [nikke.gg](https://nikke.gg/tools/outpost/).
