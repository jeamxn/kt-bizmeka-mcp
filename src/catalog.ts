/**
 * Tool catalog + workflows powering the `bizmeka_man` tool.
 *
 * This is the single source of truth for "how do I use this MCP". When you add a
 * new tool to the server, register it here (CATALOG) and, if it's part of a
 * multi-step procedure, add/extend a WORKFLOW. The `bizmeka_man` tool reads from
 * here so clients can discover usage at runtime instead of guessing.
 */

export interface ToolDoc {
  summary: string;
  args: Record<string, string>;
  returns: string;
  notes: string;
}

export interface Workflow {
  title: string;
  steps: string[];
  description: string;
}

// ---------------------------------------------------------------------------
// Per-tool documentation. Key = exact tool name registered on the MCP server.
// ---------------------------------------------------------------------------
export const CATALOG: Record<string, ToolDoc> = {
  bizmeka_man: {
    summary: "이 MCP의 사용법/툴 목록/작업 흐름을 조회한다. 작업 전 항상 먼저 호출할 것.",
    args: { tool: "(선택) 특정 툴 이름. 비우면 전체 흐름과 툴 목록을 반환한다." },
    returns: "tool 미지정 시 워크플로우+툴 목록, 지정 시 해당 툴 상세 설명",
    notes: "새 작업을 시작하기 전에 bizmeka_man() 으로 흐름을 먼저 확인하라.",
  },
  bizmeka_login_start: {
    summary:
      "KT 비즈메카 EZ 로그인 시작 — 1차 인증(아이디/비번 RSA 암호화) 후 등록된 휴대폰으로 SMS 인증번호 발송.",
    args: { username: "비즈메카 아이디", password: "비즈메카 비밀번호" },
    returns: '{"ok": true, "session_id": "...", "message": "..."}',
    notes:
      "반환된 session_id 를 bizmeka_verify_otp 에 그대로 넘겨야 한다. 인증번호 유효시간 약 3분.",
  },
  bizmeka_verify_otp: {
    summary: "SMS 인증번호로 2차 인증 완료 + SAML SSO → 포털(ezportal) 진입.",
    args: {
      session_id: "bizmeka_login_start 가 반환한 세션 ID",
      cert_key: "휴대폰으로 받은 인증번호",
      remember_browser: "(선택) True 면 이후 이 세션 쿠키에서 2차 인증 생략",
    },
    returns: '{"ok": true, "logged_in": true, "portal_url": "..."}',
    notes: "login_start 이후 약 3분 안에 호출해야 한다. 세션 만료 시 처음부터 다시.",
  },
  bizmeka_session_status: {
    summary: "현재 세션의 로그인 상태 확인.",
    args: { session_id: "확인할 세션 ID" },
    returns:
      '{"ok": true, "authenticated": bool, "logged_in": bool, "portal_url": "..."}',
    notes: "로그인 완료 후 세션이 살아있는지 확인할 때 사용.",
  },
  bizmeka_mail_folders: {
    summary: "웹메일 메일함(폴더) 목록과 메일 수 조회.",
    args: { session_id: "로그인된 세션 ID" },
    returns:
      '{"ok": true, "folders": [{folderKey, folderName, mailcount, newmailcount}, ...]}',
    notes: "첫 메일 작업 전에 폴더 구조/안읽은 메일 수를 파악할 때 사용.",
  },
  bizmeka_mail_list: {
    summary: "메일함의 메일 목록 조회.",
    args: {
      session_id: "로그인된 세션 ID",
      folder: "inbox/sent/drafts/spam/trash/tome/forever/auth (기본 inbox)",
      page: "페이지 번호 (기본 1)",
    },
    returns:
      '{"ok": true, "maillist": [{ukey, subject, fromaddr, senddate, ...}], "page": {...}}',
    notes: "각 메일의 ukey 를 bizmeka_mail_view 에 넘겨 상세를 본다.",
  },
  bizmeka_mail_view: {
    summary: "특정 메일의 본문/발신자/수신자/첨부 정보 조회.",
    args: {
      session_id: "로그인된 세션 ID",
      ukey: "메일 고유키 (mail_list 결과)",
      folder: "메일이 속한 폴더 (기본 inbox)",
    },
    returns: '{"ok": true, "mail": {from, to, subject, content, date, attachList, ...}}',
    notes: "content 는 HTML. 답장하려면 이 ukey 를 mail_send 의 reply_ukey 로 넘긴다.",
  },
  bizmeka_mail_mark_read: {
    summary: "메일을 읽음/안읽음으로 표시.",
    args: {
      session_id: "로그인된 세션 ID",
      ukeys: "대상 메일 ukey 목록 (배열)",
      seen: "True=읽음, False=안읽음 (기본 True)",
    },
    returns: '{"ok": true}',
    notes: "",
  },
  bizmeka_mail_check_receivers: {
    summary: "발송 전 수신자 주소 유효성 검증.",
    args: { session_id: "세션 ID", to: "받는사람", cc: "참조", bcc: "숨은참조" },
    returns: '{"ok": true, "result": {...}}',
    notes: "mail_send 전에 호출해 주소 오류를 미리 거른다 (선택).",
  },
  bizmeka_mail_send: {
    summary: "메일 발송 (신규 또는 답장). 실제 발송되는 부작용 있음.",
    args: {
      session_id: "로그인된 세션 ID",
      to: '받는사람. \'"이름" <a@b.com>\' 또는 a@b.com, 여러명 콤마',
      subject: "제목",
      body: "본문 (HTML 허용)",
      cc: "참조 (선택)",
      bcc: "숨은참조 (선택)",
      reply_ukey: "답장일 경우 원본 메일 ukey (선택)",
      is_receipt: "수신확인 요청 여부 (기본 False)",
    },
    returns: '{"ok": true, "result": {...}}',
    notes: "실제 메일이 나간다. 호출 전 수신자/제목/본문을 사용자에게 확인받을 것.",
  },
  bizmeka_mail_receipts: {
    summary: "보낸 메일의 수신확인(읽음) 상태 목록 조회.",
    args: { session_id: "세션 ID", page: "페이지", search: "검색어(선택)" },
    returns:
      '{"ok": true, "receiptlist": [{mail_key, read_date, available_cancel, ...}]}',
    notes: "available_cancel=1 인 메일만 mail_cancel_send 로 취소 가능.",
  },
  bizmeka_mail_cancel_send: {
    summary: "아직 읽지 않은 보낸 메일의 발송 취소.",
    args: {
      session_id: "세션 ID",
      mail_key: "취소할 메일의 mail_key (receipts 결과)",
    },
    returns: '{"ok": true, "result": {...}}',
    notes: "수신자가 읽기 전에만 가능. mail_receipts 의 available_cancel 로 확인.",
  },
  bizmeka_calendar_list: {
    summary: "기간 내 내 일정 목록 조회 (그룹웨어 캘린더/플래너).",
    args: {
      session_id: "로그인된 세션 ID",
      start_date: "조회 시작일 (예: 2026-06-01)",
      end_date: "조회 종료일 (예: 2026-06-30)",
    },
    returns:
      '{"ok": true, "user": {userId, userName, teamName}, "events": [{scheduleId, title, startDate, endDate, ...}]}',
    notes:
      "startDate/endDate 는 epoch millis 로 변환되어 조회된다. events 의 각 scheduleId 를 다른 캘린더 툴에 넘긴다. user 는 현재 사용자 정보.",
  },
  bizmeka_calendar_search: {
    summary: "키워드로 일정 검색.",
    args: {
      session_id: "로그인된 세션 ID",
      start_date: "검색 시작일",
      end_date: "검색 종료일",
      keyword: "검색어 (선택)",
      search_fields: "검색 대상 필드 (기본 title, 예: 'title,contents')",
      page: "페이지 번호 (기본 1)",
    },
    returns: '{"ok": true, "result": {...}}',
    notes: "",
  },
  bizmeka_calendar_get: {
    summary: "일정 1건의 상세 조회.",
    args: {
      session_id: "로그인된 세션 ID",
      schedule_id: "일정 ID (list/search 결과의 scheduleId)",
    },
    returns:
      '{"ok": true, "schedule": {scheduleId, title, place, contents, startDate, endDate, wholeday, categoryName, registerName, ...}}',
    notes: "startDate/endDate 는 epoch millis.",
  },
  bizmeka_calendar_create: {
    summary: "새 일정 등록. 실제로 캘린더에 생성되는 부작용 있음.",
    args: {
      session_id: "로그인된 세션 ID",
      title: "일정 제목",
      start_date: "시작 일시 ('2026-07-02 14:00' = KST). 종일이면 날짜만",
      end_date: "종료 일시",
      contents: "내용/메모 (선택)",
      place: "장소 (선택)",
      wholeday: "종일 일정 여부 (선택)",
      category_id: "분류 ID (선택, 기본 '1'=업무)",
      is_public: "공개 일정 여부 (선택)",
      alarm_minutes: "미리 알림(분) 배열 (선택, 예: [30, 15])",
      facility_ids:
        "예약할 회의실/공용설비 facilityId 배열 (선택). bizmeka_facility_list 로 조회",
    },
    returns: '{"ok": true, "schedule_id": "..."}',
    notes:
      "현재 사용자가 참석자로 자동 추가된다. 시간은 기본 KST(한국 시간)로 해석된다 — '2026-07-02 14:00'은 한국시간 오후 2시. 다른 시간대면 ISO 오프셋(예: ...T14:00:00Z)을 명시한다. 회의실/설비 예약은 bizmeka_facility_list 로 facilityId 를 얻어 facility_ids 에 넣는다. 실제 생성되므로 사용자 확인 권장.",
  },
  bizmeka_facility_list: {
    summary: "예약 가능한 회의실/공용설비 목록 조회.",
    args: {
      session_id: "로그인된 세션 ID",
      start_date: "이용 시작 일시 (KST)",
      end_date: "이용 종료 일시 (KST)",
      conference_room: "true=회의실(기본), false=공용설비/장비",
      category_id: "공용설비 분류 ID (conference_room=false 일 때만, 선택)",
    },
    returns:
      '{"ok": true, "facilities": [{facilityId, facilityName, categoryName, capacity, ...}], "reserves": [...]}',
    notes:
      "여기서 얻은 facilityId 를 bizmeka_calendar_create/update 의 facility_ids 에 넣어 예약한다. reserves 는 해당 시간대 기존 예약 현황.",
  },
  bizmeka_calendar_update: {
    summary: "기존 일정 수정 (전체 덮어쓰기).",
    args: {
      session_id: "로그인된 세션 ID",
      schedule_id: "수정할 일정 ID",
      title: "일정 제목",
      start_date: "시작 일시",
      end_date: "종료 일시",
      contents: "내용 (선택)",
      place: "장소 (선택)",
      wholeday: "종일 여부 (선택)",
      category_id: "분류 ID (선택)",
      is_public: "공개 여부 (선택)",
      alarm_minutes: "미리 알림(분) 배열 (선택)",
    },
    returns: '{"ok": true, "result": {...}}',
    notes:
      "부분 수정이 아니라 전체 필드를 원하는 최종값으로 보낸다. 먼저 calendar_get 으로 현재 값을 읽어 병합하라. 시간만 옮길 거면 calendar_move 가 간편.",
  },
  bizmeka_calendar_move: {
    summary: "일정의 시작/종료 시간만 변경 (나머지 필드 유지).",
    args: {
      session_id: "로그인된 세션 ID",
      schedule_id: "일정 ID",
      start_date: "새 시작 일시",
      end_date: "새 종료 일시",
      wholeday: "종일 여부 (선택)",
    },
    returns: '{"ok": true, "result": {...}}',
    notes: "제목·내용·장소 등은 그대로 두고 시간만 바꾼다.",
  },
  bizmeka_calendar_delete: {
    summary: "일정 삭제. 실제로 삭제되는 부작용 있음.",
    args: {
      session_id: "로그인된 세션 ID",
      schedule_id: "삭제할 일정 ID",
    },
    returns: '{"ok": true, "result": {"success": "success"}}',
    notes: "되돌릴 수 없다. 호출 전 사용자 확인 권장.",
  },
};

