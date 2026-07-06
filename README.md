# tembro_bot — Bot airdrop Tempo tự động (chạy free trên GitHub Actions)

Bot tự động gọi các **dịch vụ trả phí trên Tempo (MPP)** để tạo hoạt động on-chain đều đặn — giữ ví "sống" phục vụ airdrop. Não là **Claude Haiku** (trả bằng USDC qua Tempo, **không cần tài khoản Anthropic**). Chạy hoàn toàn **miễn phí trên GitHub Actions**, tự báo **Telegram**, tự ghi log về repo.

Mỗi lượt: Haiku tự chọn 1 dịch vụ trong danh sách + tự soạn yêu cầu → gọi → ghi log → báo Telegram. Dịch vụ nào lỗi 2 lần thì tự bị gạch. Có trần chi tiêu/ngày để **không bao giờ vượt ngân sách** (mặc định ~$5/tháng).

**Số lượt/ngày là ngẫu nhiên**, không chạy đều đặn cứng nhắc: mỗi ngày bot tự random 5-10 lượt và random luôn giờ chạy trong khung 7h-22h VN — trông tự nhiên như người dùng thật, không phải máy chạy theo lịch cố định.

---

## 0. Docs gốc (để tự tra khi cần)

| Nội dung | Link |
|---|---|
| Cài Tempo CLI | `curl -fsSL https://tempo.xyz/install \| bash` |
| Index toàn bộ docs (LLM-readable) | https://tempo.xyz/developers/llms.txt |
| Tempo Wallet CLI | https://tempo.xyz/docs/cli/wallet |
| Machine Payments (agent) | https://tempo.xyz/docs/guide/machine-payments/agent |
| Skill setup wallet | https://tempo.xyz/SKILL.md |
| Danh bạ dịch vụ MPP (web) | https://mpp.dev/services |
| Danh bạ dịch vụ (JSON) | https://mpp.dev/api/services |
| Endpoint Claude qua Tempo | `https://anthropic.mpp.tempo.xyz/v1/messages` |
| Token **USDC.e** trên Tempo | `0x20c000000000000000000000b9537d11c60e8b50` |

> 💡 Bất kỳ trang docs nào cũng thêm `.md` vào URL để lấy bản markdown thô (vd `.../agent.md`).

---

## 1. Chuẩn bị (làm 1 lần trên máy bạn)

Cần: **Node.js**, **Git**. Rồi cài Tempo CLI:

```bash
curl -fsSL https://tempo.xyz/install | bash
export PATH="$HOME/.tempo/bin:$PATH"
tempo --version   # kiểm tra
```

### 1a. Có ~$5 USDC.e trên Tempo

Đăng nhập 1 ví Tempo rồi nạp tiền:

```bash
tempo wallet login          # đăng nhập bằng email/passkey
tempo wallet fund           # mở luồng nạp USDC (fiat/on-ramp)
tempo wallet whoami         # xem số dư (cần ~$5 USDC.e)
```

*(Hoặc bridge USDC từ chain khác sang Tempo qua Circle CCTP — xem docs Tempo.)*

### 1b. Tạo **khoá riêng cho bot** (đây là chỗ then chốt ⚠️)

**KHÔNG dùng credential login cho GitHub Actions** — key login nằm trong keyring máy + **có hạn dùng**, không đưa lên Actions được. Phải dùng **1 private key thô** (không bao giờ hết hạn):

```bash
# tạo cặp khoá bằng viem (cần: npm i viem, hoặc chạy trong 1 project có viem)
node -e 'import("viem/accounts").then(({generatePrivateKey,privateKeyToAccount})=>{const pk=generatePrivateKey();console.log("PRIVATE_KEY=",pk);console.log("ADDRESS=",privateKeyToAccount(pk).address)})'
```

Lưu lại `PRIVATE_KEY` (bí mật!) và `ADDRESS` (địa chỉ công khai).

### 1c. Chuyển tiền sang khoá bot

```bash
# tempo wallet transfer <số tiền> <token USDC.e> <ADDRESS khoá bot>
tempo wallet transfer 5 0x20c000000000000000000000b9537d11c60e8b50 <ADDRESS>
```

