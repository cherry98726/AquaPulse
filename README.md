# AquaPulse Vision Dashboard

一個可連接 Roboflow 訓練模型的即時 object detection dashboard。支援相機擷取、bounding box、物件總數、類別分布、信心分數與標註畫面下載。

API key 只保留在 Node.js 後端，不會傳到瀏覽器。

若香港 IP 無法連上 Roboflow hosted 端點，請使用本機 Roboflow Inference Server。
Dashboard 會把影像送到 `http://127.0.0.1:9001`，推論在本機跑，日常使用不需要 VPN。

## 需求

- Node.js 20 或更新版本
- Roboflow private API key，或已啟動並快取模型的本機 Inference Server
- 已部署的 Roboflow model ID，格式為 `project/version`

## 啟動

1. 複製 `.env.example` 為 `.env`。
2. 填入 Roboflow 設定：

```env
ROBOFLOW_API_KEY=your_private_api_key
ROBOFLOW_BROWSER_INFERENCE=false
ROBOFLOW_PUBLISHABLE_KEY=rf_your_publishable_key
ROBOFLOW_MODEL_ID=your-project/1
DASHBOARD_MODELS=lego=lego-ai/3,people=people-mvoqs/4
ROBOFLOW_API_URL=http://127.0.0.1:9001
PORT=3000
```

3. 啟動 dashboard：

```bash
npm start
```

Windows 也可以直接執行 `start-dashboard.cmd`。它會自動尋找本機 Node.js；未設定 `.env` 時仍可使用示範模式。

4. 開啟 dashboard：

- LEGO model: [http://127.0.0.1:3000/dashboards/lego](http://127.0.0.1:3000/dashboards/lego)
- People model: [http://127.0.0.1:3000/dashboards/people](http://127.0.0.1:3000/dashboards/people)
- 預設入口: [http://127.0.0.1:3000](http://127.0.0.1:3000)

專案沒有外部 npm dependencies，因此不需要先執行 `npm install`。

### Clone 到另一台電腦

如果是在另一台電腦 clone GitHub repo，請先把 `.env.example` 複製成 `.env` 並填好設定，然後直接執行：

```powershell
.\start-local.cmd
```

這個腳本會先確認 `http://127.0.0.1:9001` 的 Roboflow Inference Server 已啟動，再啟動 `http://127.0.0.1:3000` 的 dashboard。

如果瀏覽器顯示 `can't reach this page`，通常代表 `3000` 的 dashboard 還沒有啟動，或啟動視窗已經被關掉。請保持 `start-local.cmd` 開出的終端機視窗開著，再開：

- [http://127.0.0.1:3000/dashboards/lego](http://127.0.0.1:3000/dashboards/lego)
- [http://127.0.0.1:3000/dashboards/people](http://127.0.0.1:3000/dashboards/people)

如果還是不行，請不要只截瀏覽器畫面；請複製 `start-local.cmd` 視窗裡最後幾行錯誤訊息。最常見原因是 Node.js 未安裝、Node.js 版本低於 20、`PORT=3000` 已被其他程式佔用，或 Roboflow Inference Server 第一次下載模型尚未完成。

如果 Roboflow Inference Server 出現 Pydantic 錯誤，例如 `Field name "schema" ... shadows an attribute in parent "BaseModel"`，請在另一台電腦的專案資料夾執行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-inference-server.ps1 -ForceReinstall -Version 1.3.2
```

完成後再執行：

```powershell
.\start-local.cmd
```

## 使用方式

- **相機偵測**：按「啟動相機」並允許瀏覽器使用鏡頭後，系統會自動持續偵測。相機影像會持續播放，偵測框以透明圖層疊在即時畫面上。
- **停止偵測**：按「停止相機」便會同時停止鏡頭與推論。每次推論完成後才會處理下一個 frame，不會同時堆疊請求。
- **兩個 Dashboard**：`DASHBOARD_MODELS` 定義固定入口；目前 `lego` 使用 `lego-ai/3`，`people` 使用 `people-mvoqs/4`。左側也會顯示兩個 model 入口，可直接切換。
- **不開 VPN 模式**：設定 `ROBOFLOW_BROWSER_INFERENCE=false` 與 `ROBOFLOW_API_URL=http://127.0.0.1:9001`，並先啟動本機 Roboflow Inference Server。這樣瀏覽器不會再嘗試從 Roboflow 下載模型。
- **模型預熱**：server 啟動後會先送出合成畫面，減少第一幀延遲；本機 server 未啟動時會顯示本機連線錯誤。
- **瀏覽器本機推論**：只有在 Roboflow hosted 端點可連線時才建議開啟。將 `ROBOFLOW_BROWSER_INFERENCE=true` 並填入 Publishable Key 後，RF-DETR 會透過 `inferencejs` 下載至瀏覽器。
- **請求逾時**：推論超過約 20 秒會自動取消，不會一直停在分析畫面。

重要限制：如果本機 Inference Server 尚未下載或快取你的 Roboflow 模型，第一次設定模型仍需要能連上 Roboflow 的網路。模型快取完成後，日常推論可在本機進行，不需要 VPN。

Roboflow Serverless 在模型預熱後仍會有網路與雲端推論延遲。香港 IP 直連不穩時，不建議使用 `https://serverless.roboflow.com`。
- **介面示範**：未設定 API key 時，可按「載入介面示範」查看 dashboard 呈現方式。
- **切換模型**：直接修改左側 Model ID，不需重新啟動 server。

## 放到 GitHub / 另一部電腦

GitHub Pages 版本已放在 `docs/`。它不需要 clone，也不需要 Node.js 後端；老師可以直接開網頁。

GitHub Pages 設定方式：

1. 把 repo push 到 GitHub。
2. 到 GitHub repo 的 **Settings → Pages**。
3. Source 選 **Deploy from a branch**。
4. Branch 選 `main`，folder 選 `/docs`。
5. 開啟 GitHub Pages 給你的網址：

- LEGO model: `https://你的帳號.github.io/你的repo/dashboards/lego/`
- People model: `https://你的帳號.github.io/你的repo/dashboards/people/`

另一台電腦仍需要安裝並啟動 Roboflow Inference Server，因為 no-VPN 推論會呼叫「那台電腦自己的」`http://127.0.0.1:9001`。

不用 clone 的安裝方式：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-inference-server.ps1
```

如果對方沒有 repo 檔案，可以把 `install-inference-server.ps1` 的 GitHub Raw 連結給他，使用：

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/你的帳號/你的repo/main/install-inference-server.ps1 | iex"
```

限制：

- GitHub Pages 只負責顯示 dashboard，不會幫你執行模型。
- 每台要用自己相機偵測的電腦，都需要本機 Inference Server。
- 如果你想只在一台主機安裝 Inference Server，其他電腦都連那台主機，需要另外做 HTTPS/LAN 部署，否則瀏覽器相機權限會比較麻煩。

## 安全提醒

- 不要把 `.env` 提交到 Git。
- 若部署至公開網路，建議在 dashboard 前加入登入驗證與 rate limiting。
- 啟動相機後會持續執行偵測；按「停止相機」即停止處理影像。

## 測試

```bash
npm test
```
