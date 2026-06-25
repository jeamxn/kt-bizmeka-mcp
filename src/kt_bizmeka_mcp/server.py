"""MCP server exposing KT bizmeka EZ login as tools.

Because the login requires an SMS one-time code that only the account owner can
read, the flow is split into two tool calls:

    bizmeka_login_start(username, password)
        -> 1st-factor login + sends the SMS, returns a session_id
    bizmeka_verify_otp(session_id, cert_key)
        -> finishes 2FA + SAML SSO, lands on the portal

Credentials are held only in memory for the lifetime of the in-flight session.
"""

from __future__ import annotations

import os

from mcp.server.fastmcp import FastMCP

from .catalog import render_overview, render_tool
from .client import BizmekaClient, BizmekaError
from . import mail
from .session import store

INSTRUCTIONS = (
    "KT 비즈메카 EZ 자동화 MCP. 로그인 자동화를 비롯해 포털 기능 툴이 점진적으로 "
    "추가되는 확장형 서버다.\n\n"
    "중요: 어떤 작업이든 시작하기 전에 반드시 `bizmeka_man` 툴을 먼저 호출해 "
    "현재 사용 가능한 툴과 작업 흐름(워크플로우)을 확인하라. 특정 툴의 상세 사용법이 "
    "필요하면 `bizmeka_man(tool='툴이름')` 으로 조회한다. 흐름을 모른 채 개별 툴을 "
    "임의 순서로 호출하지 말 것."
)

mcp = FastMCP(
    "kt-bizmeka",
    instructions=INSTRUCTIONS,
    host=os.environ.get("MCP_HOST", "0.0.0.0"),
    port=int(os.environ.get("MCP_PORT", "8000")),
)


@mcp.tool()
def bizmeka_man(tool: str = "") -> dict:
    """이 MCP의 사용법을 조회한다. 작업 전 항상 먼저 호출하라.

    인자 없이 호출하면 전체 작업 흐름(워크플로우)과 사용 가능한 툴 목록을
    반환한다. tool 인자에 특정 툴 이름을 넣으면 그 툴의 상세 사용법(인자, 반환값,
    주의사항)을 알려준다.

    Args:
        tool: (선택) 상세 설명을 볼 툴 이름. 비우면 전체 개요를 반환한다.
    """
    if tool:
        return render_tool(tool)
    return render_overview()


@mcp.tool()
def bizmeka_login_start(username: str, password: str) -> dict:
    """KT 비즈메카 EZ 로그인을 시작한다.

    아이디/비밀번호로 1차 인증을 수행하고, 등록된 휴대폰으로 SMS 인증번호를
    발송한다. 반환된 session_id 와 사용자가 받은 인증번호로
    bizmeka_verify_otp 를 호출해 로그인을 완료한다.

    Args:
        username: 비즈메카 아이디
        password: 비즈메카 비밀번호

    Returns:
        성공 시 {"ok": True, "session_id": ..., "message": ...}
    """
    client = BizmekaClient(username=username, password=password)
    try:
        client.submit_credentials()  # 1st factor (RSA + CSRF + login.do)
        client.load_second_step()
        client.send_sms()  # SMS to registered phone
    except BizmekaError as e:
        client.close()
        return {"ok": False, "error": str(e)}
    except Exception as e:  # network etc.
        client.close()
        return {"ok": False, "error": f"요청 실패: {e}"}

    sid = store.create(client, sso_redirect="")
    return {
        "ok": True,
        "session_id": sid,
        "message": "인증번호를 등록된 휴대폰으로 발송했습니다. "
        "받은 인증번호로 bizmeka_verify_otp 를 호출하세요. (유효시간 약 3분)",
    }


@mcp.tool()
def bizmeka_verify_otp(
    session_id: str, cert_key: str, remember_browser: bool = False
) -> dict:
    """SMS 인증번호로 2차 인증을 완료하고 포털에 로그인한다.

    Args:
        session_id: bizmeka_login_start 가 반환한 세션 ID
        cert_key: 휴대폰으로 받은 인증번호
        remember_browser: True 면 이후 이 브라우저(쿠키jar)에서 2차 인증 생략

    Returns:
        성공 시 {"ok": True, "portal_url": ..., "logged_in": True}
    """
    sess = store.get(session_id)
    if sess is None:
        return {"ok": False, "error": "세션이 만료되었거나 존재하지 않습니다. 다시 로그인하세요."}

    client = sess.client
    try:
        portal_url = client.verify_otp(
            cert_key.strip(), remember_browser=remember_browser
        )
    except BizmekaError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"요청 실패: {e}"}

    sess.authenticated = True
    sess.portal_url = portal_url
    return {
        "ok": True,
        "session_id": session_id,
        "logged_in": client.is_logged_in,
        "portal_url": portal_url,
        "message": "로그인 완료. 포털에 진입했습니다.",
    }


