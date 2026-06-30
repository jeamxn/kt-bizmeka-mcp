# kt-bizmeka-mcp

[KT bizmeka EZ](https://ezsso.bizmeka.com) 포털 자동화 MCP 서버. **TypeScript / Bun 포팅판.**

로그인 자동화를 시작으로, 포털 기능을 다루는 툴이 점진적으로 추가되는 **확장형 MCP**다. 비즈메카 로그인은 브라우저에서 자격증명을 RSA로 암호화하고, OWASP CSRFGuard 토큰을 붙이고, SMS 2차 인증을 거친 뒤 SAML SSO로 포털(`ezportal.bizmeka.com`)에 진입하는 다단계 흐름인데, 이 서버가 그 흐름을 그대로 재현한다.

`bun build --compile` 로 **런타임이 내장된 단일 실행 바이너리**를 만든다. mac / linux / windows 어디서든 **아무 환경(node·bun·python) 없이** 바로 실행된다.

## 사용 원칙: 먼저 `bizmeka_man`

이 MCP는 툴이 계속 늘어나므로, **어떤 작업이든 시작 전에 `bizmeka_man` 툴을 먼저 호출**해서 현재 사용 가능한 툴과 작업 흐름(워크플로우)을 확인하는 것을 전제로 설계됐다.

```
bizmeka_man()                            # 전체 흐름 + 툴 목록
bizmeka_man(tool="bizmeka_login_start")  # 특정 툴 상세 사용법
```

서버 instructions에도 이 원칙이 명시돼 있어, MCP 클라이언트(에이전트)가 자동으로 man을 먼저 참고하도록 유도한다.

## 툴

| 툴 | 설명 |
|---|---|
| `bizmeka_man` | **사용법/툴 목록/작업 흐름 조회.** 작업 전 항상 먼저 호출 |
| `bizmeka_login_start` | 1차 인증(RSA 암호화) 후 등록 휴대폰으로 SMS 인증번호 발송 |
| `bizmeka_verify_otp` | SMS 인증번호로 2차 인증 + SAML SSO → 포털 진입 |
| `bizmeka_session_status` | 세션 로그인 상태 확인 |
| `bizmeka_mail_folders` | 웹메일 메일함(폴더) 목록 + 메일 수 |
| `bizmeka_mail_list` | 메일함의 메일 목록 (inbox/sent/drafts/spam/trash/tome/...) |
| `bizmeka_mail_view` | 특정 메일 본문/발신자/수신자/첨부 조회 |
| `bizmeka_mail_mark_read` | 메일 읽음/안읽음 표시 |
| `bizmeka_mail_check_receivers` | 발송 전 수신자 주소 검증 |
| `bizmeka_mail_send` | 메일 발송 / 답장 (실제 발송 부작용 주의) |
| `bizmeka_mail_receipts` | 보낸 메일 수신확인(읽음) 상태 |
| `bizmeka_mail_cancel_send` | 안읽은 보낸 메일 발송 취소 |

> 웹메일(`ezwebmail.bizmeka.com`)은 포털과 별도 도메인이며, 첫 메일 툴 호출 시 SP-initiated SAML SSO로 자동 진입하고 Spring Security `_csrf` 토큰을 캡처한다. 새 툴을 붙일 때는 `src/catalog.ts`의 `CATALOG`/`WORKFLOWS`에 등록하면 `bizmeka_man`에 자동 반영된다.

## 로그인 워크플로우

2차 인증은 등록된 휴대폰으로 가는 SMS라 완전 무인 자동화는 불가능하다. 사람이 인증번호를 읽는 단계가 끼어 있어 두 번의 툴 호출로 나뉜다.

```
1. bizmeka_login_start(username, password)   → SMS 발송, session_id 수령
2. (사용자가 휴대폰 SMS 인증번호 확인)
3. bizmeka_verify_otp(session_id, cert_key)  → 2차 인증 + SSO, 포털 진입
4. bizmeka_session_status(session_id)        → (선택) 상태 확인
```

내부 인증 단계 상세:

```
GET  /loginForm.do            → JSESSIONID + RSA 공개키(modulus/exponent) + 비번 suffix
GET  /JavaScriptServlet       → OWASP_CSRFTOKEN
POST /login.do                → 302 /rule/secondStepVerifView.do (1차 통과)
GET  /sendCertKeyToMobile.do  → SMS 발송 (JSON res=0)
GET  /confirmCertKey.do       → 인증번호 1차 확인
POST /loginVerify.do          → isLogin=Y, COMPANY_ID/NAME 쿠키 (2차 통과)
SAML → POST ezportal /sso/assertionConsumer.do → 포털 JSESSIONID
GET  ezportal /portal/main/main.do → 로그인 완료
```

## 개발 / 실행 (소스에서)

[Bun](https://bun.sh) 1.3+ 필요.

```bash
bun install
bun run dev          # 기본 stdio MCP 서버 (로컬 클라이언트용)
```

### Transport

`MCP_TRANSPORT` 환경변수로 전송 방식을 고른다.

| 값 | 용도 |
|---|---|
| `stdio` (기본) | Claude Desktop / Hermes 등 로컬 MCP 클라이언트가 프로세스를 띄워 stdin/stdout으로 통신 |
| `streamable-http` (또는 `http`) | **배포용.** `MCP_HOST`:`MCP_PORT`(기본 0.0.0.0:8000)에서 상주, 엔드포인트 `/mcp` (+ `/health`) |

> stdio 서버는 stdin이 닫히면 즉시 종료된다. 그래서 `docker run`으로 그냥 띄우면 컨테이너가 계속 재시작(exited 0)된다. **배포할 때는 반드시 HTTP transport를 쓸 것.**

## 단일 실행 바이너리 빌드

```bash
bun run build           # 5개 플랫폼 전부 (dist/)
bun run build:current   # 현재 호스트용 하나만
```

생성물 (`dist/`):

```
kt-bizmeka-mcp-darwin-arm64     (Apple Silicon)
kt-bizmeka-mcp-darwin-x64       (Intel Mac)
kt-bizmeka-mcp-linux-x64
kt-bizmeka-mcp-linux-arm64
kt-bizmeka-mcp-windows-x64.exe
```

바이너리는 Bun 런타임을 내장하므로 대상 머신에 **아무것도 설치할 필요가 없다**. 바로 실행:

```bash
./dist/kt-bizmeka-mcp-linux-x64                       # stdio
MCP_TRANSPORT=http MCP_PORT=8000 ./dist/kt-bizmeka-mcp-linux-x64   # http
```

## 릴리스 (바이너리 배포)

**main 브랜치에 push될 때마다** GitHub Actions가 그 시점 KST 시간으로 캘린더 태그 `vYYYYMMDD-HHMM` (예: `v20260630-1206`) 를 만들어 **OS별 플러그인 zip 5개**를 릴리스에 자동 업로드한다 (`.github/workflows/release.yml`). 릴리스 자산은 plugin zip 뿐이며, 바이너리는 각 zip 안에 들어 있다.

손으로 릴리스를 끊으려면 (gh 인증 필요):

```bash
./scripts/release.sh         # 빌드 + 패키징 + gh release 생성/업로드 (KST 캘린더 태그)
bun run scripts/build.ts     # 바이너리만 로컬에 빌드
```

> 플러그인 zip 안의 `plugin.json` `version` 필드는 `package.json`의 semver(예: `0.2.0`)를 유지한다 (Claude Code 플러그인 매니페스트 검증 통과용). 캘린더 빌드 태그는 릴리스/zip 이름과 `description`의 `build ...` 에 들어간다.

## Docker (배포)

멀티스테이지: `oven/bun` 이미지에서 linux 바이너리를 컴파일하고, 런타임 이미지엔 바이너리만 복사한다 (런타임 미설치). 기본값 `MCP_TRANSPORT=streamable-http`, 포트 8000 노출.

```bash
docker build -t kt-bizmeka-mcp .
docker run --rm -p 8000:8000 kt-bizmeka-mcp   # http://localhost:8000/mcp
```

Dokploy(Traefik) 배포 시에는 호스트 포트 바인딩 없이 `EXPOSE 8000`만 두고 도메인 라우팅으로 연결한다.

## MCP 클라이언트 설정 (Hermes / Claude Desktop)

로컬 바이너리를 stdio로 직접 붙인다:

```yaml
mcp_servers:
  kt-bizmeka:
    command: "/path/to/kt-bizmeka-mcp"   # 빌드한 바이너리 (또는 plugin zip 안의 것)
    env:
      MCP_TRANSPORT: stdio
```

## Claude Code 플러그인

이 repo는 Claude Code 플러그인으로 배포된다. 설치하면 `plugin.json`의 `mcpServers`에 인라인 정의된 서버가 자동 등록된다. 설치 경로는 두 가지다.

### A. OS별 플러그인 zip (권장 — 바이너리 직접 실행)

태그를 push하면 GitHub Actions가 OS/아키텍처별로 **바이너리 + `.claude-plugin/` 을 하나의 zip**으로 묶어 릴리스에 올린다 (`.github/workflows/release.yml`).

```
kt-bizmeka-plugin-darwin-arm64.zip
kt-bizmeka-plugin-darwin-x64.zip
kt-bizmeka-plugin-linux-x64.zip
kt-bizmeka-plugin-linux-arm64.zip
kt-bizmeka-plugin-windows-x64.zip
```

자기 OS에 맞는 zip을 받아 풀면 그 안의 `plugin.json` 이 같은 폴더의 바이너리를 **직접** 가리킨다 (node·uv 등 아무 런타임 불필요):

```json
"kt-bizmeka-local": {
  "command": "${CLAUDE_PLUGIN_ROOT}/kt-bizmeka-mcp",
  "env": { "MCP_TRANSPORT": "stdio" }
}
```

압축을 푼 폴더를 플러그인으로 추가한다:

```
/plugin marketplace add /path/to/unzipped-folder
/plugin install kt-bizmeka@kt-bizmeka
```

> macOS Finder / `unzip` CLI 는 바이너리의 실행권한(0755)을 보존한다. 혹시 실행 권한이 없다면 `chmod +x kt-bizmeka-mcp` 한 번이면 된다.

### B. 레포 직접 추가 (소스)

```
/plugin marketplace add jeamxn/kt-bizmeka-mcp
/plugin install kt-bizmeka@kt-bizmeka
```

레포의 `.claude-plugin/plugin.json` 의 `kt-bizmeka-local` 은 `${CLAUDE_PLUGIN_ROOT}/kt-bizmeka-mcp` 바이너리를 **직접** stdio로 실행한다 (node 등 런타임 불필요). 단, 레포에는 빌드된 바이너리가 없으므로 먼저 한 번 빌드해 레포 루트에 떨궈야 한다:

```bash
bun install
bun run build:current   # 레포 루트에 kt-bizmeka-mcp 생성
```

> 빌드가 귀찮으면 OS별 plugin zip(A안)을 받으면 바이너리가 이미 들어 있어 빌드가 필요 없다.

> 어떤 작업이든 시작 전에 `bizmeka_man` 툴을 먼저 호출해 현재 사용 가능한 툴과 워크플로우를 확인한다.

## 구조

```
src/
  crypto.ts    RSA(PKCS#1 v1.5) 암호화 — jsbn 호환 (node:crypto publicEncrypt)
  http.ts      쿠키 jar + 수동 리다이렉트 HTTP 클라이언트 (fetch 기반)
  client.ts    bizmeka 로그인 HTTP 흐름 (1차/2차/SSO) + 웹메일 SAML 진입
  mail.ts      웹메일 메일 작업 (목록/상세/발송/답장/수신확인/발송취소)
  session.ts   진행중 로그인 세션 메모리 보관 (TTL)
  catalog.ts   툴 카탈로그 + 워크플로우 (man 툴의 데이터 소스)
  errors.ts    BizmekaError
  server.ts    MCP 진입점 + 툴 정의 (stdio / streamable-http transport)
scripts/
  build.ts        크로스 컴파일 (5개 플랫폼)
  package.py      OS별 플러그인 zip 패키징 (바이너리 + .claude-plugin)
  release.sh      빌드 + 패키징 + GitHub Release 업로드 (수동 릴리스용)
  mcp_smoke.sh    stdio MCP 핸드셰이크 스모크 테스트
.github/workflows/
  release.yml     main push 시 빌드→패키징→릴리스 업로드 자동화 (KST 캘린더 태그)
```

## 면책

본인 소유 계정에 대한 로그인 자동화 용도. 자격증명은 메모리상에서만 처리하며 디스크에 저장하지 않는다.
