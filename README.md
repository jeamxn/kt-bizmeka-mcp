# kt-bizmeka-mcp

[KT bizmeka EZ](https://ezsso.bizmeka.com) 로그인을 자동화하는 MCP 서버.

비즈메카 로그인은 브라우저에서 자바스크립트로 자격증명을 RSA 암호화하고, OWASP CSRFGuard 토큰을 붙이고, SMS 2차 인증을 거친 뒤 SAML SSO로 포털(`ezportal.bizmeka.com`)에 진입하는 다단계 흐름이다. 이 서버는 그 흐름을 그대로 재현해서 MCP 툴로 노출한다.

## 인증 흐름

```
1. GET  /loginForm.do            → JSESSIONID + RSA 공개키(modulus/exponent)
2. GET  /JavaScriptServlet       → OWASP_CSRFTOKEN
3. RSA 암호화(PKCS#1 v1.5):
     j_username = RSA(아이디)
     j_password = RSA(비번) + <loginForm 고정 suffix>
4. POST /login.do                → 302 /rule/secondStepVerifView.do (1차 통과)
5. GET  /sendCertKeyToMobile.do  → 등록된 휴대폰으로 인증번호 발송
6. (사용자가 받은 6자리 입력)
7. GET  /confirmCertKey.do       → 인증번호 1차 확인
8. POST /loginVerify.do          → isLogin=Y, COMPANY_ID/NAME 쿠키 세팅 (2차 통과)
9. SAML → POST ezportal /sso/assertionConsumer.do → 포털 JSESSIONID
10. GET ezportal /portal/main/main.do → 로그인 완료
```

## MCP 툴

| 툴 | 설명 |
|---|---|
| `bizmeka_login_start` | 아이디/비번으로 1차 인증 후 SMS 발송까지. 세션 ID 반환 |
| `bizmeka_verify_otp` | SMS 인증번호로 2차 인증 완료 + SAML SSO → 포털 진입 |
| `bizmeka_session_status` | 현재 세션 로그인 상태 확인 |

> 2차 인증은 등록된 휴대폰으로 가는 SMS라, 완전 무인 자동화는 불가능하다. `bizmeka_login_start` → 사람이 문자 확인 → `bizmeka_verify_otp` 두 단계로 동작한다.

## 설치

```bash
uv sync
```

## MCP 클라이언트 설정 (Hermes / Claude Desktop)

```yaml
mcp_servers:
  ktbizmeka:
    command: "uv"
    args: ["run", "--directory", "/path/to/kt-bizmeka-mcp", "kt-bizmeka-mcp"]
```

## 면책

본인 소유 계정에 대한 로그인 자동화 용도. 자격증명은 메모리상에서만 처리하며 저장하지 않는다.