// ---------------------------------------------------------------------------
// Multi-step procedures. Reference tools by name; bizmeka_man renders these.
// ---------------------------------------------------------------------------
export const WORKFLOWS: Record<string, Workflow> = {
  login: {
    title: "로그인 (2단계 인증)",
    description:
      "비즈메카는 SMS 2차 인증이 필수라, 사람이 인증번호를 읽는 단계가 끼어 " +
      "있다. 따라서 로그인은 두 번의 툴 호출로 나뉜다.",
    steps: [
      "bizmeka_login_start(username, password)  → SMS 발송, session_id 수령",
      "(사용자가 휴대폰 SMS 인증번호 확인)",
      "bizmeka_verify_otp(session_id, cert_key) → 2차 인증 + SSO, 포털 진입",
      "bizmeka_session_status(session_id)       → (선택) 로그인 상태 확인",
    ],
  },
  read_mail: {
    title: "메일 읽기",
    description:
      "로그인 완료된 session_id 로 웹메일을 조회한다. 첫 메일 호출 시 자동으로 " +
      "웹메일 SSO 진입 + _csrf 토큰을 확보한다.",
    steps: [
      "bizmeka_mail_folders(session_id)              → 메일함/안읽은 수 확인",
      "bizmeka_mail_list(session_id, folder='inbox') → 메일 목록 + 각 ukey",
      "bizmeka_mail_view(session_id, ukey)           → 본문 상세",
      "bizmeka_mail_mark_read(session_id, [ukey])    → (선택) 읽음 처리",
    ],
  },
  send_mail: {
    title: "메일 발송 / 답장",
    description:
      "실제 메일이 나가므로, 발송 전 사용자 확인을 권장한다. 답장은 원본 ukey 를 " +
      "reply_ukey 로 넘긴다.",
    steps: [
      "(답장이면) bizmeka_mail_list/view 로 원본 ukey 확보",
      "bizmeka_mail_check_receivers(session_id, to)  → (선택) 주소 검증",
      "bizmeka_mail_send(session_id, to, subject, body, reply_ukey=...) → 발송",
      "bizmeka_mail_receipts(session_id)             → 수신확인 상태",
      "bizmeka_mail_cancel_send(session_id, mail_key) → (필요시) 발송취소",
    ],
  },
  calendar: {
    title: "일정 관리 (캘린더/플래너)",
    description:
      "그룹웨어(ezgroupware) 캘린더의 일정을 조회/등록/수정/삭제한다. 첫 호출 시 " +
      "자동으로 그룹웨어 SSO 진입 + CSRF 토큰을 확보한다. 생성/수정/삭제는 실제 " +
      "부작용이 있으니 사용자 확인을 권장한다.",
    steps: [
      "bizmeka_calendar_list(session_id, start_date, end_date) → 일정 목록 + scheduleId",
      "bizmeka_calendar_get(session_id, schedule_id)           → (선택) 상세 확인",
      "(회의실/설비 필요시) bizmeka_facility_list(session_id, start_date, end_date) → facilityId 확보",
      "bizmeka_calendar_create(session_id, title, start_date, end_date, facility_ids=[...]) → 등록",
      "bizmeka_calendar_update(session_id, schedule_id, ...)   → 수정 (전체 덮어쓰기)",
      "bizmeka_calendar_move(session_id, schedule_id, start_date, end_date) → 시간만 이동",
      "bizmeka_calendar_delete(session_id, schedule_id)        → 삭제",
    ],
  },
};

export function renderOverview(): Record<string, unknown> {
  const workflows: Record<string, unknown> = {};
  for (const [name, wf] of Object.entries(WORKFLOWS)) {
    workflows[name] = {
      title: wf.title,
      description: wf.description,
      steps: wf.steps,
    };
  }
  const tools: Record<string, string> = {};
  for (const [name, doc] of Object.entries(CATALOG)) {
    tools[name] = doc.summary;
  }
  return {
    about:
      "KT 비즈메카 EZ 자동화 MCP. 로그인 자동화를 시작으로 포털 기능 툴이 " +
      "점진적으로 추가된다. 작업 전 bizmeka_man(tool='...') 으로 각 툴 사용법을 확인하라.",
    workflows,
    tools,
    hint: "특정 툴 상세는 bizmeka_man(tool='bizmeka_login_start') 처럼 호출.",
  };
}

export function renderTool(tool: string): Record<string, unknown> {
  const doc = CATALOG[tool];
  if (!doc) {
    return {
      ok: false,
      error: `알 수 없는 툴: ${JSON.stringify(tool)}`,
      available_tools: Object.keys(CATALOG),
    };
  }
  return { ok: true, tool, ...doc };
}