@mcp.tool()
def bizmeka_session_status(session_id: str) -> dict:
    """현재 세션의 로그인 상태를 확인한다.

    Args:
        session_id: 확인할 세션 ID
    """
    sess = store.get(session_id)
    if sess is None:
        return {"ok": False, "error": "세션이 만료되었거나 존재하지 않습니다."}
    return {
        "ok": True,
        "authenticated": sess.authenticated,
        "logged_in": sess.client.is_logged_in,
        "portal_url": sess.portal_url,
    }


# ===================== WEBMAIL TOOLS ===================================
def _logged_in_client(session_id: str):
    """Resolve an authenticated client from a session, or return an error dict."""
    sess = store.get(session_id)
    if sess is None:
        return None, {"ok": False, "error": "세션이 만료되었거나 존재하지 않습니다. 다시 로그인하세요."}
    if not sess.client.is_logged_in:
        return None, {"ok": False, "error": "로그인되지 않은 세션입니다."}
    return sess.client, None


@mcp.tool()
def bizmeka_mail_folders(session_id: str) -> dict:
    """웹메일 메일함(폴더) 목록과 메일 수를 조회한다.

    Args:
        session_id: 로그인된 세션 ID
    """
    client, err = _logged_in_client(session_id)
    if err:
        return err
    try:
        return {"ok": True, "folders": mail.list_folders(client)}
    except BizmekaError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"요청 실패: {e}"}


@mcp.tool()
def bizmeka_mail_list(
    session_id: str, folder: str = "inbox", page: int = 1
) -> dict:
    """메일함의 메일 목록을 조회한다.

    Args:
        session_id: 로그인된 세션 ID
        folder: inbox/sent/drafts/spam/trash/tome/forever/auth 중 하나 (기본 inbox)
        page: 페이지 번호 (기본 1)
    """
    client, err = _logged_in_client(session_id)
    if err:
        return err
    try:
        return {"ok": True, **mail.list_mails(client, folder, page)}
    except BizmekaError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"요청 실패: {e}"}


@mcp.tool()
def bizmeka_mail_view(session_id: str, ukey: str, folder: str = "inbox") -> dict:
    """특정 메일의 본문/발신자/수신자/첨부 정보를 조회한다.

    Args:
        session_id: 로그인된 세션 ID
        ukey: 메일 고유키 (bizmeka_mail_list 결과의 ukey)
        folder: 메일이 속한 폴더 (기본 inbox)
    """
    client, err = _logged_in_client(session_id)
    if err:
        return err
    try:
        return {"ok": True, "mail": mail.view_mail(client, ukey, folder)}
    except BizmekaError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"요청 실패: {e}"}


@mcp.tool()
def bizmeka_mail_mark_read(
    session_id: str, ukeys: list[str], seen: bool = True
) -> dict:
    """메일을 읽음(seen=True) 또는 안읽음(seen=False)으로 표시한다.

    Args:
        session_id: 로그인된 세션 ID
        ukeys: 대상 메일 ukey 목록
        seen: True=읽음, False=안읽음
    """
    client, err = _logged_in_client(session_id)
    if err:
        return err
    try:
        ok = mail.mark_read(client, ukeys, seen)
        return {"ok": ok}
    except BizmekaError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"요청 실패: {e}"}


@mcp.tool()
def bizmeka_mail_send(
    session_id: str,
    to: str,
    subject: str,
    body: str,
    cc: str = "",
    bcc: str = "",
    reply_ukey: str = "",
    is_receipt: bool = False,
) -> dict:
    """메일을 발송한다. (신규 발송 또는 답장)

    주의: 실제로 메일이 발송되는 부작용이 있다. 호출 전 수신자/제목/본문을
    사용자에게 확인받는 것을 권장한다.

    Args:
        session_id: 로그인된 세션 ID
        to: 받는사람. 형식 '"이름" <a@b.com>' 또는 'a@b.com', 여러명은 콤마 구분
        subject: 제목
        body: 본문 (HTML 허용)
        cc: 참조 (선택)
        bcc: 숨은참조 (선택)
        reply_ukey: 답장일 경우 원본 메일 ukey (선택)
        is_receipt: 수신확인 요청 여부
    """
    client, err = _logged_in_client(session_id)
    if err:
        return err
    try:
        res = mail.send_mail(
            client, to=to, subject=subject, body=body, cc=cc, bcc=bcc,
            reply_ukey=reply_ukey or None, is_receipt=is_receipt,
        )
        return {"ok": True, "result": res}
    except BizmekaError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"요청 실패: {e}"}


