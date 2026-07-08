# tembro_bot — Bot airdrop Tempo tự động (chạy free trên GitHub Actions)

Bot tự động gọi các **dịch vụ trả phí trên Tempo (MPP)** để tạo hoạt động on-chain đều đặn — giữ ví "sống" phục vụ airdrop. Não là **OpenAI** (gọi thẳng, KHÔNG qua Tempo — không ăn vào ngân sách USDC). Chạy hoàn toàn **miễn phí trên GitHub Actions**, tự báo **Telegram**, tự ghi log về repo.

Mỗi lượt: não tự chọn 1 dịch vụ trong danh sách + tự soạn yêu cầu → gọi → ghi log → báo Telegram. Có **bộ nhớ chống lặp**: 2 dịch vụ vừa dùng gần nhất bị khoá tạm (ép 3 lượt liên tiếp luôn là 3 dịch vụ khác nhau — không chỉ chặn lặp y hệt 1 dịch vụ, vì kiểu ping-pong "Exa Search ↔ Exa Answer" vẫn né được rule yếu hơn), và không cho hỏi lại nguyên văn 1 câu đã hỏi — nếu não vẫn đề xuất trùng sau khi thử lại 1 lần, bot **tự bỏ lượt đó, không tốn tiền** (bug cũ: não stateless, không nhớ gì → cứ lặp mãi 1 câu hỏi "an toàn" như "Exa Search: quantum computing" cả ngày, đã sửa bằng cơ chế này). Dịch vụ nào lỗi 3 lần thì tự bị gạch. Có trần chi tiêu/ngày để **không bao giờ vượt ngân sách** (mặc định ~$5/tháng), và tự báo Telegram khi ví sắp cạn tiền.

**Số lượt/ngày là ngẫu nhiên, có thể là 0**, không chạy đều đặn cứng nhắc: mỗi ngày bot tự random 0-10 lượt. **Khung giờ hoạt động bắt buộc chọn 1 trong 2 nửa ngày (giờ VN): `0h-12h` hoặc `12h-24h`** — mỗi bot chỉ dùng đúng 1 khung, không còn dùng chung 1 khung 7h-22h cho tất cả bot nữa (để nhiều bot chạy song song trông tự nhiên hơn, không đồng loạt "thức dậy" cùng lúc).

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
| Lấy OpenAI API key | https://platform.openai.com/api-keys |
| Token **USDC.e** trên Tempo | `0x20c000000000000000000000b9537d11c60e8b50` |

> 💡 Bất kỳ trang docs nào cũng thêm `.md` vào URL để lấy bản markdown thô (vd `.../agent.md`).

---

## 1. Chuẩn bị (làm 1 lần trên máy bạn)

> 🖥️ **Lưu ý hệ điều hành:** Workflow trên GitHub Actions luôn chạy trên **`ubuntu-latest`** (đã cấu hình sẵn trong `run.yml`, bước cài sqlite3 dùng `apt-get` chỉ có trên Ubuntu/Debian — **đừng đổi sang `windows-latest`/`macos-latest`** kẻo hỏng bước cài).
> Máy cá nhân bạn dùng để test/setup cục bộ thì OS nào cũng được: `MODE=mock` (test miễn phí, mục 3) chạy thuần bằng Node nên Windows/macOS/Linux đều chạy ngon. Riêng lệnh cài Tempo CLI (`curl ... | bash`) và `MODE=live` là bash script — trên Windows cần **Git Bash** hoặc **WSL**, không chạy thẳng được trên CMD/PowerShell.

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

Lưu lại `PRIVATE_KEY` (bí mật!) và `ADDRESS` (địa chỉ công khai — dùng luôn ở bước 1c và làm `WALLET_ADDRESS` ở mục 2).

### 1c. Chuyển tiền sang khoá bot

```bash
# tempo wallet transfer <số tiền> <token USDC.e> <ADDRESS khoá bot>
tempo wallet transfer 5 0x20c000000000000000000000b9537d11c60e8b50 <ADDRESS>
```

