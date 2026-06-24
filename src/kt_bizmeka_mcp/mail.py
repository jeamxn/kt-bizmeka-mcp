"""KT bizmeka webmail (ezwebmail.bizmeka.com) operations.

These functions drive the mail JSON APIs discovered from the browser traffic.
They operate on an already-authenticated :class:`BizmekaClient` that has entered
webmail via :meth:`BizmekaClient.enter_webmail` (which performs the SP-initiated
SAML SSO and captures the Spring Security ``_csrf`` token).

All endpoints live under ``https://ezwebmail.bizmeka.com`` and require:
  * the shared login cookies (isLogin=Y + webmail JSESSIONID)
  * the ``_csrf`` token in the form body (and ``X-Requested-With`` header)

Folder keys are ``<Name>_<userid>`` e.g. ``Inbox_kidtimes0927``.
"""

from __future__ import annotations

import json
from typing import Optional

from .client import BizmekaClient, BizmekaError, WEBMAIL_BASE

# Logical folder -> bizmeka folder-key prefix
FOLDER_PREFIX = {
    "inbox": "Inbox",
    "sent": "Sent",
    "drafts": "Drafts",
    "spam": "Spam",
    "trash": "Trash",
    "tome": "Tome",       # 내게 쓴 메일
    "forever": "Forever",
    "auth": "Auth",       # AI위협메일함
}

_LIST_REFERER = f"{WEBMAIL_BASE}/mail/list.do?_entityId=ezwebmail.bizmeka.com"


