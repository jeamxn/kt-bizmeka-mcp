---
name: kt-bizmeka-login
description: KT 비즈메카 EZ에 로그인할 때 사용. 아이디/비밀번호 1차 인증(RSA 암호화) 후 SMS 2차 인증번호를 받아 완료하고 포털(ezportal)에 진입한다. 다른 비즈메카 작업(메일 등)의 선행 단계다.
---

# KT 비즈메카 EZ 로그인 (SMS 2차인증)

`kt_bizmeka_mcp.client.BizmekaClient`로 로그인한다. 비즈메카는 SMS 2차 인증이 필수라, 사람이 인증번호를 읽는 단계가 중간에 낀다. 따라서 **한 프로세스 안에서** "1차 인증 → SMS 발송 → 사용자 입력 대기 → 2차 인증" 순으로 진행한다.

## 실행 환경

패키지 루트에서 `uv run python`으로 실행한다.

```bash
cd <패키지 루트>
uv run python login_runner.py
```

로그인이 끝난 `client` 객체로 곧바로 메일 작업까지 이어가야 한다(같은 프로세스). client를 직렬화해 다른 프로세스로 넘기지 말 것 — 세션이 끊긴다.

## BizmekaClient 로그인 메서드

| 메서드 | 설명 |
|---|---|
| `BizmekaClient(username, password)` | 세션 객체 생성. |
| `.submit_credentials()` | 1차 인증 (loginForm 파싱 + RSA 암호화 + CSRF + login.do). 실패 시 `BizmekaError`. |
| `.load_second_step()` | 2차 인증 페이지 로드. |
| `.send_sms()` | 등록된 휴대폰으로 인증번호 SMS 발송. |
| `.confirm_cert_key(cert_key) -> bool` | (선택) 입력한 인증번호 사전 검증. `verify_otp`가 내부에서 먼저 호출하므로 보통 직접 부를 필요 없음. |
| `.verify_otp(cert_key, remember_browser=False) -> str` | 인증번호로 2차 인증 완료 + SAML SSO → 포털 진입. 포털 URL 반환. |
| `.is_logged_in` (property) | 로그인 상태 bool (`isLogin=Y` 쿠키 확인). |
| `.dump_cookies()` / `.load_cookies(list)` | 쿠키 직렬화/복원 (디버그용). |
| `.close()` | 세션 종료. |

## 워크플로우: 러너 패턴

SMS를 보낸 뒤, 사용자가 받은 인증번호를 파일로 전달받아 인증을 마친다. 아래 러너를 패키지 루트에 저장하고 백그라운드로 실행한 다음, 받은 인증번호를 `/tmp/bizmeka_otp.txt`에 기록한다.

```python
# login_runner.py
import os, time
from kt_bizmeka_mcp.client import BizmekaClient
from kt_bizmeka_mcp import mail   # 메일 작업까지 이어서 할 때

OTP = "/tmp/bizmeka_otp.txt"
if os.path.exists(OTP):
    os.remove(OTP)

c = BizmekaClient("아이디", "비밀번호")
c.submit_credentials()      # 1차 인증 (RSA)
c.load_second_step()
c.send_sms()                # 휴대폰으로 인증번호 발송
print("SMS_SENT", flush=True)

# 사용자가 인증번호를 /tmp/bizmeka_otp.txt 에 쓸 때까지 대기 (최대 3분)
cert = None
for _ in range(180):
    if os.path.exists(OTP):
        cert = open(OTP).read().strip()
        if cert:
            break
    time.sleep(1)
assert cert, "인증번호 미입력(시간초과)"

portal_url = c.verify_otp(cert)   # 2차 인증 + SSO
print("LOGGED_IN", c.is_logged_in, portal_url, flush=True)

# --- 여기서부터 같은 c 객체로 메일 작업 이어붙이기 ---
# (kt-bizmeka-mail-read / mail-send / mail-receipt 스킬의 코드)

c.close()
```

실행 순서:
1. 러너를 백그라운드로 띄운다 → `SMS_SENT` 출력 확인.
2. 사용자에게 휴대폰으로 받은 인증번호를 물어본다.
3. 받은 번호를 `/tmp/bizmeka_otp.txt`에 기록 → 러너가 이어서 2차 인증을 마치고 후속 작업 수행.

## 주의

- 인증번호 유효시간 약 3분. 만료되면 처음부터 다시.
- 1차 인증 실패(아이디/비번 오류) 시 `submit_credentials()`에서 `BizmekaError`. 메시지를 그대로 전달한다.
- 메일 등 후속 작업은 **이 러너 안에서** 이어서 한다. 별도 프로세스로 분리하지 않는다.
