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
import { store } from "./session.ts";

const VERSION = "0.2.0";

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
        "KT 비즈메카 EZ 로그인을 시작한다. 아이디/비밀번호로 1차 인증을 수행하고, 등록된 " +
        "휴대폰으로 SMS 인증번호를 발송한다. 반환된 session_id 와 사용자가 받은 인증번호로 " +
        "bizmeka_verify_otp 를 호출해 로그인을 완료한다.",
      inputSchema: {
        username: z.string().describe("비즈메카 아이디"),
        password: z.string().describe("비즈메카 비밀번호"),
      },
    },
    async ({ username, password }) => {
      const client = new BizmekaClient(username, password);
      try {
        await client.submitCredentials(); // 1st factor (RSA + CSRF + login.do)
        await client.loadSecondStep();
        await client.sendSms(); // SMS to registered phone
      } catch (e) {
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
        sess.authenticated = true;
        sess.portalUrl = portalUrl;
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

  // ===================== WEBMAIL TOOLS ===================================
  server.registerTool(
    "bizmeka_mail_folders",
    {
      description: "웹메일 메일함(폴더) 목록과 메일 수를 조회한다.",
      inputSchema: { session_id: z.string().describe("로그인된 세션 ID") },
    },
    async ({ session_id }) => {
      const { client, err } = loggedInClient(session_id);
      if (err) return ok(err);
      try {
        return ok({ ok: true, folders: await mail.listFolders(client!) });
      } catch (e) {
        return ok(errPayload(e));
      }
    },
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
    async ({ session_id, folder, page }) => {
      const { client, err } = loggedInClient(session_id);
      if (err) return ok(err);
      try {
        const res = await mail.listMails(client!, folder ?? "inbox", page ?? 1);
        return ok({ ok: true, ...res });
      } catch (e) {
        return ok(errPayload(e));
      }
    },
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
    async ({ session_id, ukey, folder }) => {
      const { client, err } = loggedInClient(session_id);
      if (err) return ok(err);
      try {
        return ok({
          ok: true,
          mail: await mail.viewMail(client!, ukey, folder ?? "inbox"),
        });
      } catch (e) {
        return ok(errPayload(e));
      }
    },
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
    async ({ session_id, ukeys, seen }) => {
      const { client, err } = loggedInClient(session_id);
      if (err) return ok(err);
      try {
        const okRes = await mail.markRead(client!, ukeys, seen ?? true);
        return ok({ ok: okRes });
      } catch (e) {
        return ok(errPayload(e));
      }
    },
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
    async ({ session_id, to, subject, body, cc, bcc, reply_ukey, is_receipt }) => {
      const { client, err } = loggedInClient(session_id);
      if (err) return ok(err);
      try {
        const res = await mail.sendMail(client!, {
          to,
          subject,
          body,
          cc: cc ?? "",
          bcc: bcc ?? "",
          replyUkey: reply_ukey || undefined,
          isReceipt: is_receipt ?? false,
        });
        return ok({ ok: true, result: res });
      } catch (e) {
        return ok(errPayload(e));
      }
    },
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
    async ({ session_id, to, cc, bcc }) => {
      const { client, err } = loggedInClient(session_id);
      if (err) return ok(err);
      try {
        return ok({
          ok: true,
          result: await mail.checkReceivers(client!, to, cc ?? "", bcc ?? ""),
        });
      } catch (e) {
        return ok(errPayload(e));
      }
    },
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
    async ({ session_id, page, search }) => {
      const { client, err } = loggedInClient(session_id);
      if (err) return ok(err);
      try {
        const res = await mail.listReceipts(client!, page ?? 1, search ?? "");
        return ok({ ok: true, ...res });
      } catch (e) {
        return ok(errPayload(e));
      }
    },
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
    async ({ session_id, mail_key }) => {
      const { client, err } = loggedInClient(session_id);
      if (err) return ok(err);
      try {
        return ok({ ok: true, result: await mail.cancelSend(client!, mail_key) });
      } catch (e) {
        return ok(errPayload(e));
      }
    },
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
