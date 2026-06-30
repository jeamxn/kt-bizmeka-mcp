/**
 * KT bizmeka groupware planner (ezgroupware.bizmeka.com) — schedule/calendar.
 *
 * Verified live against the server (create → detail → list → delete round-trip):
 *   - list     GET  /groupware/planner/calFeedMySchedule.do?startDate=&endDate=
 *                    (epoch millis) → { userInfo, events: [...] }
 *   - search   POST /groupware/planner/calFeedScheduleSearch.do  (form)
 *   - detail   GET  /groupware/planner/getScheduleAllData.do?scheduleId=
 *   - create   POST /groupware/planner/create.do          (JSON body)
 *   - update   POST /groupware/planner/updateSchedule.do  (JSON body)
 *   - moveTime POST /groupware/planner/calendar/updateScheduleTime.do (form)
 *   - delete   POST /groupware/planner/deleteSchedule.do  (form: scheduleId)
 *
 * Auth: ezgroupware uses OWASP CSRFGuard, NOT the Spring `_csrf` of webmail.
 * Every call sends `OWASP_CSRFTOKEN: <ajaxToken>, <pageToken>` +
 * `X-Requested-With: XMLHttpRequest, OWASP CSRFGuard Project`. The client
 * helpers (enterGroupware / groupwareAjaxToken / groupwareHeaders) handle this.
 *
 * Dates: the JSON create/update bodies use ISO-8601 UTC (e.g.
 * "2026-06-30T05:30:00.000Z"); the feed/detail return epoch millis.
 */

import { BizmekaClient, GROUPWARE_BASE } from "./client.ts";
import { BizmekaError } from "./errors.ts";

const PLANNER = `${GROUPWARE_BASE}/groupware/planner`;

/** Current user's planner identity, scraped from the schedule feed. */
export interface PlannerUser {
  userId: string;
  userName: string;
  teamName: string | null;
}

/**
 * Parse a flexible date input into an ISO-8601 UTC string.
 *
 * NAIVE inputs (no timezone) are interpreted as KST (Asia/Seoul, +09:00),
 * because this is a Korean groupware used by Korean users. So "2026-07-02 14:00"
 * means 14:00 KST and is sent to the server as "2026-07-02T05:00:00.000Z".
 * To override, pass an explicit offset/Z (e.g. "2026-07-02T14:00:00Z" or
 * "...+00:00"), an epoch number, or a Date.
 */
