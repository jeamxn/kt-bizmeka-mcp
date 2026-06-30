/**
 * MCP server exposing KT bizmeka EZ login + webmail as tools.
 *
 * Because the login requires an SMS one-time code that only the account owner
 * can read, the flow is split into two tool calls:
 *
 *   bizmeka_login_start(username, password)
 *       -> 1st-factor login + sends the SMS, returns a session_id
 *   bizmeka_verify_otp(session_id, cert_key)
 *       -> finishes 2FA + SAML SSO, lands on the portal
 *
 * Credentials are held only in memory for the lifetime of the in-flight session.
 *
 * Transport is chosen by the MCP_TRANSPORT env var:
 *   * stdio (default)         — local MCP clients spawn the process (Claude Desktop, Hermes)
 *   * streamable-http / http  — long-running HTTP service (Docker/Dokploy), endpoint /mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { renderOverview, renderTool } from "./catalog.ts";
import { BizmekaClient } from "./client.ts";
import { BizmekaError } from "./errors.ts";
import * as mail from "./mail.ts";
import * as calendar from "./calendar.ts";
import { store, trust } from "./session.ts";

const VERSION = "0.3.0";

const INSTRUCTIONS =
  "KT 비즈메카 EZ 자동화 MCP. 로그인 자동화를 비롯해 포털 기능 툴이 점진적으로 " +
  "추가되는 확장형 서버다.\n\n" +
  "중요: 어떤 작업이든 시작하기 전에 반드시 `bizmeka_man` 툴을 먼저 호출해 " +
  "현재 사용 가능한 툴과 작업 흐름(워크플로우)을 확인하라. 특정 툴의 상세 사용법이 " +
  "필요하면 `bizmeka_man(tool='툴이름')` 으로 조회한다. 흐름을 모른 채 개별 툴을 " +
  "임의 순서로 호출하지 말 것.";

/** Wrap a tool result object as MCP structured + text content. */
function ok(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
  };
}

/** Normalize thrown errors into the {ok:false,error} shape the Python server used. */
function errPayload(e: unknown): { ok: false; error: string } {
  if (e instanceof BizmekaError) return { ok: false, error: e.message };
  const msg = e instanceof Error ? e.message : String(e);
  return { ok: false, error: `요청 실패: ${msg}` };
}

/** Resolve an authenticated client from a session, or return an error payload. */
function loggedInClient(
  sessionId: string,
): { client: BizmekaClient; err: null } | { client: null; err: object } {
  const sess = store.get(sessionId);
  if (!sess) {
    return {
      client: null,
      err: { ok: false, error: "세션이 만료되었거나 존재하지 않습니다. 다시 로그인하세요." },
    };
  }
  if (!sess.client.isLoggedIn) {
    return { client: null, err: { ok: false, error: "로그인되지 않은 세션입니다." } };
  }
  return { client: sess.client, err: null };
}

/** Heuristic: does this error/text indicate the server-side session died? */
function isSessionDead(msg: string): boolean {
  return (
    msg.includes("세션이 만료") ||
    msg.includes("세션이 존재") ||
    msg.includes("로그인되지 않은") ||
    msg.includes("다시 로그인")
  );
}

/**
 * Attempt an unattended re-login for a client whose server session died.
 * Works WITHOUT SMS when the client carries a browserCertify cookie + password
 * (persisted in the session/trust store). Returns true on success.
 *
 * Strategy: try the in-jar browserCertify cookies first; if that still demands
 * 2FA (cookie expired) fall back to the trust store's cookies for this user.
 */
async function tryRelogin(client: BizmekaClient): Promise<boolean> {
  if (!client.password) return false;
  // Reset any cached service tokens; cookies (incl. browserCertify) are kept.
  client.webmailCsrf = null;
  client.groupwareCsrf = null;
  try {
    const { needs2fa } = await client.submitCredentials();
    if (!needs2fa) return true;
  } catch {
    /* fall through to trust-store cookies */
  }
  // Reload remembered cookies for this user and retry once.
  const trusted = trust.load(client.username);
  if (trusted) {
    client.loadCookies(trusted);
    try {
      const { needs2fa } = await client.submitCredentials();
      if (!needs2fa) return true;
    } catch {
      /* give up — caller surfaces the original error */
    }
  }
  return false;
}