> ⚠️ Khoá này là **"ví nóng"** — chỉ nạp vài $ (coi như cháy được). Không bao giờ commit `PRIVATE_KEY` ra code.

### 1d. Lấy OpenAI API key (não của bot)

Não giờ gọi thẳng OpenAI (không qua Tempo, không tốn USDC) — tạo 1 key ở https://platform.openai.com/api-keys, nạp vài $ credit (dùng model rẻ `gpt-4o-mini` nên tốn không đáng kể, xem mục 5).

---

## 2. Dựng bot trên GitHub

1. **Fork** repo này (để **public** → GitHub Actions miễn phí không giới hạn phút).
2. Vào **Settings → Secrets and variables → Actions → New repository secret**, thêm:

   | Secret | Giá trị |
   |---|---|
   | `TEMPO_PRIVATE_KEY` | private key khoá bot (mục 1b) |
   | `OPENAI_API` | OpenAI API key (mục 1d) — **bắt buộc**, thiếu là bot lỗi ngay lượt đầu |
   | `TELEGRAM_TOKEN` | token bot Telegram của bạn (tạo từ @BotFather) |
   | `TELEGRAM_CHAT_ID` | chat id nhận thông báo |

3. Tab **Variables** → thêm:

   | Variable | Giá trị |
   |---|---|
   | `ACTIVE_WINDOW` | `0-12` hoặc `12-24` (giờ VN) — **bắt buộc**, mỗi bot chọn đúng 1 nửa. Chạy nhiều bot thì mỗi bot 1 khung khác nhau |
   | `WALLET_ADDRESS` | địa chỉ ví bot (mục 1b) — để bot tự check số dư on-chain và báo Telegram khi sắp cạn |
   | `DAILY_CAP` | `0.16` (~$5/tháng). Muốn tốn ít hơn thì để số nhỏ hơn *(tuỳ chọn)* |

4. Vào tab **Actions** → bật workflow.
5. Bấm **Run workflow** để chạy thử ngay (chạy tay thì bỏ qua khung giờ *và* bỏ qua plan ngẫu nhiên, chạy luôn). Hoặc chờ cron tự chạy trong nửa ngày bạn chọn ở `ACTIVE_WINDOW`.

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

Nhớ **đổi luôn `ACTIVE_WINDOW`** cho mỗi bot (`0-12` / `12-24`) — vừa lệch phút cron, vừa lệch nửa ngày hoạt động, càng đỡ trùng lịch nhau.

---

## 3. Test miễn phí trước khi tốn xu nào

```bash
# chạy giả lập 15 lượt, KHÔNG gọi mạng, KHÔNG mất tiền:
MODE=mock FORCE_ACTIVE=1 MOCK_ITERS=15 node engine.mjs
```

Xem log ra đúng format `Thời gian – Dịch vụ – Yêu cầu – Thành/Bại`, logic gạch dịch vụ + chặn ngân sách chạy đúng. Chạy đủ nhiều lượt bạn sẽ thấy dòng `[dedup]` (não đề xuất trùng câu cũ, bot tự hỏi lại) và `[diversity]`/việc dịch vụ tự đổi luân phiên — đó là cơ chế chống lặp-mãi-1-câu đang hoạt động.

Muốn xem thử engine tự chọn giờ ngẫu nhiên trong ngày ra sao (không ép chạy ngay):

```bash
MODE=mock MOCK_ITERS=1 node engine.mjs
```

→ xem dòng `[plan] Ngày mới -> chọn N lượt ngẫu nhiên: ...` in ra, đó là các mốc giờ bot sẽ tự "bắn" hôm đó (có thể là 0 mốc — bình thường).

---

## 4. Tuỳ chỉnh

