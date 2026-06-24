"""Tool catalog + workflows powering the ``bizmeka_man`` tool.

This is the single source of truth for "how do I use this MCP". When you add a
new tool to the server, register it here (CATALOG) and, if it's part of a
multi-step procedure, add/extend a WORKFLOW. The ``bizmeka_man`` tool reads from
here so clients can discover usage at runtime instead of guessing.
"""

from __future__ import annotations

from typing import Dict, List, TypedDict


class ToolDoc(TypedDict):
    summary: str
    args: Dict[str, str]
    returns: str
    notes: str


class Workflow(TypedDict):
    title: str
    steps: List[str]
    description: str


# ---------------------------------------------------------------------------
# Per-tool documentation. Key = exact tool name registered on the MCP server.
# ---------------------------------------------------------------------------
CATALOG: Dict[str, ToolDoc] = {
    "bizmeka_man": {
        "summary": "이 MCP의 사용법/툴 목록/작업 흐름을 조회한다. 작업 전 항상 먼저 호출할 것.",
        "args": {
            "tool": "(선택) 특정 툴 이름. 비우면 전체 흐름과 툴 목록을 반환한다.",
        },
        "returns": "tool 미지정 시 워크플로우+툴 목록, 지정 시 해당 툴 상세 설명",
        "notes": "새 작업을 시작하기 전에 bizmeka_man() 으로 흐름을 먼저 확인하라.",
    },
    "bizmeka_login_start": {
        "summary": "KT 비즈메카 EZ 로그인 시작 — 1차 인증(아이디/비번 RSA 암호화) 후 등록된 휴대폰으로 SMS 인증번호 발송.",
        "args": {
            "username": "비즈메카 아이디",
            "password": "비즈메카 비밀번호",
        },
        "returns": '{"ok": true, "session_id": "...", "message": "..."}',
        "notes": "반환된 session_id 를 bizmeka_verify_otp 에 그대로 넘겨야 한다. 인증번호 유효시간 약 3분.",
    },
    "bizmeka_verify_otp": {
        "summary": "SMS 인증번호로 2차 인증 완료 + SAML SSO → 포털(ezportal) 진입.",
        "args": {
            "session_id": "bizmeka_login_start 가 반환한 세션 ID",
            "cert_key": "휴대폰으로 받은 인증번호",
            "remember_browser": "(선택) True 면 이후 이 세션 쿠키에서 2차 인증 생략",
        },
        "returns": '{"ok": true, "logged_in": true, "portal_url": "..."}',
        "notes": "login_start 이후 약 3분 안에 호출해야 한다. 세션 만료 시 처음부터 다시.",
    },
    "bizmeka_session_status": {
        "summary": "현재 세션의 로그인 상태 확인.",
        "args": {"session_id": "확인할 세션 ID"},
        "returns": '{"ok": true, "authenticated": bool, "logged_in": bool, "portal_url": "..."}',
        "notes": "로그인 완료 후 세션이 살아있는지 확인할 때 사용.",
    },
}


# ---------------------------------------------------------------------------
# Multi-step procedures. Reference tools by name; bizmeka_man renders these.
# ---------------------------------------------------------------------------
WORKFLOWS: Dict[str, Workflow] = {
    "login": {
        "title": "로그인 (2단계 인증)",
        "description": (
            "비즈메카는 SMS 2차 인증이 필수라, 사람이 인증번호를 읽는 단계가 끼어 "
            "있다. 따라서 로그인은 두 번의 툴 호출로 나뉜다."
        ),
        "steps": [
            "bizmeka_login_start(username, password)  → SMS 발송, session_id 수령",
            "(사용자가 휴대폰 SMS 인증번호 확인)",
            "bizmeka_verify_otp(session_id, cert_key) → 2차 인증 + SSO, 포털 진입",
            "bizmeka_session_status(session_id)       → (선택) 로그인 상태 확인",
        ],
    },
}


def render_overview() -> dict:
    """Full usage overview: workflows + available tools."""
    return {
        "about": (
            "KT 비즈메카 EZ 자동화 MCP. 로그인 자동화를 시작으로 포털 기능 툴이 "
            "점진적으로 추가된다. 작업 전 bizmeka_man(tool='...') 으로 각 툴 사용법을 확인하라."
        ),
        "workflows": {
            name: {
                "title": wf["title"],
                "description": wf["description"],
                "steps": wf["steps"],
            }
            for name, wf in WORKFLOWS.items()
        },
        "tools": {name: doc["summary"] for name, doc in CATALOG.items()},
        "hint": "특정 툴 상세는 bizmeka_man(tool='bizmeka_login_start') 처럼 호출.",
    }


def render_tool(tool: str) -> dict:
    """Detailed doc for one tool, or an error with suggestions."""
    doc = CATALOG.get(tool)
    if doc is None:
        return {
            "ok": False,
            "error": f"알 수 없는 툴: {tool!r}",
            "available_tools": list(CATALOG.keys()),
        }
    return {"ok": True, "tool": tool, **doc}