def _ajax_headers(form: bool = False) -> dict:
    h = {
        "X-Requested-With": "XMLHttpRequest",
        "Origin": WEBMAIL_BASE,
        "Referer": _LIST_REFERER,
        "Accept": "application/json, text/javascript, */*; q=0.01",
    }
    if form:
        h["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
    return h


def _require_webmail(client: BizmekaClient) -> str:
    """Return the active webmail _csrf token, entering webmail if needed."""
    token = getattr(client, "_webmail_csrf", None)
    if not token:
        token = client.enter_webmail()
    return token


def folder_key(client: BizmekaClient, folder: str) -> str:
    """Map a logical folder name (or a raw folder key) to a bizmeka folder key."""
    if "_" in folder:  # already a raw key like Inbox_kidtimes0927
        return folder
    prefix = FOLDER_PREFIX.get(folder.lower())
    if not prefix:
        raise BizmekaError(
            f"알 수 없는 폴더: {folder!r}. 가능: {', '.join(FOLDER_PREFIX)}"
        )
    return f"{prefix}_{client.username}"


def _post_json(client: BizmekaClient, path: str, data: dict) -> dict:
    r = client._client.post(WEBMAIL_BASE + path, headers=_ajax_headers(form=True), data=data)
    r.raise_for_status()
    try:
        return json.loads(r.text)
    except ValueError:
        raise BizmekaError(f"{path} 응답을 JSON으로 파싱하지 못했습니다: {r.text[:200]}")


# --------------------------------------------------------------------------
# Read operations
# --------------------------------------------------------------------------
def list_folders(client: BizmekaClient) -> list[dict]:
    """Return all mailboxes with counts (folderKey, folderName, mailcount, newmailcount)."""
    _require_webmail(client)
    r = client._client.post(
        WEBMAIL_BASE + "/common/json/agent.do", headers=_ajax_headers()
    )
    r.raise_for_status()
    return json.loads(r.text).get("mailboxlist", [])


def list_mails(
    client: BizmekaClient,
    folder: str = "inbox",
    page: int = 1,
    sort: str = "recvdate",
    order: str = "desc",
) -> dict:
    """Return a page of mail headers + pagination info for a folder."""
    token = _require_webmail(client)
    data = {
        "folder": folder_key(client, folder),
        "sort": sort,
        "order": order,
        "viewstyle": "1",
        "cpage": str(page),
        "_csrf": token,
    }
    out = _post_json(client, "/mail/json/list.do", data)
    return {"maillist": out.get("maillist", []), "page": out.get("page", {})}


def view_mail(client: BizmekaClient, ukey: str, folder: str = "inbox") -> dict:
    """Return the full content of one mail.

    Extracts the useful bits from MailViewForm (from/to/subject/content/date)
    plus attachment metadata.
    """
    token = _require_webmail(client)
    data = {"folder": folder_key(client, folder), "ukey": ukey, "_csrf": token}
    out = _post_json(client, "/mail/json/view.do", data)
    form = out.get("MailViewForm", {})
    return {
        "ukey": ukey,
        "from": form.get("from"),
        "fromaddr": form.get("fromaddr"),
        "fromname": form.get("fromname"),
        "to": form.get("to"),
        "cc": form.get("cc"),
        "subject": form.get("subject"),
        "date": form.get("senddate") or form.get("date"),
        "content": form.get("content"),
        "attachCount": out.get("attachCount", 0),
        "attachList": out.get("attachList", []),
        "_raw_form_keys": list(form.keys()),
    }


def mark_read(client: BizmekaClient, ukeys: list[str], seen: bool = True) -> bool:
    """Mark one or more mails as read (seen=True) or unread (seen=False)."""
    _require_webmail(client)
    # DMail[] repeated for each ukey
    data: list[tuple[str, str]] = [("DMail[]", k) for k in ukeys]
    data.append(("isseen", "1" if seen else "0"))
    r = client._client.post(
        WEBMAIL_BASE + "/mail/json/readCheck.do",
        headers=_ajax_headers(form=True),
        data=data,  # type: ignore[arg-type]
    )
    r.raise_for_status()
    return r.status_code == 200


def download_attachment(client: BizmekaClient, ukey: str, folder: str = "inbox") -> bytes:
    """Download the raw bytes of a mail's attachment bundle."""
    _require_webmail(client)
    r = client._client.get(
        WEBMAIL_BASE + "/mail/download.do",
        params={"folder": folder_key(client, folder), "ukey": ukey},
        headers={"Referer": _LIST_REFERER},
    )
    r.raise_for_status()
    return r.content


# --------------------------------------------------------------------------
# Write operations
# --------------------------------------------------------------------------
def _prepare_write(client: BizmekaClient, ukey: Optional[str] = None) -> str:
    """Call write.do to obtain a fresh tempKey required by send.do.

    For a reply, pass the original ``ukey``; for a new mail, omit it.
    """
    data = {"first": "1"}
    if ukey:
        data["ukey"] = ukey
    out = _post_json(client, "/mail/json/write.do", data)
    temp_key = out.get("MailWriteForm", {}).get("tempKey")
    if not temp_key:
        raise BizmekaError("write.do에서 tempKey를 얻지 못했습니다.")
    return temp_key


def check_receivers(client: BizmekaClient, to: str, cc: str = "", bcc: str = "") -> dict:
    """Validate recipient addresses before sending."""
    _require_webmail(client)
    return _post_json(
        client,
        "/mail/json/receiverCheck.do",
        {"to": to, "cc": cc, "bcc": bcc, "attach_size": "0"},
    )


def send_mail(
    client: BizmekaClient,
    to: str,
    subject: str,
    body: str,
    cc: str = "",
    bcc: str = "",
    fromname: str = "",
    fromaddr: str = "",
    reply_ukey: Optional[str] = None,
    is_receipt: bool = False,
) -> dict:
    """Send a mail (new or reply).

    Args:
        to/cc/bcc: recipient strings, e.g. '"이름" <a@b.com>' (comma-separated for many)
        subject/body: mail subject and HTML body
        fromname/fromaddr: sender identity (defaults to the logged-in account)
        reply_ukey: if set, prepares the send as a reply to that mail
        is_receipt: request a read receipt

    Returns the parsed send.do JSON response.
    """
    token = _require_webmail(client)
    temp_key = _prepare_write(client, ukey=reply_ukey)
    data = {
        "tempKey": temp_key,
        "first": "1",
        "to": to,
        "cc": cc,
        "bcc": bcc,
        "subject": subject,
        "body": body,
        "body_src": "",
        "fromname": fromname or client.username,
        "fromaddr": fromaddr or f"{client.username}@bizmeka.com",
        "attachments": "",
        "tempsave": "0",
        "is_receipt": "1" if is_receipt else "0",
        "_is_receipt": "1" if is_receipt else "0",
        "characterset": "UTF-8",
        "_csrf": token,
    }
    if reply_ukey:
        data["ukey"] = reply_ukey
    return _post_json(client, "/mail/json/send.do", data)


# --------------------------------------------------------------------------
# Receipt / cancel
# --------------------------------------------------------------------------
def list_receipts(client: BizmekaClient, page: int = 1, search: str = "") -> dict:
    """List sent-mail read-receipt status (수신확인)."""
    token = _require_webmail(client)
    out = _post_json(
        client,
        "/receipt/json/list.do",
        {"act": "RECEIPT", "cpage": str(page), "searchText": search, "_csrf": token},
    )
    return {"receiptlist": out.get("receiptlist", []), "page": out.get("page", {})}


def cancel_send(client: BizmekaClient, mail_key: str, cancel_type: str = "U") -> dict:
    """Cancel an unread sent mail (발송취소).

    Args:
        mail_key: the receipt's ``mail_key`` (from list_receipts)
        cancel_type: 'U' (the observed value)
    """
    _require_webmail(client)
    return _post_json(
        client,
        "/receipt/json/sendcancel.do",
        {"type": cancel_type, "key": mail_key},
    )