| Muốn gì | Sửa ở đâu |
|---|---|
| Thêm/bớt dịch vụ | `services.json` (mỗi dịch vụ: url, method, priceHint, bodyHint) |
| Ngân sách/ngày | Variable `DAILY_CAP` (mặc định $0.16) |
| Mô hình não | env `OPENAI_MODEL` (mặc định `gpt-4o-mini`, rẻ + hỗ trợ JSON mode) |
| Số lần fail thì gạch dịch vụ | env `STRIKE_LIMIT` (mặc định **3**) |
| Số lượt chạy/ngày (random, có thể 0) | env `MIN_DAILY_RUNS` / `MAX_DAILY_RUNS` (mặc định **0**-10) |
| Khung giờ hoạt động trong ngày | Variable `ACTIVE_WINDOW` = `"0-12"` hoặc `"12-24"` (bắt buộc, không sửa trong code nữa) |
| Ngưỡng báo ví sắp cạn qua Telegram | env `LOW_BALANCE_USD` (mặc định $1) — cần có `WALLET_ADDRESS` mới check được |
| Tần suất cron "gõ cửa" | sửa `cron` trong `.github/workflows/run.yml` (giờ UTC = VN − 7) — gõ càng dày thì bot càng dễ bắt trúng đủ số mốc ngẫu nhiên trong ngày |

Tìm thêm dịch vụ rẻ: `tempo wallet services --search <từ khoá>` hoặc https://mpp.dev/services

> ⚠️ **Trước khi thêm 1 dịch vụ mới vào `services.json`: LUÔN test live thật 1 lượt trước khi để não tự gọi nó.** Không phải dịch vụ nào trong danh bạ cũng đang chạy tốt — lúc mở rộng danh sách (2026-07-08) đã gặp 4/6 dịch vụ mới thử (IPinfo, Holidays, Timezone, Exchange Rates, Codex) trả lỗi 500/502 từ chính hạ tầng của họ (vd Codex báo `ECONNREFUSED 127.0.0.1:4001` — bug phía họ, không phải do sai body). Đáng ngại hơn: có dấu hiệu ví vẫn bị trừ tiền dù call thất bại (thanh toán MPP có thể xảy ra *trước* khi biết upstream có chạy được hay không). Cách test an toàn:
> ```bash
> # gọi thẳng 1 endpoint bằng tempo-request, KHÔNG qua não, để xác nhận body đúng + dịch vụ còn sống:
> tempo-request -X POST --json '<body mẫu>' --private-key <key ví test> <url dịch vụ>
> ```
> Chỉ thêm vào `services.json` sau khi thấy response thành công thật.

---

## 5. Chi phí

**Dịch vụ MPP** (Exa, Firecrawl, fal, Codex...): thực đo **~$0.001-0.01/lượt** tuỳ dịch vụ não chọn. Với 0-10 lượt/ngày → tối đa **~$0.16/ngày (~$5/tháng)**, `DAILY_CAP` đảm bảo không bao giờ vượt trần dù có bung lượt nhiều hơn dự kiến.

**Não OpenAI** (`gpt-4o-mini`): billed **riêng qua tài khoản OpenAI của bạn**, không đụng ví USDC, không tính vào `DAILY_CAP`. Mỗi lượt chỉ vài trăm token → thực tế dưới $0.001/lượt, gần như không đáng kể so với chi phí dịch vụ.

---

## 6. Xử lý lỗi thường gặp

| Lỗi | Nguyên nhân / cách xử |
|---|---|
| `Thiếu OPENAI_API trong .env` | Chưa set secret `OPENAI_API` (mục 2) |
| `ACTIVE_WINDOW phải là "0-12" hoặc "12-24"` | Chưa set Variable `ACTIVE_WINDOW`, hoặc gõ sai giá trị |
| `[dedup] ... [skip] Vẫn trùng sau khi thử lại` | **Bình thường**, không phải lỗi — não đề xuất trùng câu đã hỏi 2 lần liên tiếp nên bot tự bỏ lượt để khỏi tốn tiền oan, lượt sau sẽ thử lại |
| `spawn sqlite3 ENOENT` | Thiếu sqlite3. Workflow đã tự cài; nếu chạy local: `apt install sqlite3` |
| `HTTP 403 Request not allowed` | Payment-channel chập chờn khi gọi dồn. Engine đã có `--retries` |
| `verification-failed` / đòi login lại | Bạn đang dùng **credential login** thay vì `--private-key`. Đổi sang khoá thô (mục 1b) |
| Run cứ `queued` mãi | Actions của repo đang bị tắt → Settings → Actions → cho phép |
| Cả ngày không thấy lượt nào chạy | Có thể bình thường — mỗi ngày random 0-10 lượt, có ngày rơi trúng 0. Xem `state/plan.json` để biết hôm đó dự tính mấy mốc, so với `state/log.txt` xem đã bắt được mốc nào |

