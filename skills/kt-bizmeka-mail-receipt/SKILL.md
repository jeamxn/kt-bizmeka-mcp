---
name: kt-bizmeka-mail-receipt
description: KT 비즈메카 EZ 웹메일에서 보낸 메일의 수신확인(읽음 여부)을 조회하거나, 아직 읽지 않은 보낸 메일을 발송취소할 때 사용. 먼저 kt-bizmeka-login으로 로그인되어 있어야 한다.
---

# KT 비즈메카 웹메일 수신확인 / 발송취소

로그인된 `client`로 보낸 메일의 읽음 상태를 확인하고, 아직 읽지 않은 메일을 회수한다. 첫 인자는 로그인된 client다.

## 함수 (`kt_bizmeka_mcp.mail`)

| 함수 | 설명 |
|---|---|
| `list_receipts(client, page=1, search="") -> dict` | 보낸 메일 수신확인 상태. `{"receiptlist": [...], "page": {...}}`. 항목에 `mail_key`, `available_cancel`(1이면 취소 가능). |
| `cancel_send(client, mail_key, cancel_type="U") -> dict` | 발송 취소. `available_cancel=1`인 메일만 가능. `mail_key`는 `list_receipts` 결과에서. |

## 예제 (로그인 러너 안에서 이어서)

```python
from kt_bizmeka_mcp import mail

# 보낸 메일 수신확인 상태
receipts = mail.list_receipts(c)
for r in receipts["receiptlist"]:
    print(r.get("mail_key"), r.get("available_cancel"), r.get("read_date"))

# 아직 읽지 않은(available_cancel=1) 메일 발송취소
for r in receipts["receiptlist"]:
    if r.get("available_cancel") == 1:
        out = mail.cancel_send(c, r["mail_key"])
        print("취소:", out)
        break
```

## 주의

- 발송취소는 **수신자가 읽기 전에만** 가능하다. `available_cancel=1`인 항목만 시도한다.
- 발송취소도 부작용이 있는 작업이니, 어떤 메일을 회수할지 사용자에게 확인받는 게 안전하다.
- 실패 시 `BizmekaError`. 메시지를 그대로 전달한다.
