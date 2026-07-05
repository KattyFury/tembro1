// tempo-runner — engine gọi dịch vụ MPP, não Claude Haiku (trả qua Tempo).
// 1 lần chạy = 1 "lượt". Trên GitHub Actions, cron gọi file này nhiều lần trong ngày.
//
// MODE=mock  -> không gọi mạng, giả lập mọi thứ (miễn phí, test logic).
// MODE=live  -> gọi thật qua binary tempo-request (tốn USDC).
//
// State (log, strikes, spend) nằm trong ./state và được commit ngược về repo trên Actions.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ---------- Cấu hình ----------
const MODE = (process.env.MODE || "mock").toLowerCase();
const BOT_NAME = process.env.BOT_NAME || "tempo-runner";
const TEMPO_BIN = process.env.TEMPO_BIN || "tempo-request";
const PRIVATE_KEY = process.env.TEMPO_PRIVATE_KEY || "";        // rỗng = dùng ví đã login sẵn (VPS)
const ANTHROPIC_URL = "https://anthropic.mpp.tempo.xyz/v1/messages";
const HAIKU_MODEL = process.env.HAIKU_MODEL || "claude-haiku-4-5-20251001";
const HAIKU_MAX_SPEND = process.env.HAIKU_MAX_SPEND || "0.05"; // trần cứng mỗi lượt gọi não
const HAIKU_EST = Number(process.env.HAIKU_EST || "0.004");    // ước lượng chi phí 1 lượt gọi não
const DAILY_CAP = Number(process.env.DAILY_CAP || "0.16");     // ~$5/tháng ÷ 30
const STRIKE_LIMIT = Number(process.env.STRIKE_LIMIT || "2");  // fail mấy lần thì gạch
const MOCK_ITERS = Number(process.env.MOCK_ITERS || "1");      // mock chạy mấy lượt liên tiếp
const MOCK_FAIL = (process.env.MOCK_FAIL || "").split(",").filter(Boolean); // ép fail service id

const STATE_DIR = path.join(__dir, "state");
const LOG_FILE = path.join(STATE_DIR, "log.txt");
const STRIKES_FILE = path.join(STATE_DIR, "strikes.json");
const SPEND_FILE = path.join(STATE_DIR, "spend.json");

const services = JSON.parse(fs.readFileSync(path.join(__dir, "services.json"), "utf8"));

// ---------- Tiện ích ----------
function ensureState() { fs.mkdirSync(STATE_DIR, { recursive: true }); }

function readJSON(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; }
}
function writeJSON(f, obj) { fs.writeFileSync(f, JSON.stringify(obj, null, 2)); }

// Giờ + ngày theo múi Việt Nam (UTC+7)
function vnNow() { return new Date(Date.now() + 7 * 3600 * 1000); }
function vnDateStr() { return vnNow().toISOString().slice(0, 10); }
function vnStamp() {
  const d = vnNow();
  return d.toISOString().slice(0, 16).replace("T", " ");
}
function vnHour() { return vnNow().getUTCHours(); }

function withinActiveHours() {
  if (process.env.FORCE_ACTIVE === "1") return true; // bypass để test
  const h = vnHour(); return h >= 7 && h < 22;
}

function logLine(service, request, ok) {
  const line = `${vnStamp()} – ${service} – ${request} – ${ok ? "Thành công" : "Thất bại"}`;
  fs.appendFileSync(LOG_FILE, line + "\n");
  console.log("LOG> " + line);
}

// Gửi 1 dòng tóm tắt vào Telegram (nếu có TELEGRAM_TOKEN + CHAT_ID). Best-effort, dùng curl (đồng bộ).
function sendTelegram(text) {
  const tok = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) return;
  try {
    execFileSync("curl", ["-s", "-m", "15", "-X", "POST",
      `https://api.telegram.org/bot${tok}/sendMessage`,
      "--data-urlencode", `chat_id=${chat}`,
      "--data-urlencode", `text=${text}`], { stdio: "ignore" });
  } catch {}
}

// ---------- State: strikes & spend ----------
function loadStrikes() { return readJSON(STRIKES_FILE, {}); }
function saveStrikes(s) { writeJSON(STRIKES_FILE, s); }

function loadSpend() {
  const s = readJSON(SPEND_FILE, { date: vnDateStr(), spent: 0 });
  if (s.date !== vnDateStr()) return { date: vnDateStr(), spent: 0 }; // sang ngày mới -> reset
  return s;
}
function saveSpend(s) { writeJSON(SPEND_FILE, s); }

// Danh sách dịch vụ còn sống (chưa bị gạch)
function activeServices(strikes) {
  return services.filter((sv) => (strikes[sv.id]?.fails || 0) < STRIKE_LIMIT);
}

