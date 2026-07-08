// tempo-runner — engine gọi dịch vụ MPP, não OpenAI (không trả qua Tempo nữa, đỡ tốn USDC).
// 1 lần chạy = 1 "lượt". Trên VPS, daemon.mjs gọi file này lặp lại (jitter vài phút).
//
// MODE=mock  -> không gọi mạng, giả lập mọi thứ (miễn phí, test logic).
// MODE=live  -> gọi thật qua binary tempo-request (tốn USDC) + OpenAI API (tốn credit OpenAI riêng).
//
// State (log, strikes, spend, history dịch vụ/yêu cầu đã gọi) nằm trong ./state.

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
const DAILY_CAP = Number(process.env.DAILY_CAP || "0.16");     // trần USDC/ngày (~$5/tháng ÷ 30)
const STRIKE_LIMIT = Number(process.env.STRIKE_LIMIT || "3");  // fail mấy lần thì gạch khỏi danh sách
const MOCK_ITERS = Number(process.env.MOCK_ITERS || "1");      // mock chạy mấy lượt liên tiếp
const MOCK_FAIL = (process.env.MOCK_FAIL || "").split(",").filter(Boolean); // ép fail service id

// Não OpenAI (thay cho Haiku-qua-Tempo cũ) -- billed riêng qua tài khoản OpenAI, không đụng ví USDC.
const OPENAI_API = process.env.OPENAI_API || process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Check số dư ví on-chain (USDC.e là token TIP-20 -- vẫn đọc balanceOf chuẩn ERC-20 qua RPC).
const RPC_URL = process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz";
const TOKEN_ADDRESS = process.env.USDC_TOKEN_ADDRESS || "0x20c000000000000000000000b9537d11c60e8b50";
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "";
const LOW_BALANCE_USD = Number(process.env.LOW_BALANCE_USD || "1");

const STATE_DIR = path.join(__dir, "state");
const LOG_FILE = path.join(STATE_DIR, "log.txt");
const STRIKES_FILE = path.join(STATE_DIR, "strikes.json");
const SPEND_FILE = path.join(STATE_DIR, "spend.json");
const PLAN_FILE = path.join(STATE_DIR, "plan.json");
const HISTORY_FILE = path.join(STATE_DIR, "history.json");
const BALANCE_ALERT_FILE = path.join(STATE_DIR, "balance_alert.json");

// Khung giờ hoạt động: BẮT BUỘC mỗi bot chọn đúng 1 trong 2 nửa ngày (VN time), không dùng chung
// 1 khung nữa -- đặt ACTIVE_WINDOW="0-12" hoặc "12-24" trong .env của từng bot.
const ACTIVE_WINDOW = process.env.ACTIVE_WINDOW || "";
let ACTIVE_START_HOUR, ACTIVE_END_HOUR;
if (ACTIVE_WINDOW === "0-12") { ACTIVE_START_HOUR = 0; ACTIVE_END_HOUR = 12; }
else if (ACTIVE_WINDOW === "12-24") { ACTIVE_START_HOUR = 12; ACTIVE_END_HOUR = 24; }
else if (MODE === "mock") { ACTIVE_START_HOUR = 7; ACTIVE_END_HOUR = 22; } // test cục bộ, không ép buộc
else { throw new Error('ACTIVE_WINDOW phải là "0-12" hoặc "12-24" (đặt trong .env của bot này)'); }
const ACTIVE_START_MIN = ACTIVE_START_HOUR * 60;
const ACTIVE_END_MIN = ACTIVE_END_HOUR * 60;

const MIN_GAP_MIN = 45;            // 2 lượt cách nhau tối thiểu 45 phút
const MIN_DAILY_RUNS = Number(process.env.MIN_DAILY_RUNS || "0");   // 1 ngày có thể 0 lượt
const MAX_DAILY_RUNS = Number(process.env.MAX_DAILY_RUNS || "10");
const HISTORY_KEEP = 300;          // giữ tối đa 300 dòng lịch sử (đủ để chống trùng lâu dài)
const RECENT_CONTEXT = 20;         // số dòng gần nhất đưa vào prompt cho não tránh lặp

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
function vnMinuteOfDay() { const d = vnNow(); return d.getUTCHours() * 60 + d.getUTCMinutes(); }

