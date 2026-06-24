"""In-memory session registry for in-flight bizmeka logins.

A login spans two MCP tool calls (`bizmeka_login_start` sends the SMS, then
`bizmeka_verify_otp` finishes after the user reads the code), so the
authenticated :class:`BizmekaClient` must survive between calls. We keep them in
a process-local dict keyed by an opaque session id. Sessions expire so stale
cookie jars don't pile up.
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from typing import Dict, Optional

from .client import BizmekaClient

# How long a half-finished login (SMS sent, OTP pending) stays valid.
SESSION_TTL_SECONDS = 600


@dataclass
class Session:
    client: BizmekaClient
    sso_redirect: str  # Location returned by login.do (2nd-step URL)
    created_at: float = field(default_factory=time.time)
    authenticated: bool = False
    portal_url: Optional[str] = None

    @property
    def expired(self) -> bool:
        return (time.time() - self.created_at) > SESSION_TTL_SECONDS


class SessionStore:
    def __init__(self) -> None:
        self._sessions: Dict[str, Session] = {}

    def _gc(self) -> None:
        for sid in [s for s, v in self._sessions.items() if v.expired]:
            try:
                self._sessions[sid].client.close()
            except Exception:
                pass
            del self._sessions[sid]

    def create(self, client: BizmekaClient, sso_redirect: str) -> str:
        self._gc()
        sid = secrets.token_urlsafe(16)
        self._sessions[sid] = Session(client=client, sso_redirect=sso_redirect)
        return sid

    def get(self, sid: str) -> Optional[Session]:
        self._gc()
        return self._sessions.get(sid)

    def drop(self, sid: str) -> None:
        sess = self._sessions.pop(sid, None)
        if sess:
            try:
                sess.client.close()
            except Exception:
                pass


store = SessionStore()
