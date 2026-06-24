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
from html import unescape
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

    # -- step 3: load 2nd-step page (also primes the referer/cookies) ------
    def load_second_step(self) -> None:
        r = self._client.get(
            f"{SSO_BASE}/rule/secondStepVerifView.do",
            headers={"Referer": f"{SSO_BASE}/loginForm.do"},
        )
        r.raise_for_status()
        if "loginVerify" not in r.text:
            raise BizmekaError("2차 인증 페이지를 불러오지 못했습니다.")

    # -- step 4: send the SMS one-time code to the registered phone --------
    def send_sms(self) -> None:
        """Trigger an SMS containing the cert key. Raises on server error."""
        r = self._client.get(
            f"{SSO_BASE}/sendCertKeyToMobile.do",
            params={"_": int(time.time() * 1000)},
            headers=self._ajax_headers(),
        )
        r.raise_for_status()
        data = r.json()
        # res: 0 = OK, -1 = session expired, other = error (msg present)
        if data.get("res") != 0:
            raise BizmekaError(
                f"인증번호 발송 실패: {data.get('msg', '알 수 없는 오류')}"
            )

    # -- step 5: pre-check the entered code (AJAX, optional) ---------------
    def confirm_cert_key(self, cert_key: str) -> bool:
        r = self._client.get(
            f"{SSO_BASE}/confirmCertKey.do",
            params={"certKey": cert_key, "_": int(time.time() * 1000)},
            headers=self._ajax_headers(),
        )
        r.raise_for_status()
        try:
            return r.json().get("res") == 0
        except ValueError:
            return False

    # -- step 6: finalize 2nd factor -> SAML auto-post -> portal -----------
    def verify_otp(self, cert_key: str, remember_browser: bool = False) -> str:
        """Submit the SMS code, post the resulting SAML assertion to the portal,
        and land on the portal main page. Returns the final portal URL.

        Real flow (observed):
          1. GET  /confirmCertKey.do   registers the entered code (res=0)
          2. POST /loginVerify.do      returns 200 with a SAML auto-post form
                                       and sets isLogin=Y on success
          3. POST ezportal assertionConsumer.do with the SAMLResponse
          4. GET  ezportal portal/main/main.do
        """
        if not self._ctx:
            raise BizmekaError(
                "login context not initialized; call submit_credentials first"
            )

        # 1) confirm the code first (the browser does this before loginVerify)
        if not self.confirm_cert_key(cert_key):
            raise BizmekaError("2차 인증 실패: 인증번호가 올바르지 않습니다.")

        # 2) loginVerify -> SAML auto-post HTML (status 200) + isLogin cookie
        data = {
            "bannerUrl": "",
            "certKey": cert_key,
            "OWASP_CSRFTOKEN": self._ctx.csrf_token,
        }
        if remember_browser:
            data["browserCertify"] = "Y"
        r = self._client.post(
            f"{SSO_BASE}/loginVerify.do",
            params={"OWASP_CSRFTOKEN": self._ctx.csrf_token},
            data=data,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": SSO_BASE,
                "Referer": f"{SSO_BASE}/rule/secondStepVerifView.do",
            },
        )
        loc = r.headers.get("Location", "")
        if "secondStepVerif" in loc or "loginForm" in loc:
            raise BizmekaError("2차 인증 실패: 인증번호가 틀렸거나 만료되었습니다.")
        if self._client.cookies.get("isLogin") != "Y":
            raise BizmekaError(
                "2차 인증 실패: 로그인 쿠키가 설정되지 않았습니다. 인증번호를 확인하세요."
            )

        # 3) post the SAML assertion carried in the response body to the SP
        saml = self._extract_saml_form(r.text)
        if saml is None:
            raise BizmekaError("2차 인증은 통과했으나 SAML 응답을 찾지 못했습니다.")
        action, fields = saml
        self._client.post(
            action,
            data=fields,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": SSO_BASE,
                "Referer": f"{SSO_BASE}/",
            },
        )

        # 4) confirm the portal session
        rp = self._client.get(
            f"{PORTAL_BASE}/portal/main/main.do",
            headers={"Referer": f"{SSO_BASE}/"},
            follow_redirects=True,
        )
        if rp.status_code != 200:
            raise BizmekaError(f"포털 진입 실패 (status={rp.status_code})")
        return str(rp.url)

    @staticmethod
    def _extract_saml_form(html: str):
        """Return (action_url, {field: value}) for a SAML auto-post form, or None.

        The action URL arrives HTML-entity-encoded (e.g. ``https&#x3a;&#x2f;...``)
        so we unescape it before use.
        """
        if "SAMLResponse" not in html:
            return None
        action_m = re.search(r'<form[^>]+action="([^"]+)"', html, re.I)
        action = (
            unescape(action_m.group(1))
            if action_m
            else f"{PORTAL_BASE}/sso/assertionConsumer.do"
        )
        fields = {}
        for m in re.finditer(
            r'<input[^>]+name="([^"]+)"[^>]*value="([^"]*)"', html, re.I
        ):
            fields[unescape(m.group(1))] = unescape(m.group(2))
        if "SAMLResponse" not in fields:
            return None
        return action, fields

    def _ajax_headers(self) -> dict:
        if not self._ctx:
            raise BizmekaError("login context not initialized")
        return {
            "OWASP_CSRFTOKEN": self._ctx.csrf_token,
            "Referer": f"{SSO_BASE}/rule/secondStepVerifView.do",
            "X-Requested-With": "XMLHttpRequest, OWASP CSRFGuard Project",
            "Accept": "*/*",
        }

    @property
    def csrf_token(self) -> str:
        if not self._ctx:
            raise BizmekaError("login context not initialized")
        return self._ctx.csrf_token

    @property
    def is_logged_in(self) -> bool:
        return self._client.cookies.get("isLogin") == "Y"