function withinActiveHours() {
  if (process.env.FORCE_ACTIVE === "1") return true; // bypass để test
  const h = vnHour();
  return h >= ACTIVE_START_HOUR && h < ACTIVE_END_HOUR;
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

// ---------- State: bộ nhớ dịch vụ/yêu cầu đã gọi ----------
// Dùng để đảm bảo: (1) không lặp lại nguyên văn 1 yêu cầu đã hỏi, (2) không gọi cùng 1 dịch vụ
// quá 2 lần liên tiếp (ép tối thiểu ~1/3 số lượt phải đổi dịch vụ khác).
function loadHistory() { return readJSON(HISTORY_FILE, []); }
function saveHistory(h) { writeJSON(HISTORY_FILE, h.slice(-HISTORY_KEEP)); }
function normReq(s) { return (s || "").toString().trim().toLowerCase(); }
function isDuplicateRequest(history, requestText) {
  const norm = normReq(requestText);
  return history.some((h) => normReq(h.request) === norm);
}
function cooldownServiceId(history) {
  const n = history.length;
  if (n < 2) return null;
  const a = history[n - 1].serviceId, b = history[n - 2].serviceId;
  return a === b ? a : null;
}
function recentSummary(history) {
  return history.slice(-RECENT_CONTEXT).map((h) => `- ${h.service}: ${h.request}`).join("\n") || "(chưa có)";
}

// ---------- State: kế hoạch giờ chạy ngẫu nhiên trong ngày ----------
// Mỗi ngày tự chọn N lượt (MIN_DAILY_RUNS..MAX_DAILY_RUNS, có thể là 0) + N mốc giờ ngẫu nhiên
// (cách nhau tối thiểu MIN_GAP_MIN) trong khung ACTIVE_START_MIN..ACTIVE_END_MIN.
// Daemon có gọi engine bao nhiêu lần cũng chỉ thực sự "bắn" đúng lúc chạm 1 mốc trong plan.
function genTargets() {
  const n = MIN_DAILY_RUNS + Math.floor(Math.random() * (MAX_DAILY_RUNS - MIN_DAILY_RUNS + 1));
  if (n === 0) return [];
  const span = ACTIVE_END_MIN - ACTIVE_START_MIN;
  for (let attempt = 0; attempt < 30; attempt++) {
    const pts = Array.from({ length: n }, () => ACTIVE_START_MIN + Math.floor(Math.random() * span)).sort((a, b) => a - b);
    let okGap = true;
    for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] < MIN_GAP_MIN) { okGap = false; break; }
    if (okGap) return pts;
  }
  return Array.from({ length: n }, (_, i) => ACTIVE_START_MIN + Math.floor((i + 0.5) * span / n)); // fallback: rải đều
}

function loadPlan() {
  const today = vnDateStr();
  const p = readJSON(PLAN_FILE, null);
  if (p && p.date === today) return p;
  const fresh = { date: today, targets: genTargets(), done: [] };
  fresh.done = fresh.targets.map(() => false);
  writeJSON(PLAN_FILE, fresh);
  console.log(`[plan] Ngày mới -> chọn ${fresh.targets.length} lượt ngẫu nhiên: ${fresh.targets.map(fmtMin).join(", ") || "(0 lượt hôm nay)"} (giờ VN)`);
  return fresh;
}
function savePlan(p) { writeJSON(PLAN_FILE, p); }
function fmtMin(m) { return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }

// Có mốc nào trong plan đã tới giờ mà chưa chạy không? Nếu có, đánh dấu đã dùng và trả về true.
function claimDueSlot(plan) {
  const now = vnMinuteOfDay();
  for (let i = 0; i < plan.targets.length; i++) {
    if (!plan.done[i] && plan.targets[i] <= now) {
      plan.done[i] = true;
      savePlan(plan);
      return true;
    }
  }
  return false;
}

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