// ---------- Gọi tempo-request (live) ----------
function tempoRequest({ url, method = "POST", body, headers = {}, maxSpend }) {
  // Retry để chống lỗi 403/5xx chập chờn của payment-channel
  const args = ["-X", method, "--json", JSON.stringify(body),
    "-m", "120", "--retries", "3", "--retry-http", "403,408,429,500,502,503",
    "--retry-backoff", "1200", "--retry-jitter", "40", "--retry-after"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (maxSpend) args.push("--max-spend", String(maxSpend));
  if (PRIVATE_KEY) args.push("--private-key", PRIVATE_KEY);
  args.push(url);

  let stdout = "", ok = true, err = "";
  // TEMPO_BIN có thể là "tempo-request" hoặc dạng launcher "tempo request"
  const [bin, ...preArgs] = TEMPO_BIN.trim().split(/\s+/);
  try {
    stdout = execFileSync(bin, [...preArgs, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    ok = false;
    err = (e.stderr || e.message || "").toString();
    stdout = (e.stdout || "").toString();
  }

  // Coi 4xx/5xx problem trong body là thất bại
  if (ok && /"status"\s*:\s*(4|5)\d\d/.test(stdout) && /payment-required|error|problem/i.test(stdout)) ok = false;

  return { ok, stdout, err };
}

// ---------- Não Haiku ----------
function askBrain(active) {
  const menu = active.map((s) => `- id="${s.id}" | ${s.name} | ${s.bodyHint}`).join("\n");
  const sys = `You are an autonomous agent that keeps a set of paid web APIs warm by exercising them.
Choose exactly ONE service from the list and craft a valid, varied, realistic request body for it.
Return ONLY a compact JSON object, no prose, of the form:
{"serviceId":"<id>","body":{...},"note":"<short human summary of what you asked, <=8 words>"}`;
  const user = `Available services:\n${menu}\n\nPick one and produce the JSON now.`;

  if (MODE === "mock") {
    const s = active[Math.floor(Math.random() * active.length)];
    return { serviceId: s.id, body: s.mockBody, note: `mock: ${s.name}` };
  }

  const res = tempoRequest({
    url: ANTHROPIC_URL,
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    maxSpend: HAIKU_MAX_SPEND,
    body: {
      model: HAIKU_MODEL,
      max_tokens: 400,
      system: sys,
      messages: [{ role: "user", content: user }],
    },
  });
  if (!res.ok) throw new Error("Gọi não Haiku thất bại: " + (res.err || res.stdout).slice(0, 300));
  brainCost = HAIKU_EST; // gọi não thành công = có trả tiền

  // Bóc text từ response Anthropic rồi parse JSON bên trong
  let text = "";
  try {
    const j = JSON.parse(res.stdout);
    text = (j.content || []).map((c) => c.text || "").join("");
  } catch { text = res.stdout; }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Não không trả JSON hợp lệ: " + text.slice(0, 200));
  return JSON.parse(m[0]);
}

let brainCost = 0;

// ---------- Gọi 1 dịch vụ ----------
function callService(svc, body) {
  if (MODE === "mock") {
    const forcedFail = MOCK_FAIL.includes(svc.id);
    const ok = forcedFail ? false : Math.random() > 0.2; // 80% thành công
    return { ok, cost: ok ? svc.priceHint : 0 };
  }
  const res = tempoRequest({
    url: svc.url, method: svc.method, body,
    headers: { "content-type": "application/json" },
    maxSpend: svc.maxSpend,
  });
  return { ok: res.ok, cost: res.ok ? svc.priceHint : 0, detail: res.ok ? "" : (res.err || res.stdout).slice(0, 200) };
}

// ---------- Một lượt ----------
function runOnce() {
  if (!withinActiveHours()) {
    console.log(`[skip] Ngoài giờ hoạt động 7–22h VN (đang ${vnHour()}h VN).`);
    return false;
  }
  const spend = loadSpend();
  if (spend.spent >= DAILY_CAP) {
    console.log(`[skip] Đã chạm trần ngày $${spend.spent.toFixed(4)}/$${DAILY_CAP}. Nghỉ tới mai.`);
    return false;
  }
  const strikes = loadStrikes();
  const active = activeServices(strikes);
  if (active.length === 0) { console.log("[stop] Mọi dịch vụ đều đã bị gạch."); return false; }

  let decision;
  try { decision = askBrain(active); }
  catch (e) { console.log("[error] " + e.message); return false; }

  const svc = services.find((s) => s.id === decision.serviceId) || active[0];
  const note = (decision.note || "").toString().slice(0, 80);

  const r = callService(svc, decision.body);
  logLine(svc.name, note || JSON.stringify(decision.body).slice(0, 60), r.ok);

  // Cập nhật strikes
  if (r.ok) {
    if (strikes[svc.id]) strikes[svc.id].fails = 0; // thành công -> xoá strike
  } else {
    const s = strikes[svc.id] || { fails: 0 };
    s.fails += 1; s.lastError = r.detail || "";
    strikes[svc.id] = s;
    if (s.fails >= STRIKE_LIMIT) console.log(`[strike] "${svc.name}" fail ${s.fails} lần -> GẠCH khỏi danh sách.`);
  }
  saveStrikes(strikes);

  // Cập nhật chi tiêu
  const cost = (r.cost || 0) + (brainCost || 0);
  spend.spent = Math.round((spend.spent + cost) * 1e6) / 1e6;
  saveSpend(spend);
  console.log(`[spend] Lượt này ~$${cost.toFixed(5)} | Hôm nay $${spend.spent.toFixed(5)}/$${DAILY_CAP}`);
  sendTelegram(`🤖 ${BOT_NAME}\n${svc.name} — ${note}\n${r.ok ? "✅ Thành công" : "❌ Thất bại"} · ~$${cost.toFixed(4)} · hôm nay $${spend.spent.toFixed(3)}/$${DAILY_CAP}`);
  brainCost = 0;
  return true;
}

// ---------- Main ----------
function main() {
  ensureState();
  console.log(`=== tempo-runner | MODE=${MODE} | ${vnStamp()} VN ===`);
  const iters = MODE === "mock" ? MOCK_ITERS : 1;
  for (let i = 0; i < iters; i++) {
    if (iters > 1) console.log(`\n--- lượt ${i + 1}/${iters} ---`);
    const cont = runOnce();
    if (!cont && MODE === "mock") break;
  }
}

main();
