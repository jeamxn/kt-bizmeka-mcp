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

from mcp.server.fastmcp import FastMCP

from .catalog import render_overview, render_tool
from .client import BizmekaClient, BizmekaError
from .session import store

INSTRUCTIONS = (
    "KT 비즈메카 EZ 자동화 MCP. 로그인 자동화를 비롯해 포털 기능 툴이 점진적으로 "
    "추가되는 확장형 서버다.\n\n"
    "중요: 어떤 작업이든 시작하기 전에 반드시 `bizmeka_man` 툴을 먼저 호출해 "
    "현재 사용 가능한 툴과 작업 흐름(워크플로우)을 확인하라. 특정 툴의 상세 사용법이 "
    "필요하면 `bizmeka_man(tool='툴이름')` 으로 조회한다. 흐름을 모른 채 개별 툴을 "
    "임의 순서로 호출하지 말 것."
)

mcp = FastMCP("kt-bizmeka", instructions=INSTRUCTIONS)


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


def main() -> None:
    """Console-script entrypoint: run the MCP server over stdio."""
    mcp.run()


if __name__ == "__main__":
    main()
