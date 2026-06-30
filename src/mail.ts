/**
 * KT bizmeka webmail (ezwebmail.bizmeka.com) operations.
 *
 * These functions drive the mail JSON APIs discovered from the browser traffic.
 * They operate on an already-authenticated BizmekaClient that has entered
 * webmail via `enterWebmail` (SP-initiated SAML SSO + Spring `_csrf` capture).
 *
 * All endpoints require the shared login cookies (isLogin=Y + webmail
 * JSESSIONID) and the `_csrf` token in the form body.
 * Folder keys are `<Name>_<userid>` e.g. `Inbox_kidtimes0927`.
 */

import { BizmekaClient, WEBMAIL_BASE } from "./client.ts";
import { BizmekaError } from "./errors.ts";

// Logical folder -> bizmeka folder-key prefix
const FOLDER_PREFIX: Record<string, string> = {
  inbox: "Inbox",
  sent: "Sent",
  drafts: "Drafts",
  spam: "Spam",
  trash: "Trash",
  tome: "Tome", // 내게 쓴 메일
  forever: "Forever",
  auth: "Auth", // AI위협메일함
};

const LIST_REFERER = `${WEBMAIL_BASE}/mail/list.do?_entityId=ezwebmail.bizmeka.com`;

function ajaxHeaders(form = false): Record<string, string> {
  const h: Record<string, string> = {
    "X-Requested-With": "XMLHttpRequest",
    Origin: WEBMAIL_BASE,
    Referer: LIST_REFERER,
    Accept: "application/json, text/javascript, */*; q=0.01",
  };
  if (form) {
    h["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
  }
  return h;
}

async function requireWebmail(client: BizmekaClient): Promise<string> {
  return client.webmailCsrf ?? (await client.enterWebmail());
}

export function folderKey(client: BizmekaClient, folder: string): string {
  if (folder.includes("_")) return folder; // already a raw key
  const prefix = FOLDER_PREFIX[folder.toLowerCase()];
  if (!prefix) {
    throw new BizmekaError(
      `알 수 없는 폴더: ${JSON.stringify(folder)}. 가능: ${Object.keys(FOLDER_PREFIX).join(", ")}`,
    );
  }
  return `${prefix}_${client.username}`;
}

/**
 * Heuristic: did this webmail response mean "your session is gone"?
 * When the shared login/webmail session dies the server stops returning JSON
 * and instead 302-redirects to SSO or serves a login/HTML page. With manual
 * redirects (our HttpClient default) that surfaces as a 3xx/401/403, or as a
 * 200 whose body is HTML (login page) rather than the expected JSON.
 */
function looksLikeSessionLoss(r: { status: number; text: string }): boolean {
  if (r.status === 302 || r.status === 401 || r.status === 403) return true;
  const head = r.text.slice(0, 600).toLowerCase();
  if (
    head.includes("loginform") ||
    head.includes("ssologin") ||
    head.includes("/login.do") ||
    head.includes("secondstepverif")
  ) {
    return true;
  }
  // HTML where we asked for JSON (login/redirect page).
  const trimmed = head.replace(/^\uFEFF/, "").trimStart();
  if (trimmed.startsWith("<!doctype") || trimmed.startsWith("<html")) {
    return true;
  }
  return false;
}

/** Put the freshly-issued _csrf token back into an outgoing form body. */
function replaceCsrf(
  data: Record<string, string> | Array<[string, string]>,
  token: string,
): void {
  if (Array.isArray(data)) {
    let found = false;
    for (const pair of data) {
      if (pair[0] === "_csrf") {
        pair[1] = token;
        found = true;
      }
    }
    if (!found) data.push(["_csrf", token]);
  } else if ("_csrf" in data) {
    data._csrf = token;
  }
}

async function postJson(
  client: BizmekaClient,
  path: string,
  data: Record<string, string> | Array<[string, string]>,
): Promise<any> {
  const fire = () =>
    client.http.post(WEBMAIL_BASE + path, { headers: ajaxHeaders(true), data });

  let r = await fire();

  // Session-refresh: if the session died mid-task, re-enter webmail via SAML
  // SSO (no SMS needed while the ezsso master session is still alive), swap in
  // the new _csrf, and retry the request exactly once.
  if (looksLikeSessionLoss(r)) {
    client.webmailCsrf = null;
    const token = await client.enterWebmail(); // throws if real re-login needed
    replaceCsrf(data, token);
    r = await fire();
  }

  if (r.status >= 400)
    throw new BizmekaError(`${path} 응답 오류 (status=${r.status})`);
  try {
    return JSON.parse(r.text);
  } catch {
    if (looksLikeSessionLoss(r)) {
      throw new BizmekaError(
        "세션이 만료되었습니다. 다시 로그인하세요. (자동 재진입에 실패)",
      );
    }
    throw new BizmekaError(
      `${path} 응답을 JSON으로 파싱하지 못했습니다: ${r.text.slice(0, 200)}`,
    );
  }
}

// --------------------------------------------------------------------------
// Read operations
// --------------------------------------------------------------------------
export async function listFolders(client: BizmekaClient): Promise<any[]> {
  await requireWebmail(client);
  const r = await client.http.post(`${WEBMAIL_BASE}/common/json/agent.do`, {
    headers: ajaxHeaders(),
  });
  if (r.status >= 400)
    throw new BizmekaError(`agent.do 응답 오류 (status=${r.status})`);
  return JSON.parse(r.text).mailboxlist ?? [];
}

export async function listMails(
  client: BizmekaClient,
  folder = "inbox",
  page = 1,
  sort = "recvdate",
  order = "desc",
): Promise<{ maillist: any[]; page: any }> {
  const token = await requireWebmail(client);
  const out = await postJson(client, "/mail/json/list.do", {
    folder: folderKey(client, folder),
    sort,
    order,
    viewstyle: "1",
    cpage: String(page),
    _csrf: token,
  });
  return { maillist: out.maillist ?? [], page: out.page ?? {} };
}

export async function viewMail(
  client: BizmekaClient,
  ukey: string,
  folder = "inbox",
): Promise<any> {
  const token = await requireWebmail(client);
  const out = await postJson(client, "/mail/json/view.do", {
    folder: folderKey(client, folder),
    ukey,
    _csrf: token,
  });
  const form = out.MailViewForm ?? {};
  return {
    ukey,
    from: form.from,
    fromaddr: form.fromaddr,
    fromname: form.fromname,
    to: form.to,
    cc: form.cc,
    subject: form.subject,
    date: form.senddate ?? form.date,
    content: form.content,
    attachCount: out.attachCount ?? 0,
    attachList: out.attachList ?? [],
    _raw_form_keys: Object.keys(form),
  };
}

export async function markRead(
  client: BizmekaClient,
  ukeys: string[],
  seen = true,
): Promise<boolean> {
  await requireWebmail(client);
  // DMail[] repeated for each ukey
  const data: Array<[string, string]> = ukeys.map((k) => ["DMail[]", k]);
  data.push(["isseen", seen ? "1" : "0"]);
  const r = await client.http.post(`${WEBMAIL_BASE}/mail/json/readCheck.do`, {
    headers: ajaxHeaders(true),
    data,
  });
  return r.status === 200;
}

// --------------------------------------------------------------------------
// Write operations
// --------------------------------------------------------------------------
/**
 * Open a compose draft (write.do) and return the server-issued dynamic tokens
 * the send.do call must echo back: `tempKey` and `_dsptok`. The browser fetches
 * these from write.do before every send; omitting them makes send.do 500.
 */
async function prepareWrite(
  client: BizmekaClient,
  ukey?: string,
): Promise<{ tempKey: string; dsptok: string }> {
  const data: Record<string, string> = { first: "1" };
  if (ukey) data.ukey = ukey;
  const out = await postJson(client, "/mail/json/write.do", data);
  const form = out.MailWriteForm ?? {};
  const tempKey = form.tempKey;
  if (!tempKey) {
    throw new BizmekaError("write.do에서 tempKey를 얻지 못했습니다.");
  }
  // _dsptok is a per-draft display token; key casing varies, so search the
  // form for anything resembling dsptok and fall back to top-level.
  const dsptok = findDsptok(form) ?? findDsptok(out) ?? "";
  return { tempKey, dsptok };
}

/** Find a `*dsptok*` value anywhere in a (shallow) JSON object. */
function findDsptok(obj: any): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (/dsptok/i.test(k) && typeof v === "string" && v) return v;
  }
  return undefined;
}