// ---------- Não (OpenAI, KHÔNG qua Tempo) ----------
// menu = danh sách dịch vụ được phép chọn (đã lọc strike + cooldown 2-lần-liên-tiếp).
// avoidHint = gợi ý thêm khi phải hỏi lại vì lượt trước bị trùng.
async function askBrain(menu, history, avoidHint) {
  const menuText = menu.map((s) => `- id="${s.id}" | ${s.name} | ${s.bodyHint}`).join("\n");
  const sys = `You are an autonomous agent that keeps a set of paid web APIs warm by exercising them with realistic, varied requests.
Rules:
- Choose exactly ONE service from the "Available services" list below.
- Never repeat a request that appears in "Recently used requests" — pick a genuinely different topic, query, or target every time.
- Return ONLY a compact JSON object, no prose, of the form:
{"serviceId":"<id>","body":{...},"note":"<short human summary of what you asked, <=8 words>"}`;
  const user = `Available services:\n${menuText}\n\nRecently used requests (do NOT repeat any of these):\n${recentSummary(history)}${avoidHint ? "\n\n" + avoidHint : ""}\n\nPick one and produce the JSON now.`;

  if (MODE === "mock") {
    const s = menu[Math.floor(Math.random() * menu.length)];
    return { serviceId: s.id, body: s.mockBody, note: `mock: ${s.name}` };
  }

  if (!OPENAI_API) throw new Error("Thiếu OPENAI_API trong .env");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      max_tokens: 300,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error("Gọi não OpenAI thất bại: " + JSON.stringify(json).slice(0, 300));

  const text = json?.choices?.[0]?.message?.content || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Não không trả JSON hợp lệ: " + text.slice(0, 200));
  return JSON.parse(m[0]);
}

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

// ---------- Check số dư ví, báo Telegram nếu sắp cạn ----------
async function fetchBalanceUSD(address) {
  const data = "0x70a08231000000000000000000000000" + address.replace(/^0x/, "").toLowerCase();
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: TOKEN_ADDRESS, data }, "latest"] }),
  });
  const json = await res.json();
  if (!json.result) throw new Error("eth_call lỗi: " + JSON.stringify(json).slice(0, 200));
  return Number(BigInt(json.result)) / 1e6; // TIP-20 decimals luôn là 6
}

async function checkBalance() {
  if (MODE !== "live" || !WALLET_ADDRESS) return;
  try {
    const bal = await fetchBalanceUSD(WALLET_ADDRESS);
    const alert = readJSON(BALANCE_ALERT_FILE, { alerted: false });
    console.log(`[balance] Ví còn ~$${bal.toFixed(3)} USDC.e`);
    if (bal <= LOW_BALANCE_USD && !alert.alerted) {
      sendTelegram(`⚠️ ${BOT_NAME}\nSố dư ví chỉ còn ~$${bal.toFixed(3)} USDC.e (dưới ngưỡng $${LOW_BALANCE_USD}). Cần nạp thêm.`);
      writeJSON(BALANCE_ALERT_FILE, { alerted: true });
    } else if (bal > LOW_BALANCE_USD && alert.alerted) {
      writeJSON(BALANCE_ALERT_FILE, { alerted: false });
    }
  } catch (e) {
    console.log("[balance] check thất bại: " + e.message);
  }
}

