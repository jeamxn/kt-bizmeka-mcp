# kt-bizmeka-mcp

[KT bizmeka EZ](https://ezsso.bizmeka.com) 포털 자동화 MCP 서버.

로그인 자동화를 시작으로, 포털 기능을 다루는 툴이 점진적으로 추가되는 **확장형 MCP**다. 비즈메카 로그인은 브라우저에서 자격증명을 RSA로 암호화하고, OWASP CSRFGuard 토큰을 붙이고, SMS 2차 인증을 거친 뒤 SAML SSO로 포털(`ezportal.bizmeka.com`)에 진입하는 다단계 흐름인데, 이 서버가 그 흐름을 그대로 재현한다.

## 사용 원칙: 먼저 `bizmeka_man`

이 MCP는 툴이 계속 늘어나므로, **어떤 작업이든 시작 전에 `bizmeka_man` 툴을 먼저 호출**해서 현재 사용 가능한 툴과 작업 흐름(워크플로우)을 확인하는 것을 전제로 설계됐다.

```
bizmeka_man()                          # 전체 흐름 + 툴 목록
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

> 포털 기능 툴은 이후 추가 예정. 새 툴을 붙일 때는 `catalog.py`의 `CATALOG`/`WORKFLOWS`에 등록하면 `bizmeka_man`에 자동 반영된다.

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

## 설치 / 실행

```bash
uv sync
uv run kt-bizmeka-mcp     # stdio MCP 서버
```

### Docker

```bash
docker build -t kt-bizmeka-mcp .
docker run -i --rm kt-bizmeka-mcp
```

## MCP 클라이언트 설정 (Hermes / Claude Desktop)

```yaml
mcp_servers:
  ktbizmeka:
    command: "uv"
    args: ["run", "--directory", "/path/to/kt-bizmeka-mcp", "kt-bizmeka-mcp"]
```

## 구조

```
src/kt_bizmeka_mcp/
  crypto.py    RSA(PKCS#1 v1.5) 암호화 — jsbn 호환
  client.py    bizmeka 로그인 HTTP 흐름 (1차/2차/SSO)
  session.py   진행중 로그인 세션 메모리 보관 (TTL)
  catalog.py   툴 카탈로그 + 워크플로우 (man 툴의 데이터 소스)
  server.py    FastMCP 진입점 + 툴 정의
```

## 면책

본인 소유 계정에 대한 로그인 자동화 용도. 자격증명은 메모리상에서만 처리하며 디스크에 저장하지 않는다.
