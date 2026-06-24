---
name: kt-bizmeka
description: KT 비즈메카 EZ(ezsso/ezportal/ezwebmail) 로그인과 웹메일 작업을 수행할 때 사용. 로그인(아이디/비번 + SMS 2차인증), 메일함 조회, 메일 읽기, 메일 발송/답장, 수신확인, 발송취소 등 비즈메카 관련 요청에 활용한다.
---

# KT 비즈메카 EZ 자동화

KT 비즈메카 EZ 포털과 웹메일을 파이썬 패키지 `kt_bizmeka_mcp`로 직접 다룬다.
이 스킬은 그 함수들을 올바른 순서로 호출하는 절차를 안내한다.

## 실행 환경

플러그인/스킬 디렉토리(이 SKILL.md가 있는 폴더)에서 `uv`로 실행한다. 의존성은 `uv run`이 자동 동기화한다.

```bash
cd <이 스킬이 설치된 디렉토리>   # 예: 플러그인 캐시 경로 / repo 루트
uv run python <스크립트>
```

핵심 객체는 `kt_bizmeka_mcp.client.BizmekaClient` 하나다. 이 인스턴스가 쿠키/세션/CSRF를 전부 들고 있으므로, **로그인부터 메일 작업까지 같은 프로세스·같은 client 객체로 이어가야 한다.**

## 핵심 제약

- **SMS 2차 인증이 필수**다. 사람이 휴대폰으로 받은 인증번호를 입력해야 한다. 따라서 로그인은 한 프로세스 안에서 "SMS 발송 → 사용자 입력 대기 → 인증" 순으로 진행한다(아래 워크플로우 1의 러너 패턴 참고).
- 인증번호 유효시간은 약 3분. 만료되면 처음부터 다시.
- **client 객체를 프로세스 밖으로 직렬화해 재사용하지 말 것.** httpx 세션이 끊겨 2차 인증이 깨진다. 부득이하면 `client.dump_cookies()`/`load_cookies()`로 쿠키만 넘기되, 로그인 직후 한 프로세스에서 끝내는 것이 안전하다.
- **메일 발송/답장/발송취소는 실제 부작용**이 있다. 호출 전 수신자·제목·본문을 사용자에게 반드시 확인받는다.

## 함수 레퍼런스

### `kt_bizmeka_mcp.client.BizmekaClient(username, password)`
로그인 세션을 들고 있는 메인 객체.

| 메서드 | 설명 |
|---|---|
| `.submit_credentials()` | 1차 인증 (loginForm 파싱 + RSA 암호화 + CSRF + login.do). 실패 시 `BizmekaError`. |
| `.load_second_step()` | 2차 인증 페이지 로드. |
| `.send_sms()` | 등록된 휴대폰으로 인증번호 SMS 발송. |
| `.verify_otp(cert_key, remember_browser=False) -> str` | 인증번호로 2차 인증 완료 + SAML SSO → 포털 진입. 포털 URL 반환. (내부에서 confirmCertKey 먼저 호출) |
| `.enter_webmail() -> str` | 웹메일 SAML SSO 진입 + `_csrf` 토큰 확보·반환. 메일 함수가 자동 호출하므로 보통 직접 부를 필요 없음. |
| `.is_logged_in` (property) | 로그인 상태 bool. |
| `.dump_cookies()` / `.load_cookies(list)` | 쿠키 직렬화/복원 (디버그용). |
| `.close()` | 세션 종료. |

### `kt_bizmeka_mcp.mail` (모든 함수의 첫 인자는 위 `client`)

| 함수 | 설명 |
|---|---|
| `list_folders(client) -> list[dict]` | 메일함 목록 + 메일 수 (folderKey, folderName, mailcount, newmailcount). |
| `list_mails(client, folder="inbox", page=1, sort="recvdate", order="desc") -> dict` | 메일 목록. `{"maillist": [...], "page": {...}}`. 각 항목에 `ukey`. |
| `view_mail(client, ukey, folder="inbox") -> dict` | 본문/발신자/수신자/날짜/첨부. `content`는 HTML. |
| `mark_read(client, ukeys: list[str], seen=True) -> bool` | 읽음/안읽음 표시. |
| `download_attachment(client, ukey, folder="inbox") -> bytes` | 첨부 다운로드. |
| `check_receivers(client, to, cc="", bcc="") -> dict` | 발송 전 수신자 주소 검증. |
| `send_mail(client, to, subject, body, cc="", bcc="", fromname="", fromaddr="", reply_ukey=None, is_receipt=False) -> dict` | 메일 발송/답장. 답장이면 `reply_ukey`에 원본 ukey. |
| `list_receipts(client, page=1, search="") -> dict` | 보낸 메일 수신확인(읽음) 상태. 항목에 `mail_key`, `available_cancel`. |
| `cancel_send(client, mail_key, cancel_type="U") -> dict` | 발송 취소. `available_cancel=1`인 메일만 가능. |

