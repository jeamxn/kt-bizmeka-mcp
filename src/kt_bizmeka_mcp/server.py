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

from .client import BizmekaClient, BizmekaError
from .session import store

mcp = FastMCP("kt-bizmeka")


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
        redirect = client.verify_otp(cert_key.strip(), remember_browser=remember_browser)
        portal_url = client.complete_sso(redirect)
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
