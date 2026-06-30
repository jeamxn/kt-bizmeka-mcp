/**
 * Minimal HTML for the /authorize flow. Editorial / minimal tone: system font
 * stack, generous whitespace, a hairline divider, one accent color. No emoji,
 * no gradients, no glow, no cards-on-cards. These pages render in the browser
 * popup Claude opens when adding the connector.
 */

const BASE_CSS = `
  :root { --ink:#16181d; --sub:#6b7280; --line:#e5e7eb; --accent:#c8102e; --bg:#ffffff; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo",
      "Pretendard", "Malgun Gothic", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 380px; margin: 0 auto; padding: 72px 24px 48px; }
  .eyebrow { font-size: 12px; letter-spacing: .14em; text-transform: uppercase;
    color: var(--sub); margin: 0 0 10px; }
  h1 { font-size: 28px; font-weight: 700; letter-spacing: -.02em; margin: 0 0 6px; }
  .lede { color: var(--sub); font-size: 14px; line-height: 1.6; margin: 0 0 28px; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 0 0 28px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 0 0 7px; }
  input[type=text], input[type=password] {
    width: 100%; padding: 12px 14px; font-size: 15px; color: var(--ink);
    border: 1px solid var(--line); border-radius: 8px; outline: none;
    background: #fff; transition: border-color .15s;
  }
  input:focus { border-color: var(--ink); }
  .field { margin: 0 0 18px; }
  button {
    width: 100%; padding: 13px 16px; font-size: 15px; font-weight: 600;
    color: #fff; background: var(--ink); border: 0; border-radius: 8px;
    cursor: pointer; letter-spacing: .01em; margin-top: 6px;
  }
  button:hover { background: #000; }
  .err {
    background: #fdf2f3; border: 1px solid #f4c7cd; color: var(--accent);
    font-size: 13px; line-height: 1.5; padding: 11px 13px; border-radius: 8px;
    margin: 0 0 22px;
  }
  .foot { margin-top: 30px; font-size: 12px; color: var(--sub); line-height: 1.6; }
  .mono { font-variant-numeric: tabular-nums; }
`;

function shell(title: string, inner: string): string {
  return `<!doctype html><html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${BASE_CSS}</style>
</head><body><div class="wrap">${inner}</div></body></html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Step 1: bizmeka id / password. `flowId` carries the pending OAuth request. */
export function loginPage(flowId: string, error?: string): Response {
  const inner = `
    <p class="eyebrow">KT bizmeka</p>
    <h1>로그인</h1>
    <p class="lede">MCP 연결을 위해 비즈메카 계정으로 인증합니다. 아이디와 비밀번호를 입력하면 등록된 휴대폰으로 인증번호가 전송됩니다.</p>
    <hr>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <form method="post" action="/authorize">
      <input type="hidden" name="flow_id" value="${esc(flowId)}">
      <input type="hidden" name="stage" value="credentials">
      <div class="field">
        <label for="u">아이디</label>
        <input type="text" id="u" name="username" autocomplete="username"
          autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus>
      </div>
      <div class="field">
        <label for="p">비밀번호</label>
        <input type="password" id="p" name="password" autocomplete="current-password" required>
      </div>
      <button type="submit">인증번호 받기</button>
    </form>
    <p class="foot">인증된 기기는 안전하게 기억되어, 다음부터는 이 단계 없이 자동으로 연결됩니다.</p>`;
  return html(shell("KT bizmeka 로그인", inner));
}

/** Step 2: SMS OTP. */
export function otpPage(flowId: string, error?: string): Response {
  const inner = `
    <p class="eyebrow">KT bizmeka</p>
    <h1>인증번호 입력</h1>
    <p class="lede">등록된 휴대폰으로 전송된 6자리 인증번호를 입력하세요. 유효시간은 약 3분입니다.</p>
    <hr>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <form method="post" action="/authorize">
      <input type="hidden" name="flow_id" value="${esc(flowId)}">
      <input type="hidden" name="stage" value="otp">
      <div class="field">
        <label for="o">인증번호</label>
        <input type="text" id="o" name="otp" class="mono" inputmode="numeric"
          autocomplete="one-time-code" pattern="[0-9]*" maxlength="8" required autofocus>
      </div>
      <button type="submit">로그인 완료</button>
    </form>
    <p class="foot">번호가 오지 않으면 창을 닫고 다시 연결을 시도하세요.</p>`;
  return html(shell("인증번호 입력", inner));
}

/** A terminal error page (bad client, expired flow, etc.). */
export function errorPage(message: string, status = 400): Response {
  const inner = `
    <p class="eyebrow">KT bizmeka</p>
    <h1>연결할 수 없음</h1>
    <hr>
    <div class="err">${esc(message)}</div>
    <p class="foot">연결을 처음부터 다시 시도해 주세요.</p>`;
  return html(shell("오류", inner), status);
}

function html(markup: string, status = 200): Response {
  return new Response(markup, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