function toIso(d: string | number | Date): string {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "number") return new Date(d).toISOString();
  const s = d.trim();
  if (/^\d+$/.test(s)) return new Date(Number(s)).toISOString();

  // Already has an explicit timezone (Z or ±HH:MM / ±HHMM)? Trust it.
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) {
      throw new BizmekaError(`날짜 형식을 해석할 수 없습니다: ${JSON.stringify(d)}`);
    }
    return parsed.toISOString();
  }

  // Naive value → interpret as KST (+09:00).
  let norm = s.includes("T") ? s : s.replace(" ", "T");
  if (!norm.includes("T")) {
    norm = `${norm}T00:00:00`; // date-only → KST midnight
  } else if (/T\d{2}:\d{2}$/.test(norm)) {
    norm = `${norm}:00`; // add seconds
  } else if (/T\d{2}$/.test(norm)) {
    norm = `${norm}:00:00`;
  }
  const parsed = new Date(`${norm}+09:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BizmekaError(`날짜 형식을 해석할 수 없습니다: ${JSON.stringify(d)}`);
  }
  return parsed.toISOString();
}

/** Parse a date input into epoch millis (for the feed's start/end range). */
function toEpochMs(d: string | number | Date): number {
  return new Date(toIso(d)).getTime();
}

async function postForm(
  client: BizmekaClient,
  path: string,
  data: Record<string, string>,
): Promise<any> {
  const tok = await client.groupwareAjaxToken();
  const r = await client.http.post(`${PLANNER}${path}`, {
    headers: client.groupwareHeaders(tok),
    data,
  });
  if (r.status >= 400) {
    throw new BizmekaError(`${path} 응답 오류 (status=${r.status})`);
  }
  try {
    return JSON.parse(r.text);
  } catch {
    throw new BizmekaError(
      `${path} 응답을 JSON으로 파싱하지 못했습니다: ${r.text.slice(0, 200)}`,
    );
  }
}

async function postJsonBody(
  client: BizmekaClient,
  path: string,
  payload: unknown,
): Promise<any> {
  const tok = await client.groupwareAjaxToken();
  const r = await client.http.post(`${PLANNER}${path}`, {
    headers: client.groupwareHeaders(tok, true),
    body: JSON.stringify(payload),
  });
  if (r.status >= 400) {
    throw new BizmekaError(`${path} 응답 오류 (status=${r.status})`);
  }
  try {
    return JSON.parse(r.text);
  } catch {
    throw new BizmekaError(
      `${path} 응답을 JSON으로 파싱하지 못했습니다: ${r.text.slice(0, 200)}`,
    );
  }
}

async function getJson(
  client: BizmekaClient,
  path: string,
  params: Record<string, string | number> = {},
): Promise<any> {
  await client.requireGroupware();
  const tok = await client.groupwareAjaxToken();
  const r = await client.http.get(`${PLANNER}${path}`, {
    headers: client.groupwareHeaders(tok),
    params: { ...params, _: Date.now() },
  });
  if (r.status >= 400) {
    throw new BizmekaError(`${path} 응답 오류 (status=${r.status})`);
  }
  try {
    return JSON.parse(r.text);
  } catch {
    throw new BizmekaError(
      `${path} 응답을 JSON으로 파싱하지 못했습니다: ${r.text.slice(0, 200)}`,
    );
  }
}

/**
 * List schedules between two dates (inclusive of the day range you pass).
 * Returns { userInfo, events }. `userInfo` is the current user's planner
 * identity, also reused as the default participant for create().
 */
export async function listSchedules(
  client: BizmekaClient,
  startDate: string | number | Date,
  endDate: string | number | Date,
): Promise<{ user: PlannerUser; events: any[] }> {
  const out = await getJson(client, "/calFeedMySchedule.do", {
    startDate: toEpochMs(startDate),
    endDate: toEpochMs(endDate),
  });
  const ui = out.userInfo ?? {};
  return {
    user: {
      userId: ui.userId,
      userName: ui.userName,
      teamName: ui.teamName ?? null,
    },
    events: out.events ?? [],
  };
}

/** Full-text / filtered search across schedules. */
export async function searchSchedules(
  client: BizmekaClient,
  opts: {
    startDate: string | number | Date;
    endDate: string | number | Date;
    keyword?: string;
    searchFields?: string; // e.g. "title" | "title,contents"
    pageNumber?: number;
    pagePerRecord?: number;
  },
): Promise<any> {
  return postForm(client, "/calFeedScheduleSearch.do", {
    startDate: String(toEpochMs(opts.startDate)),
    endDate: String(toEpochMs(opts.endDate)),
    keyword: opts.keyword ?? "",
    searchFields: opts.searchFields ?? "title",
    targetType: "user",
    pageNumber: String(opts.pageNumber ?? 1),
    cateIds: "[]",
    pagePerRecord: String(opts.pagePerRecord ?? 20),
    companySchedule: "false",
    teamSchedule: "false",
    todoSchedule: "false",
  });
}

/** Fetch a single schedule's full data by id. */
export async function getSchedule(
  client: BizmekaClient,
  scheduleId: string,
): Promise<any> {
  return getJson(client, "/getScheduleAllData.do", { scheduleId });
}

export interface ScheduleInput {
  title: string;
  startDate: string | number | Date;
  endDate: string | number | Date;
  contents?: string;
  place?: string;
  wholeday?: boolean;
  categoryId?: string; // "1" = 업무 (default)
  schedulePublic?: boolean;
  /** Reminder alarms, e.g. [{type:"2",minutes:"30"}]. type 2=popup,3=mail (observed). */
  alarms?: Array<{ type: string; minutes: string }>;
  /**
   * Facility/resource reservations (회의실·공용설비). Pass the raw facility
   * objects returned by listFacilities(); create.do echoes them back verbatim.
   */
  facilities?: any[];
}

/** Build the create/update JSON body shared by both endpoints. */
function buildScheduleBody(
  user: PlannerUser,
  input: ScheduleInput,
  scheduleId = "",
): Record<string, unknown> {
  return {
    company: 0,
    workspaceId: "",
    mandatorId: "",
    ...(scheduleId ? { scheduleId } : {}),
    schedulePublic: input.schedulePublic ? 1 : 0,
    repeat: 0,
    registerType: 0,
    alarmRequest: input.alarms && input.alarms.length ? 1 : 0,
    sendmail: 0,
    sendmessage: 0,
    sendsms: 0,
    startDate: toIso(input.startDate),
    endDate: toIso(input.endDate),
    categoryId: input.categoryId ?? "1",
    title: input.title,
    place: input.place ?? "",
    contents: input.contents ?? "",
    wholeday: input.wholeday ? 1 : 0,
    attendanceRequest: 0,
    participantList: [
      {
        scheduleId: scheduleId || "",
        targetUserId: user.userId,
        targetUserName: user.userName,
        targetUserJobTitleName: "",
        targetUserTeamName: user.teamName ?? "",
        targetType: 1,
        sortOrder: 0,
        targetTenantId: "",
        targetTenantName: user.teamName ?? "",
      },
    ],
    alarmList: (input.alarms ?? []).map((a) => ({
      alarmType: a.type,
      alarmTime: a.minutes,
    })),
    recurrences: [],
    facilityList: input.facilities ?? [],
    fileLinkList: [],
  };
}

/**
 * Create a schedule. The current user (resolved from the feed) is added as the
 * sole participant. Returns { success, scheduleId }.
 */
export async function createSchedule(
  client: BizmekaClient,
  input: ScheduleInput,
): Promise<{ scheduleId: string; raw: any }> {
  // Resolve the current user's planner identity (also primes the session).
  const { user } = await listSchedules(
    client,
    Date.now(),
    Date.now() + 86_400_000,
  );
  if (!user.userId) {
    throw new BizmekaError("일정 생성 실패: 사용자 정보를 확인할 수 없습니다.");
  }
  const body = buildScheduleBody(user, input);
  const out = await postJsonBody(client, "/create.do", body);
  if (out.success !== "success" || !out.scheduleId) {
    throw new BizmekaError(
      `일정 생성 실패: ${JSON.stringify(out).slice(0, 200)}`,
    );
  }
  return { scheduleId: String(out.scheduleId), raw: out };
}

/**
 * Update an existing schedule. Pass the full desired state (same fields as
 * create); the current user is kept as participant. Returns the raw response.
 */
export async function updateSchedule(
  client: BizmekaClient,
  scheduleId: string,
  input: ScheduleInput,
): Promise<any> {
  const { user } = await listSchedules(
    client,
    Date.now(),
    Date.now() + 86_400_000,
  );
  const body = buildScheduleBody(user, input, scheduleId);
  const out = await postJsonBody(client, "/updateSchedule.do", body);
  if (out.success !== "success") {
    throw new BizmekaError(
      `일정 수정 실패: ${JSON.stringify(out).slice(0, 200)}`,
    );
  }
  return out;
}

/**
 * Move a schedule's time only (drag-and-drop equivalent) without touching the
 * rest of its fields. Dates are sent in the JS `toString()` form the browser
 * uses, e.g. "Tue Jun 30 2026 14:30:00 GMT+0900 (...)".
 */
export async function moveScheduleTime(
  client: BizmekaClient,
  scheduleId: string,
  startDate: string | number | Date,
  endDate: string | number | Date,
  wholeday = false,
): Promise<any> {
  const fmt = (d: string | number | Date) => new Date(toIso(d)).toString();
  return postForm(client, "/calendar/updateScheduleTime.do", {
    scheduleId,
    startDate: fmt(startDate),
    endDate: fmt(endDate),
    wholeday: wholeday ? "1" : "0",
  });
}

/** Delete a schedule by id. Returns { success }. */
export async function deleteSchedule(
  client: BizmekaClient,
  scheduleId: string,
): Promise<any> {
  const out = await postForm(client, "/deleteSchedule.do", { scheduleId });
  if (out.success !== "success") {
    throw new BizmekaError(
      `일정 삭제 실패: ${JSON.stringify(out).slice(0, 200)}`,
    );
  }
  return out;
}

// --------------------------------------------------------------------------
// Facilities / resources (회의실·공용설비)
// --------------------------------------------------------------------------
const FACILITY_BASE = `${GROUPWARE_BASE}/groupware/facility`;

/**
 * List facilities available for a time window, with their current reservations.
 * Verified-live endpoint: POST /groupware/facility/getFacilitiesAndReserves.do
 *
 * Two kinds:
 *   - conferenceRoom=true  → 회의실 (body: isConferenceRoom=true&...&scheduleId=)
 *   - conferenceRoom=false → 공용설비/equipment (adds categoryId, may be empty)
 *
 * Returns the raw facility objects. Pass the ones you want straight into
 * createSchedule({ facilities: [...] }) — create.do echoes them back verbatim.
 */
export async function listFacilities(
  client: BizmekaClient,
  startDate: string | number | Date,
  endDate: string | number | Date,
  opts: { conferenceRoom?: boolean; categoryId?: string } = {},
): Promise<any> {
  await client.requireGroupware();
  const tok = await client.groupwareAjaxToken();
  const conf = opts.conferenceRoom ?? true;
  const data: Record<string, string> = {
    startDate: String(toEpochMs(startDate)),
    endDate: String(toEpochMs(endDate)),
    isConferenceRoom: conf ? "true" : "false",
    scheduleId: "",
  };
  if (!conf) data.categoryId = opts.categoryId ?? "";

  const headers = client.groupwareHeaders(tok);
  // Referer must point at the facility popup, not the planner page.
  headers.Referer = `${FACILITY_BASE}/${conf ? "conferenceRoomPopup" : "facilityPopup"}.do`;
  const r = await client.http.post(
    `${FACILITY_BASE}/getFacilitiesAndReserves.do`,
    { headers, data },
  );
  if (r.status >= 400) {
    throw new BizmekaError(
      `getFacilitiesAndReserves.do 응답 오류 (status=${r.status})`,
    );
  }
  try {
    return JSON.parse(r.text);
  } catch {
    throw new BizmekaError(
      `설비 목록 응답을 JSON으로 파싱하지 못했습니다: ${r.text.slice(0, 200)}`,
    );
  }
}

