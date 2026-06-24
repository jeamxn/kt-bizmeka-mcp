---
name: kt-bizmeka
description: KT 비즈메카 EZ(ezsso/ezportal/ezwebmail) 로그인과 웹메일 작업을 수행할 때 사용. 로그인(아이디/비번 + SMS 2차인증), 메일함 조회, 메일 읽기, 메일 발송/답장, 수신확인, 발송취소 등 비즈메카 관련 요청에 활용한다.
---

# KT 비즈메카 EZ 자동화

KT 비즈메카 EZ 포털과 웹메일을 `bizmeka_*` MCP 툴로 다룬다. 이 스킬은 그 툴들을 올바른 순서로 호출하는 절차를 안내한다.

## 작업 시작 전 (필수)

먼저 `bizmeka_man` 툴을 호출해 현재 사용 가능한 툴과 워크플로우를 확인한다. 특정 툴의 인자가 헷갈리면 `bizmeka_man(tool="툴이름")`으로 상세를 본다. 흐름을 모른 채 개별 툴을 임의 순서로 호출하지 않는다.

## 핵심 제약

- **SMS 2차 인증이 필수**다. 사람이 휴대폰으로 받은 인증번호를 입력해야 하므로 로그인은 두 번의 툴 호출(`login_start` → 사용자 입력 → `verify_otp`)로 나뉜다. 완전 무인 자동화는 불가능하다.
- 모든 메일 툴은 로그인된 `session_id`가 필요하다. 첫 메일 툴 호출 시 웹메일 SAML SSO 진입과 `_csrf` 토큰 확보가 자동으로 일어난다.
- **메일 발송/답장/발송취소는 실제 부작용**이 있다. 호출 전 수신자·제목·본문을 사용자에게 반드시 확인받는다.

## 워크플로우 1: 로그인

1. `bizmeka_login_start(username, password)` → 1차 인증 후 등록된 휴대폰으로 SMS 발송. `session_id` 반환.
2. 사용자에게 휴대폰으로 받은 인증번호를 물어본다.
3. `bizmeka_verify_otp(session_id, cert_key)` → 2차 인증 + SAML SSO. 포털 진입 완료.
4. (선택) `bizmeka_session_status(session_id)`로 로그인 상태 확인.

인증번호 유효시간은 약 3분이다. 만료되면 1번부터 다시 한다.

## 워크플로우 2: 메일 읽기

1. `bizmeka_mail_folders(session_id)` → 메일함 목록과 안읽은 메일 수.
2. `bizmeka_mail_list(session_id, folder="inbox", page=1)` → 메일 목록. 각 메일의 `ukey`를 얻는다.
   - folder: `inbox`/`sent`/`drafts`/`spam`/`trash`/`tome`/`forever`/`auth`
3. `bizmeka_mail_view(session_id, ukey, folder)` → 본문/발신자/수신자/첨부 상세. `content`는 HTML.
4. (선택) `bizmeka_mail_mark_read(session_id, [ukey], seen=True)` → 읽음 처리.

## 워크플로우 3: 메일 발송 / 답장

발송 전 수신자·제목·본문을 사용자에게 확인받는다.

1. (답장이면) `bizmeka_mail_list`/`bizmeka_mail_view`로 원본 메일의 `ukey`를 확보한다.
2. (선택) `bizmeka_mail_check_receivers(session_id, to)` → 주소 유효성 검증.
3. `bizmeka_mail_send(session_id, to, subject, body, cc=, bcc=, reply_ukey=, is_receipt=)` → 발송.
   - `to` 형식: `"이름" <a@b.com>` 또는 `a@b.com`, 여러 명은 콤마로 구분.
   - 답장이면 `reply_ukey`에 원본 `ukey`를 넣는다.
4. (선택) `bizmeka_mail_receipts(session_id)` → 수신확인(읽음) 상태 조회.
5. (필요 시) `bizmeka_mail_cancel_send(session_id, mail_key)` → 발송 취소.
   - 수신자가 **읽기 전에만** 가능. `bizmeka_mail_receipts`의 `available_cancel=1`인 메일만 취소된다.

## 팁

- 세션은 메모리에 일정 시간(기본 600초) 유지된다. 만료되면 다시 로그인한다.
- 같은 `session_id`로 포털과 웹메일 작업을 모두 이어서 할 수 있다.
- 에러 응답은 `{"ok": false, "error": "..."}` 형태다. 세션 만료/인증번호 오류 등 메시지를 그대로 사용자에게 전달한다.