/**
 * Run a webmail/planner operation on the logged-in client for `sessionId`, then
 * persist the (possibly refreshed) client state back to disk. Because stdio
 * hosts spawn a fresh process per tool call, saving here lets the next call
 * skip re-entry. If the server session has died, transparently re-logs in
 * (no SMS, via the stored browserCertify cookie + password) and retries once.
 */
async function withClient(
  sessionId: string,
  fn: (client: BizmekaClient) => Promise<object>,
) {
  const { client, err } = loggedInClient(sessionId);
  if (err) return ok(err);
  try {
    const payload = await fn(client!);
    store.save(sessionId, client!);
    return ok(payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Server session likely dead — try an unattended re-login + one retry.
    if (isSessionDead(msg) && (await tryRelogin(client!))) {
      try {
        const payload = await fn(client!);
        store.save(sessionId, client!, { authenticated: true });
        return ok(payload);
      } catch (e2) {
        return ok(errPayload(e2));
      }
    }
    return ok(errPayload(e));
  }
}

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "kt-bizmeka", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "bizmeka_man",
    {
      description:
        "이 MCP의 사용법을 조회한다. 작업 전 항상 먼저 호출하라. 인자 없이 호출하면 " +
        "전체 작업 흐름(워크플로우)과 사용 가능한 툴 목록을 반환한다. tool 인자에 특정 " +
        "툴 이름을 넣으면 그 툴의 상세 사용법(인자, 반환값, 주의사항)을 알려준다.",
      inputSchema: {
        tool: z.string().optional().describe("(선택) 상세 설명을 볼 툴 이름. 비우면 전체 개요."),
      },
    },
    async ({ tool }) => ok(tool ? renderTool(tool) : renderOverview()),
  );

  server.registerTool(
    "bizmeka_login_start",
    {
      description:
        "KT 비즈메카 EZ 로그인을 시작한다. 아이디/비밀번호로 1차 인증을 수행한다. " +
        "이전에 remember_me=true 로 로그인한 적이 있으면 SMS 없이 바로 로그인이 완료되고 " +
        "logged_in=true 가 반환된다(이 경우 verify_otp 불필요). 그렇지 않으면 등록된 휴대폰으로 " +
        "SMS 인증번호를 발송하고, 반환된 session_id 와 인증번호로 bizmeka_verify_otp 를 호출한다.",
      inputSchema: {
        username: z.string().describe("비즈메카 아이디"),
        password: z.string().describe("비즈메카 비밀번호"),
        remember_me: z
          .boolean()
          .optional()
          .describe(
            "True 면 (a) 저장된 신뢰 브라우저 쿠키로 SMS 생략 로그인을 시도하고, (b) 이번 로그인 성공 시 이후 무인 재로그인용으로 신뢰 쿠키를 저장한다. 기본 True.",
          ),
      },
    },
    async ({ username, password, remember_me }) => {
      const remember = remember_me ?? true;
      const client = new BizmekaClient(username, password);
      // Try a previously-remembered browser: load its cookies so 1st-factor
      // can complete without SMS.
      if (remember) {
        const trusted = trust.load(username);
        if (trusted) client.loadCookies(trusted);
      }
      try {
        const { needs2fa } = await client.submitCredentials();
        if (!needs2fa) {
          // Trusted-browser fast path: already logged in, no SMS needed.
          if (remember) {
            trust.save(username, client.dumpCookies(), password);
          }
          const sid = store.create(client, "");
          store.save(sid, client, { authenticated: true });
          return ok({
            ok: true,
            session_id: sid,
            logged_in: true,
            message:
              "신뢰 브라우저로 SMS 없이 로그인 완료. 바로 사용 가능합니다 (verify_otp 불필요).",
          });
        }
        await client.loadSecondStep();
        await client.sendSms(); // SMS to registered phone
      } catch (e) {
        // A stale trust cookie can break 1st-factor; retry once cleanly.
        if (remember && trust.load(username)) {
          trust.drop(username);
          const fresh = new BizmekaClient(username, password);
          try {
            const { needs2fa } = await fresh.submitCredentials();
            if (!needs2fa) {
              const sid = store.create(fresh, "");
              store.save(sid, fresh, { authenticated: true });
              return ok({
                ok: true,
                session_id: sid,
                logged_in: true,
                message: "로그인 완료 (신뢰 쿠키 갱신 필요).",
              });
            }
            await fresh.loadSecondStep();
            await fresh.sendSms();
            const sid = store.create(fresh, "");
            return ok({
              ok: true,
              session_id: sid,
              message:
                "인증번호를 등록된 휴대폰으로 발송했습니다. 받은 인증번호로 " +
                "bizmeka_verify_otp 를 호출하세요. (유효시간 약 3분)",
            });
          } catch (e2) {
            return ok(errPayload(e2));
          }
        }
        return ok(errPayload(e));
      }
      const sid = store.create(client, "");
      return ok({
        ok: true,
        session_id: sid,
        message:
          "인증번호를 등록된 휴대폰으로 발송했습니다. 받은 인증번호로 " +
          "bizmeka_verify_otp 를 호출하세요. (유효시간 약 3분)",
      });
    },
  );

  server.registerTool(
    "bizmeka_verify_otp",
    {
      description:
        "SMS 인증번호로 2차 인증을 완료하고 포털에 로그인한다.",
      inputSchema: {
        session_id: z.string().describe("bizmeka_login_start 가 반환한 세션 ID"),
        cert_key: z.string().describe("휴대폰으로 받은 인증번호"),
        remember_browser: z
          .boolean()
          .optional()
          .describe("True 면 이후 이 브라우저(쿠키jar)에서 2차 인증 생략"),
      },
    },
    async ({ session_id, cert_key, remember_browser }) => {
      const sess = store.get(session_id);
      if (!sess) {
        return ok({
          ok: false,
          error: "세션이 만료되었거나 존재하지 않습니다. 다시 로그인하세요.",
        });
      }
      try {
        const portalUrl = await sess.client.verifyOtp(
          cert_key.trim(),
          remember_browser ?? false,
        );
        // Persist the now-authenticated state (isLogin cookie etc.) so the next
        // tool call — which may run in a freshly spawned process — sees it.
        store.save(session_id, sess.client, {
          authenticated: true,
          portalUrl,
        });
        // If the user opted in, remember this browser so future logins skip SMS.
        if (remember_browser) {
          trust.save(
            sess.client.username,
            sess.client.dumpCookies(),
            sess.client.password,
          );
        }
        return ok({
          ok: true,
          session_id,
          logged_in: sess.client.isLoggedIn,
          portal_url: portalUrl,
          message: "로그인 완료. 포털에 진입했습니다.",
        });
      } catch (e) {
        return ok(errPayload(e));
      }
    },
  );

  server.registerTool(
    "bizmeka_session_status",
    {
      description: "현재 세션의 로그인 상태를 확인한다.",
      inputSchema: { session_id: z.string().describe("확인할 세션 ID") },
    },
    async ({ session_id }) => {
      const sess = store.get(session_id);
      if (!sess) {
        return ok({ ok: false, error: "세션이 만료되었거나 존재하지 않습니다." });
      }
      return ok({
        ok: true,
        authenticated: sess.authenticated,
        logged_in: sess.client.isLoggedIn,
        portal_url: sess.portalUrl,
      });
    },
  );

  server.registerTool(
    "bizmeka_logout",
    {
      description:
        "저장된 로그인 정보를 삭제한다. 기억된 신뢰 브라우저 쿠키와 비밀번호(무인 재로그인용)를 " +
        "지우고, 활성 세션도 함께 정리한다. 이후 다시 쓰려면 SMS 인증부터 새로 로그인해야 한다.",
      inputSchema: {
        username: z
          .string()
          .optional()
          .describe("로그아웃할 계정 아이디. session_id 로도 지정 가능."),
        session_id: z
          .string()
          .optional()
          .describe("정리할 세션 ID (선택). 주면 해당 세션도 삭제한다."),
        all: z
          .boolean()
          .optional()
          .describe("True 면 저장된 모든 계정의 기억 정보를 삭제한다."),
      },
    },
    async ({ username, session_id, all }) => {
      const dropped: string[] = [];
      if (all) {
        for (const u of trust.listUsernames()) {
          trust.drop(u);
          dropped.push(u);
        }
      } else {
        // Resolve username from the session if not given explicitly.
        let user = username;
        if (!user && session_id) {
          const sess = store.get(session_id);
          user = sess?.client.username;
        }
        if (user) {
          trust.drop(user);
          dropped.push(user);
        }
      }
      if (session_id) store.drop(session_id);
      if (dropped.length === 0 && !session_id) {
        return ok({
          ok: false,
          error:
            "로그아웃할 대상을 찾지 못했습니다. username, session_id, 또는 all=true 중 하나를 지정하세요.",
        });
      }
      return ok({
        ok: true,
        forgot_usernames: dropped,
        session_cleared: Boolean(session_id),
        message:
          dropped.length > 0
            ? `저장된 로그인 정보를 삭제했습니다: ${dropped.join(", ")}`
            : "세션을 정리했습니다.",
      });
    },
  );

  // ===================== WEBMAIL TOOLS ===================================
  server.registerTool(
    "bizmeka_mail_folders",
    {
      description: "웹메일 메일함(폴더) 목록과 메일 수를 조회한다.",
      inputSchema: { session_id: z.string().describe("로그인된 세션 ID") },
    },
    async ({ session_id }) =>
      withClient(session_id, async (client) => ({
        ok: true,
        folders: await mail.listFolders(client),
      })),
  );

  server.registerTool(
    "bizmeka_mail_list",
    {
      description: "메일함의 메일 목록을 조회한다.",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        folder: z
          .string()
          .optional()
          .describe("inbox/sent/drafts/spam/trash/tome/forever/auth (기본 inbox)"),
        page: z.number().int().optional().describe("페이지 번호 (기본 1)"),
      },
    },
    async ({ session_id, folder, page }) =>
      withClient(session_id, async (client) => ({
        ok: true,
        ...(await mail.listMails(client, folder ?? "inbox", page ?? 1)),
      })),
  );

  server.registerTool(
    "bizmeka_mail_view",
    {
      description: "특정 메일의 본문/발신자/수신자/첨부 정보를 조회한다.",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        ukey: z.string().describe("메일 고유키 (bizmeka_mail_list 결과의 ukey)"),
        folder: z.string().optional().describe("메일이 속한 폴더 (기본 inbox)"),
      },
    },
    async ({ session_id, ukey, folder }) =>
      withClient(session_id, async (client) => ({
        ok: true,
        mail: await mail.viewMail(client, ukey, folder ?? "inbox"),
      })),
  );

  server.registerTool(
    "bizmeka_mail_mark_read",
    {
      description: "메일을 읽음(seen=True) 또는 안읽음(seen=False)으로 표시한다.",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        ukeys: z.array(z.string()).describe("대상 메일 ukey 목록"),
        seen: z.boolean().optional().describe("True=읽음, False=안읽음 (기본 True)"),
      },
    },
    async ({ session_id, ukeys, seen }) =>
      withClient(session_id, async (client) => ({
        ok: await mail.markRead(client, ukeys, seen ?? true),
      })),
  );

  server.registerTool(
    "bizmeka_mail_send",
    {
      description:
        "메일을 발송한다. (신규 발송 또는 답장) 주의: 실제로 메일이 발송되는 부작용이 " +
        "있다. 호출 전 수신자/제목/본문을 사용자에게 확인받는 것을 권장한다.",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        to: z
          .string()
          .describe("받는사람. 형식 '\"이름\" <a@b.com>' 또는 'a@b.com', 여러명은 콤마 구분"),
        subject: z.string().describe("제목"),
        body: z.string().describe("본문 (HTML 허용)"),
        cc: z.string().optional().describe("참조 (선택)"),
        bcc: z.string().optional().describe("숨은참조 (선택)"),
        reply_ukey: z.string().optional().describe("답장일 경우 원본 메일 ukey (선택)"),
        is_receipt: z.boolean().optional().describe("수신확인 요청 여부"),
      },
    },
    async ({ session_id, to, subject, body, cc, bcc, reply_ukey, is_receipt }) =>
      withClient(session_id, async (client) => ({
        ok: true,
        result: await mail.sendMail(client, {
          to,
          subject,
          body,
          cc: cc ?? "",
          bcc: bcc ?? "",
          replyUkey: reply_ukey || undefined,
          isReceipt: is_receipt ?? false,
        }),
      })),
  );

  server.registerTool(
    "bizmeka_mail_check_receivers",
    {
      description: "발송 전 수신자 주소 유효성을 검증한다.",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        to: z.string().describe("받는사람"),
        cc: z.string().optional().describe("참조"),
        bcc: z.string().optional().describe("숨은참조"),
      },
    },
    async ({ session_id, to, cc, bcc }) =>
      withClient(session_id, async (client) => ({
        ok: true,
        result: await mail.checkReceivers(client, to, cc ?? "", bcc ?? ""),
      })),
  );

  server.registerTool(
    "bizmeka_mail_receipts",
    {
      description: "보낸 메일의 수신확인(읽음) 상태 목록을 조회한다.",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        page: z.number().int().optional().describe("페이지 번호"),
        search: z.string().optional().describe("검색어 (선택)"),
      },
    },
    async ({ session_id, page, search }) =>
      withClient(session_id, async (client) => ({
        ok: true,
        ...(await mail.listReceipts(client, page ?? 1, search ?? "")),
      })),
  );

  server.registerTool(
    "bizmeka_mail_cancel_send",
    {
      description:
        "아직 읽지 않은 보낸 메일의 발송을 취소한다. 주의: 수신자가 아직 읽지 않은 " +
        "경우에만 취소 가능 (bizmeka_mail_receipts 의 available_cancel 로 확인).",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        mail_key: z.string().describe("취소할 메일의 mail_key (bizmeka_mail_receipts 결과)"),
      },
    },
    async ({ session_id, mail_key }) =>
      withClient(session_id, async (client) => ({
        ok: true,
        result: await mail.cancelSend(client, mail_key),
      })),
  );

  // ===================== CALENDAR / PLANNER TOOLS ========================
  server.registerTool(
    "bizmeka_calendar_list",
    {
      description:
        "기간 내 내 일정 목록을 조회한다. 날짜는 'YYYY-MM-DD' 또는 ISO/epoch 허용. " +
        "반환에 현재 사용자 정보(user)와 일정 배열(events: scheduleId/title/startDate/endDate 등)이 포함된다.",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        start_date: z.string().describe("조회 시작일 (예: 2026-06-01)"),
        end_date: z.string().describe("조회 종료일 (예: 2026-06-30)"),
      },
    },
    async ({ session_id, start_date, end_date }) =>
      withClient(session_id, async (client) => ({
        ok: true,
        ...(await calendar.listSchedules(client, start_date, end_date)),
      })),
  );

  server.registerTool(
    "bizmeka_calendar_search",
    {
      description: "키워드로 일정을 검색한다 (제목 기본).",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        start_date: z.string().describe("검색 시작일"),
        end_date: z.string().describe("검색 종료일"),
        keyword: z.string().optional().describe("검색어"),
        search_fields: z
          .string()
          .optional()
          .describe("검색 대상 필드 (기본 title, 예: 'title,contents')"),
        page: z.number().int().optional().describe("페이지 번호 (기본 1)"),
      },
    },
    async ({ session_id, start_date, end_date, keyword, search_fields, page }) =>
      withClient(session_id, async (client) => ({
        ok: true,
        result: await calendar.searchSchedules(client, {
          startDate: start_date,
          endDate: end_date,
          keyword,
          searchFields: search_fields,
          pageNumber: page,
        }),
      })),
  );

  server.registerTool(
    "bizmeka_calendar_get",
    {
      description: "일정 1건의 상세 정보를 조회한다.",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        schedule_id: z.string().describe("일정 ID (목록/검색 결과의 scheduleId)"),
      },
    },
    async ({ session_id, schedule_id }) =>
      withClient(session_id, async (client) => ({
        ok: true,
        schedule: await calendar.getSchedule(client, schedule_id),
      })),
  );

  const scheduleFields = {
    title: z.string().describe("일정 제목"),
    start_date: z
      .string()
      .describe("시작 일시 ('YYYY-MM-DD HH:mm' 또는 ISO). 종일이면 날짜만"),
    end_date: z.string().describe("종료 일시"),
    contents: z.string().optional().describe("내용/메모"),
    place: z.string().optional().describe("장소"),
    wholeday: z.boolean().optional().describe("종일 일정 여부"),
    category_id: z
      .string()
      .optional()
      .describe("분류 ID (기본 '1'=업무)"),
    is_public: z.boolean().optional().describe("공개 일정 여부"),
    alarm_minutes: z
      .array(z.number().int())
      .optional()
      .describe("미리 알림(분) 목록. 예: [30, 15]. 비우면 알림 없음"),
    facility_ids: z
      .array(z.string())
      .optional()
      .describe(
        "예약할 회의실/공용설비의 facilityId 목록. bizmeka_facility_list 로 먼저 조회해 얻는다. 해당 설비 객체를 자동으로 채워 예약한다.",
      ),
  };

  function toAlarms(mins?: number[]) {
    // observed alarmType: "2"=popup, "3"=mail; default to popup ("2").
    return (mins ?? []).map((m) => ({ type: "2", minutes: String(m) }));
  }

  /**
   * Resolve facility_ids into the full facility objects create.do expects, by
   * querying both conference rooms and equipment for the schedule's window and
   * matching by facilityId. Throws if any requested id isn't available.
   */
  async function resolveFacilities(
    client: BizmekaClient,
    facilityIds: string[] | undefined,
    startDate: string,
    endDate: string,
  ): Promise<any[]> {
    if (!facilityIds || facilityIds.length === 0) return [];
    const [rooms, equip] = await Promise.all([
      calendar.listFacilities(client, startDate, endDate, {
        conferenceRoom: true,
      }),
      calendar.listFacilities(client, startDate, endDate, {
        conferenceRoom: false,
      }),
    ]);
    const all: any[] = [
      ...(rooms.facilities ?? []),
      ...(equip.facilities ?? []),
    ];
    const picked: any[] = [];
    for (const id of facilityIds) {
      const f = all.find((x) => String(x.facilityId) === String(id));
      if (!f) {
        throw new BizmekaError(
          `설비 ID ${id} 를 찾을 수 없습니다. bizmeka_facility_list 로 사용 가능한 ID를 확인하세요.`,
        );
      }
      picked.push(f);
    }
    return picked;
  }

  server.registerTool(
    "bizmeka_facility_list",
    {
      description:
        "예약 가능한 회의실 또는 공용설비 목록을 조회한다. 일정 생성 시 facility_ids 에 넣을 facilityId 를 여기서 얻는다.",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        start_date: z.string().describe("이용 시작 일시 (KST 기준)"),
        end_date: z.string().describe("이용 종료 일시 (KST 기준)"),
        conference_room: z
          .boolean()
          .optional()
          .describe("true=회의실(기본), false=공용설비/장비"),
        category_id: z
          .string()
          .optional()
          .describe("공용설비 분류 ID (conference_room=false 일 때만)"),
      },
    },
    async ({ session_id, start_date, end_date, conference_room, category_id }) =>
      withClient(session_id, async (client) => {
        const res = await calendar.listFacilities(client, start_date, end_date, {
          conferenceRoom: conference_room ?? true,
          categoryId: category_id,
        });
        // Slim the payload: expose the fields a caller needs to pick one.
        const facilities = (res.facilities ?? []).map((f: any) => ({
          facilityId: f.facilityId,
          facilityName: f.facilityName,
          categoryName: f.categoryName,
          categoryId: f.categoryId,
          capacity: f.capacity,
          description: f.description,
        }));
        return { ok: true, facilities, reserves: res.reserves ?? [] };
      }),
  );

  server.registerTool(
    "bizmeka_calendar_create",
    {
      description:
        "새 일정을 등록한다. 현재 사용자가 참석자로 자동 추가된다. 회의실/설비를 " +
        "facility_ids 로 함께 예약할 수 있다. 주의: 실제로 캘린더에 일정이 생성되는 " +
        "부작용이 있다. 반환은 { schedule_id }.",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        ...scheduleFields,
      },
    },
    async ({
      session_id,
      title,
      start_date,
      end_date,
      contents,
      place,
      wholeday,
      category_id,
      is_public,
      alarm_minutes,
      facility_ids,
    }) =>
      withClient(session_id, async (client) => {
        const facilities = await resolveFacilities(
          client,
          facility_ids,
          start_date,
          end_date,
        );
        const { scheduleId } = await calendar.createSchedule(client, {
          title,
          startDate: start_date,
          endDate: end_date,
          contents,
          place,
          wholeday,
          categoryId: category_id,
          schedulePublic: is_public,
          alarms: toAlarms(alarm_minutes),
          facilities,
        });
        return { ok: true, schedule_id: scheduleId };
      }),
  );

  server.registerTool(
    "bizmeka_calendar_update",
    {
      description:
        "기존 일정을 수정한다. 모든 필드를 원하는 최종 상태로 전달한다 (부분 수정이 " +
        "아니라 전체 덮어쓰기). 시간만 옮기려면 bizmeka_calendar_move 를 쓰라.",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        schedule_id: z.string().describe("수정할 일정 ID"),
        ...scheduleFields,
      },
    },
    async ({
      session_id,
      schedule_id,
      title,
      start_date,
      end_date,
      contents,
      place,
      wholeday,
      category_id,
      is_public,
      alarm_minutes,
      facility_ids,
    }) =>
      withClient(session_id, async (client) => {
        const facilities = await resolveFacilities(
          client,
          facility_ids,
          start_date,
          end_date,
        );
        return {
          ok: true,
          result: await calendar.updateSchedule(client, schedule_id, {
            title,
            startDate: start_date,
            endDate: end_date,
            contents,
            place,
            wholeday,
            categoryId: category_id,
            schedulePublic: is_public,
            alarms: toAlarms(alarm_minutes),
            facilities,
          }),
        };
      }),
  );

  server.registerTool(
    "bizmeka_calendar_move",
    {
      description:
        "일정의 시간(시작/종료)만 변경한다. 제목·내용 등 나머지는 그대로 둔다.",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        schedule_id: z.string().describe("일정 ID"),
        start_date: z.string().describe("새 시작 일시"),
        end_date: z.string().describe("새 종료 일시"),
        wholeday: z.boolean().optional().describe("종일 여부"),
      },
    },
    async ({ session_id, schedule_id, start_date, end_date, wholeday }) =>
      withClient(session_id, async (client) => ({
        ok: true,
        result: await calendar.moveScheduleTime(
          client,
          schedule_id,
          start_date,
          end_date,
          wholeday ?? false,
        ),
      })),
  );

  server.registerTool(
    "bizmeka_calendar_delete",
    {
      description:
        "일정을 삭제한다. 주의: 실제로 캘린더에서 일정이 삭제되는 부작용이 있다.",
      inputSchema: {
        session_id: z.string().describe("로그인된 세션 ID"),
        schedule_id: z.string().describe("삭제할 일정 ID"),
      },
    },
    async ({ session_id, schedule_id }) =>
      withClient(session_id, async (client) => ({
        ok: true,
        result: await calendar.deleteSchedule(client, schedule_id),
      })),
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport bootstrap
// ---------------------------------------------------------------------------
async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport keeps the process alive until stdin closes.
}