> ⚠️ Khoá này là **"ví nóng"** — chỉ nạp vài $ (coi như cháy được). Không bao giờ commit `PRIVATE_KEY` ra code.

---

## 2. Dựng bot trên GitHub

1. **Fork** repo này (để **public** → GitHub Actions miễn phí không giới hạn phút).
2. Vào **Settings → Secrets and variables → Actions → New repository secret**, thêm:

   | Secret | Giá trị |
   |---|---|
   | `TEMPO_PRIVATE_KEY` | private key khoá bot (mục 1b) |
   | `TELEGRAM_TOKEN` | token bot Telegram của bạn (tạo từ @BotFather) |
   | `TELEGRAM_CHAT_ID` | chat id nhận thông báo |

3. *(Tuỳ chọn)* Tab **Variables** → thêm `DAILY_CAP` = `0.16` (~$5/tháng). Muốn tốn ít hơn thì để số nhỏ hơn.
4. Vào tab **Actions** → bật workflow.
5. Bấm **Run workflow** để chạy thử ngay (chạy tay thì bỏ qua khung giờ *và* bỏ qua plan ngẫu nhiên, chạy luôn). Hoặc chờ cron tự chạy trong khung **07:00–22:30 giờ VN**.

Xong! Mỗi lượt bot sẽ nhắn Telegram + cập nhật `state/log.txt` về repo.

### ⚠️ Nếu bạn (hoặc nhóm) chạy nhiều hơn 1 bot cùng lúc

Sửa **phút** trong dòng `cron` của `.github/workflows/run.yml` (mục 4 bên dưới) cho **mỗi bot một bộ số khác nhau**, đừng để tất cả dùng `*/15` hay `*/30` giống hệt nhau. Lý do: GitHub xử lý cron của rất nhiều repo cùng lúc và dễ nghẽn/rớt lịch nếu tất cả bot cùng gõ cửa đúng 1 mốc phút. Vài bộ gợi ý (mỗi người trong nhóm lấy 1 dòng khác nhau):

```
"3,18,33,48 0-15 * * *"
"8,23,38,53 0-15 * * *"
"13,28,43,58 0-15 * * *"
"1,16,31,46 0-15 * * *"
"6,21,36,51 0-15 * * *"
```

---

## 3. Test miễn phí trước khi tốn xu nào

```bash
# chạy giả lập 15 lượt, KHÔNG gọi mạng, KHÔNG mất tiền:
MODE=mock FORCE_ACTIVE=1 MOCK_ITERS=15 node engine.mjs
```

Xem log ra đúng format `Thời gian – Dịch vụ – Yêu cầu – Thành/Bại`, logic gạch dịch vụ + chặn ngân sách chạy đúng.

Muốn xem thử engine tự chọn giờ ngẫu nhiên trong ngày ra sao (không ép chạy ngay):

```bash
MODE=mock MOCK_ITERS=1 node engine.mjs
```

→ xem dòng `[plan] Ngày mới -> chọn N lượt ngẫu nhiên: ...` in ra, đó là các mốc giờ bot sẽ tự "bắn" hôm đó.

---

## 4. Tuỳ chỉnh

| Muốn gì | Sửa ở đâu |
|---|---|
| Thêm/bớt dịch vụ | `services.json` (mỗi dịch vụ: url, method, priceHint, bodyHint) |
| Ngân sách/ngày | Variable `DAILY_CAP` (mặc định $0.16) |
| Trần mỗi lượt gọi não | env `HAIKU_MAX_SPEND` (mặc định $0.05) |
| Số lần fail thì gạch dịch vụ | env `STRIKE_LIMIT` (mặc định 2) |
| Số lượt chạy/ngày (random) | env `MIN_DAILY_RUNS` / `MAX_DAILY_RUNS` (mặc định 5-10) |
| Khung giờ hoạt động trong ngày | sửa `ACTIVE_START_MIN` / `ACTIVE_END_MIN` trong `engine.mjs` (mặc định 7h-22h VN) |
| Tần suất cron "gõ cửa" | sửa `cron` trong `.github/workflows/run.yml` (giờ UTC = VN − 7) — gõ càng dày thì bot càng dễ bắt trúng đủ số mốc ngẫu nhiên trong ngày |

