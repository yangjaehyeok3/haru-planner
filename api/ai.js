// Vercel 서버리스 함수: 브라우저는 일정 데이터만 보내고, 프롬프트와 API 키는 서버에만 있습니다.
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // ANTHROPIC_API_KEY 환경 변수 사용
const MODEL = "claude-opus-5-5";

const clip = (v, n) => String(v ?? "").slice(0, n);
const isTime = v => /^\d{2}:\d{2}$/.test(String(v));

function planPrompt(b) {
  const events = (Array.isArray(b.events) ? b.events : []).slice(0, 40)
    .map(e => ({ title: clip(e.title, 60), start: clip(e.start, 5), end: clip(e.end, 5) }));
  const gaps = (Array.isArray(b.gaps) ? b.gaps : []).slice(0, 40)
    .filter(g => Array.isArray(g) && isTime(g[0]) && isTime(g[1]));
  const tasks = (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 40).map(t => ({
    id: clip(t.id, 20), title: clip(t.title, 80), minutes: Math.min(600, Math.max(5, +t.minutes || 30)),
    priority: [1, 2, 3].includes(+t.priority) ? +t.priority : 2, due: t.due ? clip(t.due, 10) : null,
  }));
  return `너는 대학생의 일정 관리 비서야. ${clip(b.date, 10)} (${clip(b.weekday, 1)}요일) 하루에 할 일을 시간표로 배치해 줘.
지금 시각: ${clip(b.now, 20) || "해당 없음(미래 날짜)"}
기상 예정: ${clip(b.wake, 5)}, 활동 종료: ${clip(b.dayEnd, 5)}
고정 일정(이 시간에는 배치 금지): ${JSON.stringify(events)}
배치 가능한 빈 시간대: ${JSON.stringify(gaps)}
할 일 목록(priority 1=높음): ${JSON.stringify(tasks)}
규칙:
- 반드시 빈 시간대 안에만 배치하고 블록끼리 겹치지 않게.
- 중요도 높고 마감이 가까운 일을 집중이 잘 되는 시간(오전·이른 오후)에 먼저.
- 90분 넘는 일은 쉬는 시간을 두고 나눠도 돼 (같은 id로 여러 블록).
- 블록 사이에 10분 이상 여유. 점심(12~13시)·저녁(18~19시)은 가능하면 비워 둬.
- 못 넣은 일은 unscheduled에 id로.
JSON만 답해. 다른 말은 쓰지 마:
{"blocks":[{"taskId":"id","start":"HH:MM","end":"HH:MM"}],"unscheduled":["id"],"tip":"이 하루에 대한 한두 문장 한국어 조언"}`;
}

function parsePrompt(b) {
  return `오늘은 ${clip(b.today, 10)} (${clip(b.weekday, 1)}요일), 지금은 ${clip(b.now, 5)}야.
아래 문장에서 일정 하나를 뽑아 줘. 날짜가 없으면 오늘, 끝나는 시간이 없으면 1시간짜리로. 오전/오후가 애매하면 상식적으로 판단해.
문장: """${clip(b.text, 300)}"""
JSON만 답해. 다른 말은 쓰지 마:
{"title":"짧은 제목","date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM"}`;
}

function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = text.indexOf("{"), z = text.lastIndexOf("}");
  if (a >= 0 && z > a) { try { return JSON.parse(text.slice(a, z + 1)); } catch {} }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받아요" }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(503).json({ error: "no_key" }); return; }
  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  const kind = body.kind;
  if (kind !== "plan" && kind !== "parse") { res.status(400).json({ error: "kind는 plan 또는 parse" }); return; }

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: kind === "plan" ? planPrompt(body) : parsePrompt(body) }],
    });
    if (response.stop_reason === "refusal") { res.status(422).json({ error: "refused" }); return; }
    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
    const data = extractJson(text);
    if (!data) { res.status(502).json({ error: "invalid_json" }); return; }
    res.status(200).json(data);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) res.status(429).json({ error: "rate_limited" });
    else if (e instanceof Anthropic.AuthenticationError) res.status(503).json({ error: "bad_key" });
    else if (e instanceof Anthropic.APIError) res.status(502).json({ error: "api_error" });
    else res.status(500).json({ error: "server_error" });
  }
}
