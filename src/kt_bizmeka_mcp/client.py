"""HTTP client implementing the KT bizmeka EZ multi-step login flow.

Domains:
  * ``ezsso.bizmeka.com``   — IdP: login form, RSA key, CSRF, 1st/2nd factor
  * ``ezportal.bizmeka.com`` — SP: receives the signed SAML assertion, hosts portal

The flow is intentionally split so a human can read the SMS one-time code between
``start_login`` (sends the SMS) and ``verify_otp`` (completes 2FA + SSO).
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

from .crypto import RSAEncryptor

SSO_BASE = "https://ezsso.bizmeka.com"
PORTAL_BASE = "https://ezportal.bizmeka.com"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
)

# Regexes against /loginForm.do
_RE_MODULUS = re.compile(r'id="sproKeyModulus"\s+value="([0-9a-fA-F]+)"')
_RE_EXPONENT = re.compile(r'id="sproKeyExponent"\s+value="([0-9a-fA-F]+)"')
# Password fixed suffix appended after the RSA ciphertext in the inline script:
#   $("#j_password").val(securedPassword + 'AABBCC...');
_RE_PW_SUFFIX = re.compile(
    r'#j_password"\)\.val\(\s*securedPassword\s*\+\s*[\'"]([0-9A-Fa-f]+)[\'"]'
)
# OWASP CSRFGuard token from /JavaScriptServlet:
#   "OWASP_CSRFTOKEN", "XXXX-XXXX-...");
_RE_CSRF = re.compile(r'"OWASP_CSRFTOKEN",\s*"([A-Z0-9-]+)"')


class BizmekaError(RuntimeError):
    """Raised when a login step does not reach the expected state."""


@dataclass
class LoginContext:
    """Parsed, session-scoped values needed to drive the login."""

    modulus: str
    exponent: str
    password_suffix: str
    csrf_token: str


@dataclass
class BizmekaClient:
    """Stateful client holding one cookie jar across the whole login flow."""

    username: str
    password: str
    timeout: float = 20.0
    _client: httpx.Client = field(init=False, repr=False)
    _ctx: Optional[LoginContext] = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        self._client = httpx.Client(
            timeout=self.timeout,
            follow_redirects=False,
            headers={"User-Agent": USER_AGENT, "Accept-Language": "ko-KR,ko;q=0.9"},
        )

    # -- lifecycle ---------------------------------------------------------
    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "BizmekaClient":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    # -- step 1: fetch login form + RSA key + password suffix --------------
    def _load_login_context(self) -> LoginContext:
        r = self._client.get(f"{SSO_BASE}/loginForm.do")
        r.raise_for_status()
        html = r.text

        m_mod = _RE_MODULUS.search(html)
        m_exp = _RE_EXPONENT.search(html)
        m_suf = _RE_PW_SUFFIX.search(html)
        if not (m_mod and m_exp):
            raise BizmekaError("RSA public key not found in loginForm.do")
        suffix = m_suf.group(1) if m_suf else ""

        # CSRF token comes from the CSRFGuard servlet (shares the cookie jar)
        rj = self._client.get(
            f"{SSO_BASE}/JavaScriptServlet",
            headers={
                "Referer": f"{SSO_BASE}/loginForm.do",
                "X-Requested-With": "XMLHttpRequest",
            },
        )
        rj.raise_for_status()
        m_csrf = _RE_CSRF.search(rj.text)
        if not m_csrf:
            raise BizmekaError("OWASP_CSRFTOKEN not found in JavaScriptServlet")

        ctx = LoginContext(
            modulus=m_mod.group(1),
            exponent=m_exp.group(1),
            password_suffix=suffix,
            csrf_token=m_csrf.group(1),
        )
        self._ctx = ctx
        return ctx

    # -- step 2: submit encrypted credentials -----------------------------
    def submit_credentials(self) -> None:
        """Perform 1st-factor login. Expects a 302 to the 2nd-step page."""
        ctx = self._load_login_context()
        rsa = RSAEncryptor(ctx.modulus, ctx.exponent)
        secured_user = rsa.encrypt(self.username)
        secured_pw = rsa.encrypt(self.password) + ctx.password_suffix

        r = self._client.post(
            f"{SSO_BASE}/login.do",
            params={"OWASP_CSRFTOKEN": ctx.csrf_token},
            data={
                "j_username": secured_user,
                "j_password": secured_pw,
                "messageId": "",
                "bannerUrl": "",
                "OWASP_CSRFTOKEN": ctx.csrf_token,
            },
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": SSO_BASE,
                "Referer": f"{SSO_BASE}/loginForm.do",
            },
        )
        location = r.headers.get("Location", "")
        if r.status_code == 302 and "secondStepVerif" in location:
            return  # 1st factor OK, 2FA required
        if r.status_code == 302 and "loginForm" in location:
            raise BizmekaError("로그인 실패: 아이디 또는 비밀번호가 올바르지 않습니다.")
        raise BizmekaError(
            f"예상치 못한 응답 (status={r.status_code}, location={location!r})"
        )

    @property
    def csrf_token(self) -> str:
        if not self._ctx:
            raise BizmekaError("login context not initialized")
        return self._ctx.csrf_token