Tìm thêm dịch vụ rẻ: `tempo wallet services --search <từ khoá>` hoặc https://mpp.dev/services

---

## 5. Chi phí

Chủ yếu do **não Haiku** (tính theo token) + dịch vụ gọi. Thực đo: **~$0.009/lượt**. Với 5-10 lượt/ngày → **~$1.5-3/tháng**, và `DAILY_CAP=0.16` đảm bảo không bao giờ vượt trần dù có bung lượt nhiều hơn dự kiến.

---

## 6. Xử lý lỗi thường gặp

| Lỗi | Nguyên nhân / cách xử |
|---|---|
| `spawn sqlite3 ENOENT` | Thiếu sqlite3. Workflow đã tự cài; nếu chạy local: `apt install sqlite3` |
| `HTTP 403 Request not allowed` | Payment-channel chập chờn khi gọi dồn. Engine đã có `--retries` |
| `verification-failed` / đòi login lại | Bạn đang dùng **credential login** thay vì `--private-key`. Đổi sang khoá thô (mục 1b) |
| Run cứ `queued` mãi | Actions của repo đang bị tắt → Settings → Actions → cho phép |
| Cả ngày không thấy lượt nào chạy | Bình thường nếu ít may mắn — GitHub không đảm bảo cron chạy đúng lịch, có ngày bắt được ít mốc hơn 5-10 dự kiến. Xem `state/plan.json` để biết hôm đó dự tính giờ nào, so với `state/log.txt` xem đã bắt được mốc nào |

---

## 7. Cách hoạt động (kiến trúc)

```
GitHub Actions (cron gõ cửa mỗi ~15 phút, lệch phút riêng từng bot)
  → cài Tempo CLI + sqlite3
  → engine.mjs:
      Kiểm tra state/plan.json — hôm nay đã có kế hoạch 5-10 mốc giờ ngẫu nhiên chưa?
        Chưa có -> tự random N (5-10) mốc giờ trong 7h-22h VN, lưu lại.
      Đã tới 1 mốc trong plan chưa dùng?
        Chưa tới -> bỏ qua, không tốn tiền, không log.
        Tới rồi -> đánh dấu đã dùng, tiếp tục:
          Haiku (qua Tempo, --private-key) chọn 1 dịch vụ + soạn request
          → gọi dịch vụ (tempo request --private-key)
          → ghi state/log.txt, đếm chi tiêu (chặn DAILY_CAP), gạch dịch vụ fail 2 lần
          → gửi Telegram
  → commit state/ ngược về repo
```

State (`state/log.txt`, `spend.json`, `strikes.json`, `plan.json`) được commit về repo mỗi lượt vì Actions không nhớ gì giữa các lần chạy.

---

## 8. An toàn

- Private key nằm trong **GitHub Secret** — không bao giờ commit ra code. `.env` đã bị `.gitignore` chặn.
- Khoá bot = **ví nóng**, chỉ để vài $.
- Repo **public** để Actions free — nhưng **không có bí mật nào trong code**, chỉ ở Secrets.
- **Đừng bao giờ** nhúng token GitHub (PAT) thẳng vào URL remote git hay `git config --global url.insteadOf` — nếu máy bị lộ, token dùng được cho *mọi* repo. Nếu cần push tự động, dùng token scope hẹp (fine-grained, đúng 1-2 repo, có ngày hết hạn) và chỉ set trên remote của đúng repo đó.

---

## 9. Muốn tham gia / fork thêm bot?

1. Đọc từ mục 1 → làm đúng thứ tự: ví Tempo → khoá riêng → nạp tiền → fork repo → set Secrets → bật Actions.
2. Nếu bạn là người thứ 2, 3... trong nhóm dùng chung ý tưởng này, **nhớ đổi phút cron** (mục 2, phần cảnh báo) để không đụng lịch với bot của người khác.
3. Có vấn đề gì cứ hỏi trong nhóm — đừng tự ý đổi `DAILY_CAP` lên cao hoặc tắt `STRIKE_LIMIT`, dễ đốt tiền oan nếu 1 dịch vụ đang lỗi mà không hay.