`folder`는 논리명(`inbox`/`sent`/`drafts`/`spam`/`trash`/`tome`/`forever`/`auth`) 또는 원시 키(`Inbox_<userid>`)를 받는다.

## 워크플로우 1: 로그인 (SMS 2차인증)

같은 프로세스 안에서 SMS를 보내고, 사용자가 받은 인증번호를 파일로 전달받아 인증을 마친다. 아래 러너를 디렉토리에 저장하고 백그라운드로 실행한 뒤, 사용자에게 받은 인증번호를 `/tmp/bizmeka_otp.txt`에 기록한다.

```python
# login_runner.py
import os, time
from kt_bizmeka_mcp.client import BizmekaClient
from kt_bizmeka_mcp import mail

OTP = "/tmp/bizmeka_otp.txt"
if os.path.exists(OTP):
    os.remove(OTP)

c = BizmekaClient("아이디", "비밀번호")
c.submit_credentials()      # 1차 인증
c.load_second_step()
c.send_sms()                # 휴대폰으로 인증번호 발송
print("SMS_SENT", flush=True)

# 사용자가 받은 인증번호를 /tmp/bizmeka_otp.txt 에 쓸 때까지 대기 (최대 3분)
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

# 이어서 메일 작업 (같은 client 객체 사용)
for f in mail.list_folders(c):
    print(f["folderKey"], f["folderName"], f["mailcount"], f["newmailcount"])
c.close()
```

실행 순서:
1. 러너를 백그라운드로 띄운다 → `SMS_SENT` 출력 확인.
2. 사용자에게 휴대폰으로 받은 인증번호를 물어본다.
3. 받은 번호를 `/tmp/bizmeka_otp.txt`에 기록 → 러너가 이어서 2차 인증·메일 작업 수행.

## 워크플로우 2: 메일 읽기

로그인된 `client`로 (워크플로우 1 러너 안에서 이어서):

```python
from kt_bizmeka_mcp import mail
folders = mail.list_folders(client)                       # 메일함/안읽은 수
res = mail.list_mails(client, folder="inbox", page=1)     # 목록
ukey = res["maillist"][0]["ukey"]
detail = mail.view_mail(client, ukey, "inbox")            # 본문(HTML)
mail.mark_read(client, [ukey], seen=True)                 # (선택) 읽음 처리
```

## 워크플로우 3: 메일 발송 / 답장

발송 전 수신자·제목·본문을 사용자에게 확인받는다.

```python
from kt_bizmeka_mcp import mail
mail.check_receivers(client, '"홍길동" <hong@x.com>')      # (선택) 주소 검증
mail.send_mail(
    client,
    to='"홍길동" <hong@x.com>',   # 여러 명은 콤마
    subject="제목",
    body="<p>본문 (HTML 허용)</p>",
    reply_ukey=None,              # 답장이면 원본 ukey
)
receipts = mail.list_receipts(client)                      # 수신확인 상태
# 읽기 전이면 취소 가능 (available_cancel=1):
# mail.cancel_send(client, receipts["receiptlist"][0]["mail_key"])
```

## 팁

- 함수가 실패하면 `kt_bizmeka_mcp.client.BizmekaError`를 던진다. 메시지(세션 만료/인증번호 오류 등)를 그대로 사용자에게 전달한다.
- 한 `client` 객체로 포털·웹메일 작업을 모두 이어서 한다. 새 작업 때마다 다시 로그인하지 않는다.
- 메일 함수는 첫 호출 시 `enter_webmail()`을 자동 수행하므로 별도로 부르지 않아도 된다.
