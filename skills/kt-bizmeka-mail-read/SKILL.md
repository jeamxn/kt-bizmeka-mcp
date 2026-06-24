---
name: kt-bizmeka-mail-read
description: KT 비즈메카 EZ 웹메일을 읽을 때 사용. 메일함(폴더) 목록 조회, 메일 목록 페이징, 특정 메일 본문/발신자/첨부 확인, 읽음 표시, 첨부 다운로드. 먼저 kt-bizmeka-login으로 로그인되어 있어야 한다.
---

# KT 비즈메카 웹메일 읽기

로그인된 `client`(kt-bizmeka-login 참고)로 웹메일을 조회한다. 메일 함수는 첫 호출 시 자동으로 웹메일 SSO 진입 + `_csrf` 토큰을 확보하므로 별도 준비가 없다. 모든 함수의 **첫 인자는 로그인된 client**다.

## 함수 (`kt_bizmeka_mcp.mail`)

| 함수 | 설명 |
|---|---|
| `list_folders(client) -> list[dict]` | 메일함 목록 + 메일 수. 항목: `folderKey, folderName, mailcount, newmailcount`. |
| `list_mails(client, folder="inbox", page=1, sort="recvdate", order="desc") -> dict` | 메일 목록. `{"maillist": [...], "page": {...}}`. 각 항목에 `ukey`. |
| `view_mail(client, ukey, folder="inbox") -> dict` | 본문/발신자/수신자/날짜/첨부. `content`는 HTML. 반환 키: `from, fromaddr, fromname, to, cc, subject, date, content, attachCount, attachList`. |
| `mark_read(client, ukeys: list[str], seen=True) -> bool` | 읽음(`seen=True`)/안읽음 표시. |
| `download_attachment(client, ukey, folder="inbox") -> bytes` | 첨부 묶음 원본 바이트. |

`folder`는 논리명(`inbox`/`sent`/`drafts`/`spam`/`trash`/`tome`/`forever`/`auth`) 또는 원시 키(`Inbox_<userid>`)를 받는다.

## 예제 (로그인 러너 안에서 이어서)

```python
from kt_bizmeka_mcp import mail

# 메일함 + 안읽은 수
for f in mail.list_folders(c):
    print(f["folderKey"], f["folderName"], f["mailcount"], f["newmailcount"])

# 받은편지함 목록
res = mail.list_mails(c, folder="inbox", page=1)
for m in res["maillist"]:
    print(m["ukey"], m.get("subject"), m.get("fromaddr"), m.get("senddate"))

# 첫 메일 본문 보기
ukey = res["maillist"][0]["ukey"]
detail = mail.view_mail(c, ukey, "inbox")
print(detail["subject"], detail["from"])
print(detail["content"])   # HTML

# (선택) 읽음 처리
mail.mark_read(c, [ukey], seen=True)

# (선택) 첨부 저장
if detail["attachCount"]:
    raw = mail.download_attachment(c, ukey, "inbox")
    open("/tmp/attach.bin", "wb").write(raw)
```

## 주의

- `content`는 HTML이다. 사용자에게 요약/정리해 보여줄 땐 태그를 정리한다.
- 폴더 이름이 헷갈리면 먼저 `list_folders`로 실제 `folderKey`를 확인한다.
- 실패 시 `BizmekaError`. 세션 만료 메시지면 kt-bizmeka-login부터 다시.