---

## 7. Cách hoạt động (kiến trúc)

```
GitHub Actions (cron gõ cửa mỗi ~15 phút, lệch phút riêng từng bot)
  → cài Tempo CLI + sqlite3
  → engine.mjs:
      Kiểm tra state/plan.json — hôm nay đã có kế hoạch 0-10 mốc giờ ngẫu nhiên
      trong khung ACTIVE_WINDOW (0-12h hoặc 12-24h VN) chưa?
        Chưa có -> tự random N (0-10) mốc giờ, lưu lại.
      Đã tới 1 mốc trong plan chưa dùng?
        Chưa tới -> bỏ qua, không tốn tiền, không log.
        Tới rồi -> đánh dấu đã dùng, tiếp tục:
          Đọc state/history.json (dịch vụ + câu hỏi đã gọi trước đó)
            -> loại dịch vụ vừa bị gọi 2 lần liên tiếp khỏi danh sách được chọn
          OpenAI (gọi thẳng, không qua Tempo) chọn 1 dịch vụ + soạn request
            -> nếu request trùng nguyên văn 1 câu đã hỏi trước, hỏi lại 1 lần;
               vẫn trùng thì bỏ lượt, không gọi, không tốn tiền
          → gọi dịch vụ (tempo request --private-key)
          → ghi state/log.txt + state/history.json, đếm chi tiêu (chặn DAILY_CAP),
            gạch dịch vụ fail 3 lần
          → check số dư ví on-chain (USDC.e, đọc balanceOf qua RPC) — báo Telegram
            nếu dưới LOW_BALANCE_USD
          → gửi Telegram
  → commit state/ ngược về repo
```

State (`state/log.txt`, `spend.json`, `strikes.json`, `plan.json`, `history.json`) được commit về repo mỗi lượt vì Actions không nhớ gì giữa các lần chạy.

---

## 8. An toàn

- Private key + OpenAI key nằm trong **GitHub Secret** — không bao giờ commit ra code. `.env` đã bị `.gitignore` chặn.
- Khoá bot = **ví nóng**, chỉ để vài $.
- Repo **public** để Actions free — nhưng **không có bí mật nào trong code**, chỉ ở Secrets.
- **Đừng bao giờ** nhúng token GitHub (PAT) thẳng vào URL remote git hay `git config --global url.insteadOf` — nếu máy bị lộ, token dùng được cho *mọi* repo. Nếu cần push tự động, dùng token scope hẹp (fine-grained, đúng 1-2 repo, có ngày hết hạn) và chỉ set trên remote của đúng repo đó.

---

## 9. Muốn tham gia / fork thêm bot?

1. Đọc từ mục 1 → làm đúng thứ tự: ví Tempo → khoá riêng → nạp tiền → OpenAI key → fork repo → set Secrets/Variables → bật Actions.
2. Nếu bạn là người thứ 2, 3... trong nhóm dùng chung ý tưởng này, **nhớ đổi phút cron VÀ đổi `ACTIVE_WINDOW`** (mục 2, phần cảnh báo) để không đụng lịch với bot của người khác.
3. Có vấn đề gì cứ hỏi trong nhóm — đừng tự ý đổi `DAILY_CAP` lên cao hoặc tắt `STRIKE_LIMIT`, dễ đốt tiền oan nếu 1 dịch vụ đang lỗi mà không hay.