/** Is this POST body an `initialize` request? (no session yet) */
function isInitializeRequest(body: unknown): boolean {
  const check = (m: any) => m && typeof m === "object" && m.method === "initialize";
  return Array.isArray(body) ? body.some(check) : check(body);
}

function runHttp(): void {
  const host = process.env.MCP_HOST ?? "0.0.0.0";
  const port = Number(process.env.MCP_PORT ?? "8000");

  // Stateful: one transport (+ MCP server) per MCP session, keyed by the
  // session id the SDK generates on initialize. The client echoes that id in
  // the `mcp-session-id` header on every subsequent request. Login state also
  // lives in `store` (process-global) and is shared across all sessions.
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  Bun.serve({
    hostname: host,
    port,
    idleTimeout: 120,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response("ok", { status: 200 });
      }
      if (url.pathname !== "/mcp" && url.pathname !== "/mcp/") {
        return new Response("Not Found", { status: 404 });
      }

      const sessionId = req.headers.get("mcp-session-id") ?? undefined;

      // Existing session: route to its transport.
      if (sessionId && transports.has(sessionId)) {
        return transports.get(sessionId)!.handleRequest(req);
      }

      // No session id: only an initialize POST may open one.
      if (req.method !== "POST") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no valid session ID" },
            id: null,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Parse body once so we can both validate and hand it to the transport.
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }
      if (!isInitializeRequest(body)) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: server not initialized" },
            id: null,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
        onsessionclosed: (sid) => {
          transports.delete(sid);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const server = buildServer();
      await server.connect(transport);
      return transport.handleRequest(req, { parsedBody: body });
    },
  });
  // eslint-disable-next-line no-console
  console.error(
    `kt-bizmeka MCP (streamable-http) listening on ${host}:${port}/mcp`,
  );
}

function main(): void {
  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (
    transport === "http" ||
    transport === "streamable-http" ||
    transport === "streamable_http"
  ) {
    runHttp();
  } else {
    void runStdio();
  }
}

main();
