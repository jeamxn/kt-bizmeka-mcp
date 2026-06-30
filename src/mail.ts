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

async function postJson(
  client: BizmekaClient,
  path: string,
  data: Record<string, string> | Array<[string, string]>,
): Promise<any> {
  const r = await client.http.post(WEBMAIL_BASE + path, {
    headers: ajaxHeaders(true),
    data,
  });
  if (r.status >= 400)
    throw new BizmekaError(`${path} 응답 오류 (status=${r.status})`);
  try {
    return JSON.parse(r.text);
  } catch {
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
async function prepareWrite(
  client: BizmekaClient,
  ukey?: string,
): Promise<string> {
  const data: Record<string, string> = { first: "1" };
  if (ukey) data.ukey = ukey;
  const out = await postJson(client, "/mail/json/write.do", data);
  const tempKey = out.MailWriteForm?.tempKey;
  if (!tempKey) {
    throw new BizmekaError("write.do에서 tempKey를 얻지 못했습니다.");
  }
  return tempKey;
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
  const tempKey = await prepareWrite(client, replyUkey);
  const data: Record<string, string> = {
    tempKey,
    first: "1",
    to,
    cc,
    bcc,
    subject,
    body,
    body_src: "",
    fromname: fromname || client.username,
    fromaddr: fromaddr || `${client.username}@bizmeka.com`,
    attachments: "",
    tempsave: "0",
    is_receipt: isReceipt ? "1" : "0",
    _is_receipt: isReceipt ? "1" : "0",
    characterset: "UTF-8",
    _csrf: token,
  };
  if (replyUkey) data.ukey = replyUkey;
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