@mcp.tool()
def bizmeka_mail_check_receivers(
    session_id: str, to: str, cc: str = "", bcc: str = ""
) -> dict:
    """발송 전 수신자 주소 유효성을 검증한다.

    Args:
        session_id: 로그인된 세션 ID
        to/cc/bcc: 검증할 수신자 주소
    """
    client, err = _logged_in_client(session_id)
    if err:
        return err
    try:
        return {"ok": True, "result": mail.check_receivers(client, to, cc, bcc)}
    except BizmekaError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"요청 실패: {e}"}


@mcp.tool()
def bizmeka_mail_receipts(session_id: str, page: int = 1, search: str = "") -> dict:
    """보낸 메일의 수신확인(읽음) 상태 목록을 조회한다.

    Args:
        session_id: 로그인된 세션 ID
        page: 페이지 번호
        search: 검색어 (선택)
    """
    client, err = _logged_in_client(session_id)
    if err:
        return err
    try:
        return {"ok": True, **mail.list_receipts(client, page, search)}
    except BizmekaError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"요청 실패: {e}"}


@mcp.tool()
def bizmeka_mail_cancel_send(session_id: str, mail_key: str) -> dict:
    """아직 읽지 않은 보낸 메일의 발송을 취소한다.

    주의: 수신자가 아직 읽지 않은 경우에만 취소 가능
    (bizmeka_mail_receipts 의 available_cancel 로 확인).

    Args:
        session_id: 로그인된 세션 ID
        mail_key: 취소할 메일의 mail_key (bizmeka_mail_receipts 결과)
    """
    client, err = _logged_in_client(session_id)
    if err:
        return err
    try:
        return {"ok": True, "result": mail.cancel_send(client, mail_key)}
    except BizmekaError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"요청 실패: {e}"}


def main() -> None:
    """Console-script entrypoint.

    Transport is chosen by the ``MCP_TRANSPORT`` env var:
      * ``stdio`` (default) — for local MCP clients that spawn the process and
        talk over stdin/stdout (Claude Desktop, Hermes stdio config).
      * ``streamable-http`` / ``http`` — for deployment as a long-running
        service (Docker/Dokploy). Listens on ``MCP_HOST``:``MCP_PORT`` and
        serves the MCP endpoint at ``/mcp``.
      * ``sse`` — legacy Server-Sent Events transport.

    The stdio transport exits immediately when stdin closes (which is why a
    bare ``docker run`` keeps restarting); use an HTTP transport to deploy.
    """
    transport = os.environ.get("MCP_TRANSPORT", "stdio").lower()
    if transport in ("http", "streamable-http", "streamable_http"):
        _run_http()
    elif transport == "sse":
        mcp.run(transport="sse")
    else:
        mcp.run(transport="stdio")


def _run_http() -> None:
    """Serve streamable-http behind a TLS-terminating reverse proxy.

    Running ``mcp.run(transport="streamable-http")`` starts uvicorn WITHOUT
    trusting proxy headers. Behind Dokploy/Traefik (which terminate TLS and
    forward plain HTTP with ``X-Forwarded-Proto: https``), the app then thinks
    it is serving plain HTTP and emits redirects (e.g. the trailing-slash
    ``/mcp/`` -> ``/mcp`` 307) with an ``http://`` Location. MCP clients refuse
    that https->http downgrade and report "not connected".

    Fix: run uvicorn with ``proxy_headers=True`` + ``forwarded_allow_ips="*"``
    so the forwarded scheme/host are honored; redirects then stay on https and
    both ``/mcp`` and ``/mcp/`` work for any client.
    """
    import uvicorn

    app = mcp.streamable_http_app()

    host = os.environ.get("MCP_HOST", "0.0.0.0")
    port = int(os.environ.get("MCP_PORT", "8000"))
    uvicorn.run(
        app,
        host=host,
        port=port,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )


if __name__ == "__main__":
    main()
