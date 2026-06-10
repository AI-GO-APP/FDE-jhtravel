# CLAUDE.md — 專案工作慣例

本檔給在這個專案工作的 Claude 看。**以下規則為硬性要求,務必遵守。**

專案:旅遊團控系統(後台)。Node.js 後端 + 原生前端,零外部依賴。
溝通一律用**繁體中文**。

---

## 1. 每次更新都要 commit

- 做完一個有意義的變更後,就 `git commit`(不要累積一堆改動不提交)。
- commit 訊息用繁體中文,簡述「改了什麼、為什麼」。
- commit 訊息結尾固定加:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## 2. GitHub 推送政策(哪些不上)

- 預設:commit 後 `git push` 到 `main`(會觸發自動部署,見下方)。
- **但有些檔案刻意不上 GitHub,推送前務必確認沒把它們一起送上去:**
  - `README.md`、`ARCHITECTURE.md` — 目前**刻意保留在本機、不放 GitHub**(內容待整理)。本機有檔、git 不追蹤。除非使用者明說「放回去」,否則不要 commit/push 這兩個檔。
  - `notes/`、`*.local.md` — 個人草稿,已被 `.gitignore` 忽略,本來就不會上。
  - `tour.db`、`*.log`、`node_modules/` — 執行產物,已被 `.gitignore` 忽略。
- **永遠不要用 `git add -A` 或 `git add .`**(會誤把上面那些「保留在本機」的檔案加回去 —— 這發生過)。改用**指定檔名**:
  ```
  git add db.js flows.js server.js public/index.html
  ```
- 若不確定某檔該不該上,先問使用者,不要擅自 push。

## 3. 測試:要更新或新增,並保留腳本

- 改了行為(schema、流程、API、種子)就要**對應更新測試**;新增功能要**補測試**。
- **測試腳本一律保留,不要刪除**(放在 `tests/` 資料夾)。
- push 之前先在本機跑過測試,全綠才推:
  ```
  node tests/seed-story.test.js     # 種子故事(步驟1~10,純讀取)
  node tests/flows.test.js          # 後台操作 + 流程 A/B/C/D
  ```
- 兩支測試各自會啟動子行程 server、跑完關閉;全過 exit 0。
- 種子資料若改動,記得同步更新 `seed-story.test.js` 的斷言。

---

## 常用指令

```powershell
node server.js                 # 啟動,開 http://localhost:3000(每次啟動重建乾淨 DB)
node tests/seed-story.test.js  # 跑種子故事測試
node tests/flows.test.js       # 跑流程測試
```

> Windows 注意:要刪 `tour.db` 或對資料夾改名前,先確認沒有 node 行程或檔案總管/編輯器占用。
> 用 curl 測中文 body 會因 shell 編碼變亂碼,測 API 請用 Node http client(測試腳本已如此)。

## 架構速覽

| 檔案 | 職責 |
| --- | --- |
| `db.js` | 資料表 schema + 種子資料(`freshDb()` 每次啟動重建)。種子故事=「王小明報名花蓮三日遊」 |
| `flows.js` | 商業邏輯(交易+鎖):建單扣庫存/防超賣、收款、取消還庫存、成團判定、開團、建商品、新增旅客 |
| `server.js` | `node:http` 伺服器 + API 路由 + 每 30 秒背景排程(逾期釋放、截止判定) |
| `public/index.html` | 側邊欄式後台單頁(團期/商品/報名/訂單/客戶/契約/收款/設定) |

- 寫入庫存/訂單狀態的邏輯**只放在 `flows.js`**,且包在交易(`BEGIN IMMEDIATE`)內。
- `server.js` 只負責收請求、組查詢、轉交 `flows`,本身不直接改庫存。

## 部署(自動)

- GitHub repo:`AI-GO-APP/FDE-jhtravel`(Public)。push 到 `main` → GitHub Actions 自動部署。
- 線上網址:**https://fde-jhtravel.staging.ai-go.app**
- workflow 用 inline 版(`.github/workflows/deploy-staging.yml`),直接用組織 secrets 連 VM,不依賴 private `.github` reusable workflow。
- 改 `*.md` 不會觸發部署(workflow 設了 `paths-ignore`)。
- 部署約 1~3 分鐘;可用 `gh run list --repo AI-GO-APP/FDE-jhtravel` 看狀態。
- 線上 DB 每次重新部署/重啟會重建為種子資料(demo 用,資料不持久化)。