// ---------- Một lượt ----------
async function runOnce() {
  if (!withinActiveHours()) {
    console.log(`[skip] Ngoài khung giờ hoạt động ${ACTIVE_START_HOUR}h-${ACTIVE_END_HOUR}h VN (đang ${vnHour()}h VN).`);
    return false;
  }
  const spend = loadSpend();
  if (spend.spent >= DAILY_CAP) {
    console.log(`[skip] Đã chạm trần ngày $${spend.spent.toFixed(4)}/$${DAILY_CAP}. Nghỉ tới mai.`);
    return false;
  }
  const plan = loadPlan();
  if (process.env.FORCE_ACTIVE !== "1" && !claimDueSlot(plan)) {
    const left = plan.targets.filter((_, i) => !plan.done[i]);
    console.log(`[skip] Chưa tới mốc ngẫu nhiên nào trong plan hôm nay. Còn chờ: ${left.map(fmtMin).join(", ") || "(hết mốc)"}`);
    return false;
  }
  const strikes = loadStrikes();
  const active = activeServices(strikes);
  if (active.length === 0) { console.log("[stop] Mọi dịch vụ đều đã bị gạch."); return false; }

  const history = loadHistory();
  const cooldownId = cooldownServiceId(history);
  let menu = active.filter((s) => s.id !== cooldownId);
  if (menu.length === 0) {
    menu = active;
    if (cooldownId) console.log(`[diversity] Chỉ còn 1 dịch vụ khả dụng ("${cooldownId}"), bỏ qua rule không lặp 3 lần liên tiếp.`);
  }

  let decision;
  try { decision = await askBrain(menu, history); }
  catch (e) { console.log("[error] " + e.message); return false; }

  let svc = menu.find((s) => s.id === decision.serviceId) || menu[Math.floor(Math.random() * menu.length)];
  let requestText = (decision.note || "").toString().slice(0, 80) || JSON.stringify(decision.body).slice(0, 60);

  if (isDuplicateRequest(history, requestText)) {
    console.log(`[dedup] Yêu cầu trùng lịch sử, thử hỏi lại 1 lần: "${requestText}"`);
    try {
      decision = await askBrain(menu, history, `Your previous suggestion "${requestText}" was already used before — pick something genuinely different.`);
      svc = menu.find((s) => s.id === decision.serviceId) || menu[Math.floor(Math.random() * menu.length)];
      requestText = (decision.note || "").toString().slice(0, 80) || JSON.stringify(decision.body).slice(0, 60);
    } catch (e) { console.log("[error] retry: " + e.message); return false; }
    if (isDuplicateRequest(history, requestText)) {
      console.log(`[skip] Vẫn trùng sau khi thử lại -> bỏ lượt này để không tốn tiền.`);
      return false;
    }
  }

  const r = callService(svc, decision.body);
  logLine(svc.name, requestText, r.ok);

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

  // Ghi nhớ dịch vụ + yêu cầu đã gọi (chống trùng lần sau)
  history.push({ ts: vnStamp(), serviceId: svc.id, service: svc.name, request: requestText });
  saveHistory(history);

  // Cập nhật chi tiêu (chỉ tính chi phí dịch vụ -- não OpenAI billed riêng, không đụng ví USDC)
  const cost = r.cost || 0;
  spend.spent = Math.round((spend.spent + cost) * 1e6) / 1e6;
  saveSpend(spend);
  console.log(`[spend] Lượt này ~$${cost.toFixed(5)} | Hôm nay $${spend.spent.toFixed(5)}/$${DAILY_CAP}`);
  sendTelegram(`🤖 ${BOT_NAME}\n${svc.name} — ${requestText}\n${r.ok ? "✅ Thành công" : "❌ Thất bại"} · ~$${cost.toFixed(4)} · hôm nay $${spend.spent.toFixed(3)}/$${DAILY_CAP}`);

  await checkBalance();
  return true;
}

// ---------- Main ----------
async function main() {
  ensureState();
  console.log(`=== tempo-runner | MODE=${MODE} | khung ${ACTIVE_START_HOUR}h-${ACTIVE_END_HOUR}h VN | ${vnStamp()} VN ===`);
  const iters = MODE === "mock" ? MOCK_ITERS : 1;
  for (let i = 0; i < iters; i++) {
    if (iters > 1) console.log(`\n--- lượt ${i + 1}/${iters} ---`);
    const cont = await runOnce();
    if (!cont && MODE === "mock") break;
  }
}

main();