export async function checkReceivers(
  client: BizmekaClient,
  to: string,
  cc = "",
  bcc = "",
): Promise<any> {
  await requireWebmail(client);
  return postJson(client, "/mail/json/receiverCheck.do", {
    to,
    cc,
    bcc,
    attach_size: "0",
  });
}

export interface SendMailOptions {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  fromname?: string;
  fromaddr?: string;
  replyUkey?: string;
  isReceipt?: boolean;
}

export async function sendMail(
  client: BizmekaClient,
  opts: SendMailOptions,
): Promise<any> {
  const {
    to,
    subject,
    body,
    cc = "",
    bcc = "",
    fromname = "",
    fromaddr = "",
    replyUkey,
    isReceipt = false,
  } = opts;
  const token = await requireWebmail(client);
  const { tempKey, dsptok } = await prepareWrite(client, replyUkey);

  // Mirror the browser's send.do body field-for-field. The earlier minimal
  // payload (tempKey/to/subject/body/_csrf only) made the Spring controller
  // 500 on bind — it expects the full form incl. checkbox marker fields
  // (`_xxx=on`) and the per-draft `_dsptok`. Ordered as the browser sends it.
  const today = new Date().toISOString().slice(0, 10); // yyyy-mm-dd (reserveTime)
  const data: Array<[string, string]> = [
    ["tempKey", tempKey],
    ["ukey", replyUkey ?? ""],
    ["first", "0"],
    ["body", body],
    ["body_src", ""],
    ["tempsave", "0"],
    ["attachments", ""],
    ["reserverTime", ""],
    ["mail_cancel_time", "0"],
    ["approval_flag", "0"],
    ["use_sign_showup", "0"],
    ["myTemplateKey", ""],
    ["use_bigfile_password", "1"],
    ["_dsptok", dsptok],
    ["apUser", ""],
    ["fromname", fromname || client.username],
    ["fromaddr", fromaddr || `${client.username}@bizmeka.com`],
    ["_tome", "on"],
    ["to", to],
    ["cc", cc],
    ["bcc", bcc],
    ["subject", subject],
    ["secureHint", ""],
    ["secureValue", ""],
    ["_is_each", "on"],
    ["_important", "on"],
    ["_use_sign", "on"],
    ["sign", ""],
    ["reserveTime", today],
    ["is_secure", "0"],
    ["is_receiptmail", "0"],
    // Spring checkbox: send the value only when on; the `_is_receipt` marker is
    // always present so the binder resets it to false when the value is absent.
    ...(isReceipt ? ([["is_receipt", "1"]] as Array<[string, string]>) : []),
    ["_is_receipt", "on"],
    ["is_save", "1"],
    ["_is_save", "on"],
    ["characterset", "utf-8"],
    ["paper_cpage", ""],
    ["selectPaper", "0"],
    ["selectTemplate", "0"],
    ["bigfileSecureValue", ""],
    ["prevHtml", ""],
    ["_csrf", token],
  ];
  return postJson(client, "/mail/json/send.do", data);
}

// --------------------------------------------------------------------------
// Receipt / cancel
// --------------------------------------------------------------------------
export async function listReceipts(
  client: BizmekaClient,
  page = 1,
  search = "",
): Promise<{ receiptlist: any[]; page: any }> {
  const token = await requireWebmail(client);
  const out = await postJson(client, "/receipt/json/list.do", {
    act: "RECEIPT",
    cpage: String(page),
    searchText: search,
    _csrf: token,
  });
  return { receiptlist: out.receiptlist ?? [], page: out.page ?? {} };
}

export async function cancelSend(
  client: BizmekaClient,
  mailKey: string,
  cancelType = "U",
): Promise<any> {
  await requireWebmail(client);
  return postJson(client, "/receipt/json/sendcancel.do", {
    type: cancelType,
    key: mailKey,
  });
}
