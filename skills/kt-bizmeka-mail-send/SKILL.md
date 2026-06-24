---
name: kt-bizmeka-mail-send
description: KT 비즈메카 EZ 웹메일을 발송하거나 답장할 때 사용. 신규 메일 발송, 기존 메일 답장, 발송 전 수신자 주소 검증. 실제 메일이 나가는 부작용이 있으므로 발송 전 사용자 확인이 필요하다. 먼저 kt-bizmeka-login으로 로그인되어 있어야 한다.
---

# KT 비즈메카 웹메일 발송 / 답장

로그인된 `client`로 메일을 보낸다. **실제 메일이 나가는 부작용**이 있으니, 호출 전 수신자·제목·본문을 사용자에게 반드시 확인받는다. 모든 함수의 첫 인자는 로그인된 client다.

## 함수 (`kt_bizmeka_mcp.mail`)

| 함수 | 설명 |
|---|---|
| `check_receivers(client, to, cc="", bcc="") -> dict` | 발송 전 수신자 주소 유효성 검증 (선택). |
| `send_mail(client, to, subject, body, cc="", bcc="", fromname="", fromaddr="", reply_ukey=None, is_receipt=False) -> dict` | 메일 발송/답장. 답장이면 `reply_ukey`에 원본 ukey. `is_receipt=True`면 수신확인 요청. |

- 수신자 형식: `'"홍길동" <hong@x.com>'` 또는 `hong@x.com`. 여러 명은 콤마로 구분.
- `body`는 HTML 허용.
- `fromname`/`fromaddr` 생략 시 로그인 계정 기본값(`<username>` / `<username>@bizmeka.com`) 사용.
- 답장 대상 `ukey`는 kt-bizmeka-mail-read의 `list_mails`/`view_mail`로 확보한다.

## 예제: 신규 발송 (로그인 러너 안에서 이어서)

```python
from kt_bizmeka_mcp import mail

# (선택) 주소 검증 먼저
mail.check_receivers(c, '"홍길동" <hong@x.com>')

# 발송 — 호출 전 사용자에게 to/subject/body 확인받을 것
res = mail.send_mail(
    c,
    to='"홍길동" <hong@x.com>',     # 여러 명은 콤마
    subject="안녕하세요",
    body="<p>본문 (HTML 허용)</p>",
)
print(res)
```

## 예제: 답장

```python
from kt_bizmeka_mcp import mail

# 원본 ukey 확보 (받은편지함에서)
inbox = mail.list_mails(c, folder="inbox", page=1)
orig_ukey = inbox["maillist"][0]["ukey"]

res = mail.send_mail(
    c,
    to='"보낸사람" <sender@x.com>',
    subject="RE: 원본 제목",
    body="<p>답장 본문</p>",
    reply_ukey=orig_ukey,            # 답장이면 원본 ukey 지정
)
print(res)
```

## 주의

- 발송은 되돌릴 수 없는 작업이다(수신 전이면 발송취소는 가능 — kt-bizmeka-mail-receipt 참고). 반드시 사전 확인.
- 발송 후 읽음 여부/취소 가능 여부는 kt-bizmeka-mail-receipt의 `list_receipts`로 확인한다.
- 실패 시 `BizmekaError`. 메시지를 그대로 전달한다.
