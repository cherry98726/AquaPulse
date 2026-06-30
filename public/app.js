import { InferenceEngine } from "/vendor/inference.es.js?v=1.2.3";

const CLIENT_TIMEOUT_MS = 22_000;
const LOCAL_MODEL_LOAD_TIMEOUT_MS = 120_000;
const LOCAL_MODEL_SIZE = 384;

const elements = {
  analysisIndicator: document.querySelector("#analysisIndicator"),
  analysisLabel: document.querySelector("#analysisLabel"),
  averageConfidence: document.querySelector("#averageConfidence"),
  badgeCount: document.querySelector("#badgeCount"),
  cameraButton: document.querySelector("#cameraButton"),
  cameraFeed: document.querySelector("#cameraFeed"),
  cameraVideo: document.querySelector("#cameraVideo"),
  classCount: document.querySelector("#classCount"),
  classList: document.querySelector("#classList"),
  clock: document.querySelector("#clock"),
  confidence: document.querySelector("#confidence"),
  confidenceHint: document.querySelector("#confidenceHint"),
  confidenceValue: document.querySelector("#confidenceValue"),
  connectionDot: document.querySelector("#connectionDot"),
  connectionLabel: document.querySelector("#connectionLabel"),
  countDelta: document.querySelector("#countDelta"),
  demoButton: document.querySelector("#demoButton"),
  detectionCanvas: document.querySelector("#detectionCanvas"),
  detectionTable: document.querySelector("#detectionTable"),
  downloadButton: document.querySelector("#downloadButton"),
  emptyState: document.querySelector("#emptyState"),
  heroDescription: document.querySelector("#heroDescription"),
  heroTitle: document.querySelector("#heroTitle"),
  inferenceTime: document.querySelector("#inferenceTime"),
  inferenceHint: document.querySelector("#inferenceHint"),
  insightCount: document.querySelector("#insightCount"),
  modelId: document.querySelector("#modelId"),
  modelPresets: document.querySelector("#modelPresets"),
  objectBadge: document.querySelector("#objectBadge"),
  resetButton: document.querySelector("#resetButton"),
  runStatus: document.querySelector("#runStatus"),
  setupNote: document.querySelector("#setupNote"),
  tableCount: document.querySelector("#tableCount"),
  toast: document.querySelector("#toast"),
  totalCount: document.querySelector("#totalCount"),
  viewerTitle: document.querySelector("#viewerTitle"),
};

const state = {
  configured: false,
  dashboardKey: dashboardKeyFromLocation(),
  dashboardName: "Default",
  dashboards: [],
  detectionFrame: null,
  image: null,
  inferenceTarget: "hosted",
  isRunning: false,
  localEngine: null,
  localLoadingElapsedSeconds: 0,
  localInferenceStatus: "disabled",
  localLoadingClock: null,
  localLoadingPromise: null,
  localLoadingStartedAt: null,
  localModelId: "",
  localWorkerId: null,
  predictions: [],
  publishableKey: "",
  requestController: null,
  stream: null,
  viewMode: "empty",
  warmupError: "",
  warmupStatus: "idle",
};

const palette = [
  "#35e2c1",
  "#65aef7",
  "#ffbd66",
  "#ff7890",
  "#b58cff",
  "#73df76",
  "#e493ff",
];

initialize();

async function initialize() {
  bindEvents();
  new ResizeObserver(positionMediaLayer).observe(elements.cameraFeed);
  updateClock();
  setInterval(updateClock, 1000);
  updateConfidence();

  try {
    const response = await fetch(apiUrl("/api/config"), { cache: "no-store" });
    const config = await response.json();
    state.configured = Boolean(config.configured);
    state.dashboardKey = config.dashboard?.key || state.dashboardKey;
    state.dashboardName = config.dashboard?.label || state.dashboardName;
    state.dashboards = Array.isArray(config.dashboards) ? config.dashboards : [];
    state.inferenceTarget = config.inferenceTarget || "hosted";
    state.publishableKey = config.publishableKey || "";
    state.localInferenceStatus = state.publishableKey ? "loading" : "disabled";
    state.warmupError = config.warmupError || "";
    state.warmupStatus = config.warmupStatus || "idle";
    elements.modelId.value = config.defaultModelId || "";
    renderDashboardIdentity(config.dashboard);
    renderModelPresets();
    updateConnectionState();
    if (state.publishableKey) {
      void ensureLocalWorker();
    } else if (state.configured) {
      warmUpModel();
    }
  } catch {
    elements.connectionLabel.textContent = "無法讀取伺服器設定";
    showToast("無法連線到本機 dashboard server。", true);
  }
}

function dashboardKeyFromLocation() {
  const pathMatch = window.location.pathname.match(/^\/dashboards\/([^/]+)/);
  return new URLSearchParams(window.location.search).get("dashboard") || pathMatch?.[1] || "";
}

function apiUrl(path) {
  const url = new URL(path, window.location.origin);
  if (state.dashboardKey) {
    url.searchParams.set("dashboard", state.dashboardKey);
  }
  return url.toString();
}

function renderDashboardIdentity(dashboard) {
  if (!dashboard?.label || !dashboard?.modelId) {
    return;
  }
  document.title = `${dashboard.label} Detection | AquaPulse`;
  elements.heroTitle.textContent = `${dashboard.label} Detection Dashboard`;
  elements.heroDescription.textContent = `目前使用 ${dashboard.modelId}，啟動相機後會自動持續偵測這個模型訓練的物件。`;
}

function renderModelPresets() {
  if (!state.dashboards.length) {
    elements.modelPresets.hidden = true;
    elements.modelPresets.innerHTML = "";
    return;
  }

  elements.modelPresets.hidden = false;
  elements.modelPresets.innerHTML = state.dashboards
    .map((dashboard) => {
      const href = `/dashboards/${encodeURIComponent(dashboard.key)}`;
      const active = dashboard.key === state.dashboardKey;
      return `<a class="${active ? "active" : ""}" href="${href}">
        <strong>${escapeHtml(dashboard.label)}</strong>
        <span>${escapeHtml(dashboard.modelId)}</span>
      </a>`;
    })
    .join("");
}

function bindEvents() {
  elements.confidence.addEventListener("input", updateConfidence);
  elements.modelId.addEventListener("change", resetLocalWorker);
  elements.cameraButton.addEventListener("click", toggleCamera);
  elements.demoButton.addEventListener("click", loadDemo);
  elements.resetButton.addEventListener("click", resetDashboard);
  elements.downloadButton.addEventListener("click", downloadAnnotatedImage);
  window.addEventListener("beforeunload", stopCamera);
}

function updateConnectionState() {
  const localAvailable = Boolean(state.publishableKey);
  elements.connectionDot.classList.toggle(
    "connected",
    state.configured || localAvailable,
  );
  elements.connectionLabel.textContent = localAvailable
    ? state.localInferenceStatus === "loading"
      ? "瀏覽器本機模型載入中"
      : state.localInferenceStatus === "ready"
        ? "瀏覽器本機推論已就緒"
        : state.localInferenceStatus === "error"
          ? "本機模型失敗，使用雲端"
          : "瀏覽器本機推論"
    : !state.configured
    ? "等待本機 Inference Server 或 API key"
    : state.warmupStatus === "warming"
      ? `${inferenceTargetLabel()} 預熱中`
      : state.warmupStatus === "error"
        ? warmupErrorLooksLikeConnectionIssue()
          ? `${inferenceTargetLabel()} 連線失敗`
          : `${inferenceTargetLabel()} 模型預熱失敗`
        : `${inferenceTargetLabel()} 已就緒`;
  elements.setupNote.classList.toggle(
    "configured",
    state.configured || localAvailable,
  );
  elements.setupNote.innerHTML = localAvailable
    ? state.localInferenceStatus === "loading"
      ? `<strong>正在下載／初始化本機模型</strong>
        <span>已等待 ${state.localLoadingElapsedSeconds} 秒。Roboflow SDK 不提供下載百分比；首次載入請保持 VPN 連線。</span>
        <span class="model-loading-track" aria-hidden="true"><i></i></span>`
      : state.localInferenceStatus === "ready"
        ? "<strong>低延遲本機模式</strong><span>RF-DETR 正在瀏覽器內執行，沒有每幀網路往返。</span>"
        : "<strong>本機模型載入失敗</strong><span>若未使用 VPN，可能是模型下載端點無法連線；偵測會嘗試改用雲端。</span>"
    : state.configured
    ? state.warmupStatus === "warming"
      ? `<strong>${inferenceTargetLabel()} 預熱中</strong><span>預熱完成後，第一幀也能更快回應。</span>`
      : state.warmupStatus === "error"
        ? `<strong>${
            warmupErrorLooksLikeConnectionIssue()
              ? `${inferenceTargetLabel()} 連線失敗`
              : `${inferenceTargetLabel()} 已連線，但模型預熱失敗`
          }</strong><span>${escapeHtml(
            state.warmupError ||
              "請確認 Model ID 是 Roboflow 的一般 Object Detection model/version，且模型已在本機 Inference Server 快取。",
          )}</span>`
        : `<strong>${inferenceTargetLabel()} 模式</strong><span>啟動相機即可開始正式推論；影像會送到 ${
            state.inferenceTarget === "self-hosted" ? "本機服務" : "Roboflow 雲端"
          }。</span>`
    : "<strong>需要推論後端</strong><span>不開 VPN 時，請啟動本機 Inference Server，並在 <code>.env</code> 設定 <code>ROBOFLOW_API_URL=http://127.0.0.1:9001</code>。</span>";

  elements.inferenceHint.textContent =
    state.localInferenceStatus === "ready"
      ? "瀏覽器本機推論"
      : state.inferenceTarget === "self-hosted"
        ? "本機 Inference Server"
        : "包含網路傳輸";
}

function inferenceTargetLabel() {
  return state.inferenceTarget === "self-hosted"
    ? "本機 Inference Server"
    : "Roboflow 模型";
}

function warmupErrorLooksLikeConnectionIssue() {
  return /無法連線|fetch failed|ECONNREFUSED|127\.0\.0\.1:9001|localhost:9001/i.test(
    state.warmupError || "",
  );
}

async function warmUpModel() {
  state.warmupStatus = "warming";
  state.warmupError = "";
  updateConnectionState();

  try {
    const response = await fetch(apiUrl("/api/warmup"), { method: "POST" });
    const result = await response.json();
    state.warmupStatus = result.ready ? "ready" : "error";
    state.warmupError = result.ready ? "" : result.error || "";
  } catch {
    state.warmupStatus = "error";
    state.warmupError =
      "Dashboard 後端無法連到本機 Roboflow Inference Server。請確認 127.0.0.1:9001 已啟動。";
  }
  updateConnectionState();
}

function updateClock() {
  elements.clock.textContent = new Intl.DateTimeFormat("zh-Hant", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function updateConfidence() {
  const value = Number(elements.confidence.value);
  const progress = ((value - 10) / 85) * 100;
  elements.confidence.style.setProperty("--range-progress", `${progress}%`);
  elements.confidenceValue.value = `${value}%`;
  elements.confidenceHint.textContent = `門檻 ${value}%`;
}

async function toggleCamera() {
  if (state.stream) {
    stopCamera();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("這個瀏覽器不支援相機存取。", true);
    return;
  }

  try {
    state.stream = await openCameraStream();
    elements.cameraVideo.srcObject = state.stream;
    await waitForVideo(elements.cameraVideo);
    await elements.cameraVideo.play();

    state.image = null;
    state.predictions = [];
    state.viewMode = "camera";
    elements.emptyState.classList.add("hidden");
    elements.cameraFeed.classList.add("visible");
    elements.cameraVideo.classList.add("visible");
    elements.detectionCanvas.classList.add("visible");
    clearDetectionCanvas();
    positionMediaLayer();
    elements.objectBadge.hidden = true;
    elements.cameraButton.textContent = "停止相機";
    elements.viewerTitle.textContent = "相機即時畫面";
    setRunStatus("ready");
    scheduleNextDetection();
  } catch (error) {
    stopCamera();
    console.error("Camera error", error);
    showToast(await cameraErrorMessage(error), true);
  }
}

async function openCameraStream() {
  const preferredConstraints = {
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  };

  try {
    return await navigator.mediaDevices.getUserMedia(preferredConstraints);
  } catch (error) {
    if (!shouldRetryCameraWithoutConstraints(error)) {
      throw error;
    }

    return navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
  }
}

function shouldRetryCameraWithoutConstraints(error) {
  return [
    "OverconstrainedError",
    "ConstraintNotSatisfiedError",
    "NotFoundError",
    "DevicesNotFoundError",
  ].includes(error?.name);
}

async function cameraErrorMessage(error) {
  const name = error?.name || error?.message || "UnknownError";
  const deviceCount = await countVideoInputs();
  const deviceHint =
    deviceCount == null ? "" : ` 瀏覽器目前偵測到 ${deviceCount} 個鏡頭。`;

  if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(name)) {
    return `相機權限被拒絕。請在瀏覽器網址列允許相機，並確認 Windows「設定 > 隱私權與安全性 > 相機」已開啟瀏覽器權限。(${name})`;
  }

  if (["NotFoundError", "DevicesNotFoundError"].includes(name)) {
    return `找不到可用鏡頭。請確認這台電腦有相機、外接相機已插好，或在 Windows 相機隱私權中允許瀏覽器使用。${deviceHint} (${name})`;
  }

  if (["NotReadableError", "TrackStartError"].includes(name)) {
    return `相機存在但無法讀取，常見原因是被 Teams、Zoom、相機 App 或瀏覽器另一個分頁佔用。請關閉那些程式後重新整理。${deviceHint} (${name})`;
  }

  if (["OverconstrainedError", "ConstraintNotSatisfiedError"].includes(name)) {
    return `相機不支援這個解析度或鏡頭方向，已嘗試改用預設相機仍失敗。請換另一個瀏覽器或檢查相機驅動。${deviceHint} (${name})`;
  }

  if (error?.message === "camera-timeout") {
    return `相機已被瀏覽器接受，但一直沒有畫面。請關閉其他使用相機的程式，或在 Windows 相機 App 先確認鏡頭可正常顯示。${deviceHint}`;
  }

  if (error?.message === "camera-error") {
    return `相機串流發生錯誤。請重新整理頁面，或確認瀏覽器和 Windows 都允許相機。${deviceHint}`;
  }

  return `無法開啟相機：${error?.message || name}。${deviceHint}`;
}

async function countVideoInputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "videoinput").length;
  } catch {
    return null;
  }
}

function waitForVideo(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("camera-timeout"));
    }, 8_000);
    const handleLoaded = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("camera-error"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("error", handleError);
    };

    video.addEventListener("loadedmetadata", handleLoaded, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

async function runDetection() {
  clearDetectionSchedule();
  if (state.isRunning || !state.stream) {
    return;
  }

  const modelId = elements.modelId.value.trim();
  if (!/^[a-zA-Z0-9_-]+\/[1-9]\d*$/.test(modelId)) {
    showToast("Model ID 格式需為 project/version，例如 lego-ai/3。", true);
    elements.modelId.focus();
    return;
  }

  if (!state.configured && !state.publishableKey) {
    showToast(
      "請先啟動本機 Inference Server，或在 .env 設定 ROBOFLOW_API_KEY / ROBOFLOW_PUBLISHABLE_KEY。",
      true,
    );
    return;
  }

  if (!captureCameraFrame()) {
    showToast("相機畫面尚未準備完成，請稍後再試。", true);
    scheduleNextDetection();
    return;
  }

  setLoading(true);

  try {
    const result =
      state.publishableKey && state.localInferenceStatus !== "error"
        ? await runLocalDetection(modelId)
        : await runCloudDetection(modelId);

    if (!state.stream) {
      return;
    }
    state.predictions = result.predictions || [];
    renderLiveOverlay();
    updateResults(state.predictions, result.inferenceTimeMs);
    elements.viewerTitle.textContent = "相機偵測結果";
    elements.downloadButton.disabled = false;
    setRunStatus("complete");
  } catch (error) {
    if (error.name === "AbortError" && error.message === "cancelled") {
      return;
    }

    setRunStatus("error");
    showToast(error.message || "推論失敗。", true);
    stopCamera();
  } finally {
    setLoading(false);
    scheduleNextDetection();
  }
}

async function runLocalDetection(modelId) {
  try {
    const workerId = await waitForLocalWorker(modelId);
    const imageBitmap = await createImageBitmap(state.image);
    const startedAt = performance.now();
    const predictions = await state.localEngine.infer(workerId, imageBitmap, [
      {
        scoreThreshold: Number(elements.confidence.value) / 100,
      },
    ]);

    return {
      predictions: normalizeLocalPredictions(predictions),
      inferenceTimeMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    state.localInferenceStatus = "error";
    stopLocalLoadingClock();
    updateConnectionState();

    if (!state.configured) {
      throw new Error(
        `瀏覽器本機模型無法執行：${error.message || "請檢查 Publishable Key。"}`,
      );
    }

    showToast(
      error.code === "LOCAL_MODEL_TIMEOUT"
        ? "本機模型載入超過 120 秒，已改用 Roboflow 雲端。請確認 VPN 仍保持連線。"
        : "本機模型無法執行，這一幀改用 Roboflow 雲端。",
      true,
    );
    return runCloudDetection(modelId);
  }
}

async function waitForLocalWorker(modelId) {
  const workerPromise = ensureLocalWorker(modelId);
  const elapsedMs = state.localLoadingStartedAt
    ? performance.now() - state.localLoadingStartedAt
    : 0;
  const remainingMs = Math.max(1, LOCAL_MODEL_LOAD_TIMEOUT_MS - elapsedMs);
  let timeout;

  try {
    return await Promise.race([
      workerPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(
            "本機模型下載或初始化超過 120 秒。請保持 VPN 連線後重新整理頁面。",
          );
          error.code = "LOCAL_MODEL_TIMEOUT";
          reject(error);
        }, remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function runCloudDetection(modelId) {
  const controller = new AbortController();
  state.requestController = controller;
  const timeout = setTimeout(
    () => controller.abort("timeout"),
    CLIENT_TIMEOUT_MS,
  );

  try {
    const response = await fetch("/api/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: state.image.toDataURL("image/jpeg", 0.6),
        modelId,
        confidence: Number(elements.confidence.value) / 100,
        overlap: 0.3,
      }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    let result = {};

    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error("伺服器回傳了無法解析的內容。");
    }

    if (!response.ok) {
      throw new Error(result.error || "Roboflow 推論失敗。");
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      if (controller.signal.reason === "cancelled") {
        const cancelled = new DOMException("cancelled", "AbortError");
        throw cancelled;
      }
      throw new Error(
        "推論超過 22 秒，已自動停止。請檢查網路、API key 與 Model ID。",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (state.requestController === controller) {
      state.requestController = null;
    }
  }
}

async function ensureLocalWorker(modelId = elements.modelId.value.trim()) {
  if (!state.publishableKey) {
    throw new Error("尚未設定 Roboflow Publishable Key。");
  }
  if (!/^[a-zA-Z0-9_-]+\/[1-9]\d*$/.test(modelId)) {
    throw new Error("Model ID 格式不正確。");
  }
  if (
    state.localWorkerId &&
    state.localModelId === modelId &&
    state.localInferenceStatus === "ready"
  ) {
    return state.localWorkerId;
  }
  if (state.localLoadingPromise && state.localModelId === modelId) {
    return state.localLoadingPromise;
  }

  await resetLocalWorker();
  state.localEngine ||= new InferenceEngine();
  state.localModelId = modelId;
  state.localInferenceStatus = "loading";
  startLocalLoadingClock();
  updateConnectionState();

  const [modelName, version] = modelId.split("/");
  state.localLoadingPromise = state.localEngine
    .startWorker(modelName, Number(version), state.publishableKey, [
      {
        size: LOCAL_MODEL_SIZE,
        scoreThreshold: Number(elements.confidence.value) / 100,
        maxNumBoxes: 50,
      },
    ])
    .then((workerId) => {
      state.localWorkerId = workerId;
      state.localInferenceStatus = "ready";
      stopLocalLoadingClock();
      updateConnectionState();
      return workerId;
    })
    .catch((error) => {
      state.localInferenceStatus = "error";
      stopLocalLoadingClock();
      updateConnectionState();
      throw error;
    })
    .finally(() => {
      state.localLoadingPromise = null;
    });

  return state.localLoadingPromise;
}

function startLocalLoadingClock() {
  stopLocalLoadingClock();
  state.localLoadingStartedAt = performance.now();
  state.localLoadingElapsedSeconds = 0;
  state.localLoadingClock = setInterval(() => {
    state.localLoadingElapsedSeconds = Math.floor(
      (performance.now() - state.localLoadingStartedAt) / 1000,
    );
    updateConnectionState();
  }, 1000);
}

function stopLocalLoadingClock() {
  clearInterval(state.localLoadingClock);
  state.localLoadingClock = null;
}

async function resetLocalWorker() {
  if (state.localEngine && state.localWorkerId) {
    try {
      await state.localEngine.stopWorker(state.localWorkerId);
    } catch {
      // The worker may already have stopped after a model load failure.
    }
  }
  state.localWorkerId = null;
  state.localModelId = "";
  stopLocalLoadingClock();
  if (state.publishableKey) {
    state.localInferenceStatus = "idle";
  }
}

function normalizeLocalPredictions(predictions) {
  if (!Array.isArray(predictions)) {
    return [];
  }
  return predictions.map((prediction, index) => ({
    id: `local-${index + 1}`,
    class: String(prediction.class || "object"),
    confidence: Number(prediction.confidence) || 0,
    x: Number(prediction.bbox?.x) || 0,
    y: Number(prediction.bbox?.y) || 0,
    width: Math.max(0, Number(prediction.bbox?.width) || 0),
    height: Math.max(0, Number(prediction.bbox?.height) || 0),
  }));
}

function captureCameraFrame() {
  const video = elements.cameraVideo;
  if (!video.videoWidth || !video.videoHeight) {
    return false;
  }

  const scale = Math.min(1, 416 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  state.image = canvas;
  return true;
}

function renderLiveOverlay() {
  if (!state.image || state.viewMode !== "camera") {
    return;
  }

  const canvas = elements.detectionCanvas;
  canvas.width = state.image.width;
  canvas.height = state.image.height;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  drawPredictions(context, state.predictions);

  elements.emptyState.classList.add("hidden");
  elements.cameraFeed.classList.add("visible");
  elements.cameraVideo.classList.add("visible");
  canvas.classList.add("visible");
  positionMediaLayer();
  elements.objectBadge.hidden = false;
}

function renderDemoImage() {
  if (!state.image) {
    return;
  }

  const canvas = elements.detectionCanvas;
  canvas.width = state.image.width;
  canvas.height = state.image.height;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(state.image, 0, 0);
  drawPredictions(context, state.predictions);

  elements.emptyState.classList.add("hidden");
  elements.cameraFeed.classList.add("visible");
  elements.cameraVideo.classList.remove("visible");
  canvas.classList.add("visible");
  positionMediaLayer();
  elements.objectBadge.hidden = false;
}

function positionMediaLayer() {
  if (state.viewMode === "empty") {
    return;
  }

  const containerWidth = elements.cameraFeed.clientWidth;
  const containerHeight = elements.cameraFeed.clientHeight;
  const sourceWidth =
    state.viewMode === "camera"
      ? elements.cameraVideo.videoWidth
      : state.image?.width;
  const sourceHeight =
    state.viewMode === "camera"
      ? elements.cameraVideo.videoHeight
      : state.image?.height;

  if (!containerWidth || !containerHeight || !sourceWidth || !sourceHeight) {
    return;
  }

  const scale = Math.min(
    containerWidth / sourceWidth,
    containerHeight / sourceHeight,
  );
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  Object.assign(elements.detectionCanvas.style, {
    width: `${width}px`,
    height: `${height}px`,
    left: `${(containerWidth - width) / 2}px`,
    top: `${(containerHeight - height) / 2}px`,
  });
}

function clearDetectionCanvas() {
  const canvas = elements.detectionCanvas;
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function drawPredictions(context, predictions) {
  const scale = Math.max(
    1,
    Math.min(context.canvas.width, context.canvas.height) / 800,
  );
  context.lineJoin = "round";
  context.textBaseline = "bottom";
  context.font = `700 ${Math.max(13, 14 * scale)}px Consolas, monospace`;

  predictions.forEach((prediction) => {
    const color = colorForClass(prediction.class);
    const left = prediction.x - prediction.width / 2;
    const top = prediction.y - prediction.height / 2;
    const label = `${prediction.class} ${Math.round(prediction.confidence * 100)}%`;
    const labelWidth = context.measureText(label).width + 12 * scale;
    const labelHeight = 22 * scale;
    const labelY = Math.max(labelHeight, top);

    context.strokeStyle = color;
    context.lineWidth = Math.max(2, 2.2 * scale);
    context.strokeRect(left, top, prediction.width, prediction.height);
    context.fillStyle = color;
    context.fillRect(left, labelY - labelHeight, labelWidth, labelHeight);
    context.fillStyle = "#041413";
    context.fillText(label, left + 6 * scale, labelY - 4 * scale);
  });
}

function setLoading(isLoading) {
  state.isRunning = isLoading;
  elements.analysisIndicator.hidden = !isLoading;
  elements.analysisLabel.textContent =
    state.localInferenceStatus === "loading"
      ? "載入本機 AI 模型"
      : "AI 分析中";
  if (isLoading) {
    setRunStatus("running");
  }
}

function setRunStatus(status) {
  elements.runStatus.className = "status-pill";
  const labels = {
    ready: "READY",
    running: "ANALYZING",
    complete: "COMPLETE",
    error: "ERROR",
  };
  if (status !== "ready") {
    elements.runStatus.classList.add(status);
  }
  elements.runStatus.innerHTML = `<span></span>${labels[status]}`;
}

function updateResults(predictions, inferenceTimeMs) {
  const total = predictions.length;
  const groups = groupPredictions(predictions);
  const average = total
    ? predictions.reduce((sum, item) => sum + item.confidence, 0) / total
    : 0;

  elements.totalCount.textContent = total;
  elements.classCount.textContent = groups.length;
  elements.averageConfidence.textContent = `${Math.round(average * 100)}%`;
  elements.inferenceTime.textContent =
    inferenceTimeMs == null ? "--" : `${inferenceTimeMs} ms`;
  elements.countDelta.textContent = total ? "本次偵測結果" : "未偵測到物件";
  elements.badgeCount.textContent = total;
  elements.insightCount.textContent = `${total} items`;
  elements.tableCount.textContent = total;
  renderClassList(groups, total);
  renderDetectionTable(predictions);
}

function groupPredictions(predictions) {
  const counts = new Map();
  for (const prediction of predictions) {
    counts.set(prediction.class, (counts.get(prediction.class) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function renderClassList(groups, total) {
  if (!groups.length) {
    elements.classList.innerHTML = `
      <div class="insights-empty">
        <span class="empty-bars" aria-hidden="true"><i></i><i></i><i></i></span>
        <p>完成偵測後，類別統計會顯示在這裡。</p>
      </div>`;
    return;
  }

  elements.classList.innerHTML = groups
    .map(({ name, count }) => {
      const percentage = Math.round((count / total) * 100);
      const color = colorForClass(name);
      return `
        <div class="class-item">
          <div class="class-item-header">
            <div class="class-name">
              <span class="class-swatch" style="background:${color}"></span>
              <span title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            </div>
            <span class="class-value">${count} / ${percentage}%</span>
          </div>
          <div class="class-track">
            <span style="width:${percentage}%;background:${color}"></span>
          </div>
        </div>`;
    })
    .join("");
}

function renderDetectionTable(predictions) {
  if (!predictions.length) {
    elements.detectionTable.innerHTML =
      '<tr class="table-empty"><td colspan="2">尚無資料</td></tr>';
    return;
  }

  elements.detectionTable.innerHTML = predictions
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .map(
      (prediction) => `
        <tr>
          <td title="${escapeHtml(prediction.class)}">${escapeHtml(prediction.class)}</td>
          <td class="confidence-cell">${Math.round(prediction.confidence * 100)}%</td>
        </tr>`,
    )
    .join("");
}

function scheduleNextDetection() {
  clearDetectionSchedule();
  if (!state.stream || state.isRunning) {
    return;
  }
  state.detectionFrame = requestAnimationFrame(runDetection);
}

function clearDetectionSchedule() {
  cancelAnimationFrame(state.detectionFrame);
  state.detectionFrame = null;
}

function cancelCurrentRequest() {
  if (state.requestController) {
    state.requestController.abort("cancelled");
    state.requestController = null;
  }
}

function stopCamera() {
  clearDetectionSchedule();
  cancelCurrentRequest();
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
  }
  state.stream = null;
  elements.cameraVideo.srcObject = null;
  elements.cameraVideo.classList.remove("visible");
  elements.cameraFeed.classList.remove("visible");
  elements.detectionCanvas.classList.remove("visible");
  state.viewMode = "empty";
  elements.cameraButton.textContent = "啟動相機";
  setLoading(false);
}

function resetDashboard() {
  stopCamera();
  state.image = null;
  state.predictions = [];
  clearDetectionCanvas();
  elements.emptyState.classList.remove("hidden");
  elements.objectBadge.hidden = true;
  elements.viewerTitle.textContent = "等待啟動相機";
  elements.downloadButton.disabled = true;
  updateResults([], null);
  setRunStatus("ready");
}

function loadDemo() {
  stopCamera();
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 600;
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 960, 600);
  gradient.addColorStop(0, "#122d30");
  gradient.addColorStop(1, "#081719");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  drawDemoObject(context, 115, 165, 155, 255, "#1b776e", "A1");
  drawDemoObject(context, 325, 115, 190, 315, "#225c76", "B2");
  drawDemoObject(context, 585, 190, 145, 235, "#776029", "C3");
  drawDemoObject(context, 755, 135, 110, 290, "#6d3552", "D4");

  state.image = canvas;
  state.viewMode = "demo";
  state.predictions = [
    { class: "container", confidence: 0.96, x: 192, y: 292, width: 155, height: 255 },
    { class: "container", confidence: 0.92, x: 420, y: 272, width: 190, height: 315 },
    { class: "package", confidence: 0.88, x: 657, y: 307, width: 145, height: 235 },
    { class: "package", confidence: 0.84, x: 810, y: 280, width: 110, height: 290 },
  ];
  renderDemoImage();
  updateResults(state.predictions, 184);
  elements.viewerTitle.textContent = "AquaPulse 示範場景";
  elements.downloadButton.disabled = false;
  setRunStatus("complete");
  showToast("已載入示範資料；啟動相機可使用 Roboflow 正式推論。");
}

function drawDemoObject(context, x, y, width, height, color, label) {
  context.fillStyle = "rgba(0, 0, 0, .3)";
  context.fillRect(x + 10, y + 12, width, height);
  context.fillStyle = color;
  context.fillRect(x, y, width, height);
  context.fillStyle = "rgba(255, 255, 255, .11)";
  context.fillRect(x + 12, y + 14, width - 24, 18);
  context.fillStyle = "rgba(235, 250, 247, .68)";
  context.font = "700 28px Consolas, monospace";
  context.fillText(label, x + 16, y + height - 18);
}

function downloadAnnotatedImage() {
  if (!state.image) {
    return;
  }

  const output = document.createElement("canvas");
  output.width = state.image.width;
  output.height = state.image.height;
  const context = output.getContext("2d");
  context.drawImage(state.image, 0, 0);
  drawPredictions(context, state.predictions);

  const link = document.createElement("a");
  link.download = `aquapulse-detection-${Date.now()}.png`;
  link.href = output.toDataURL("image/png");
  link.click();
}

function colorForClass(className) {
  let hash = 0;
  for (const character of className) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return palette[hash % palette.length];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let toastTimer;
function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, 5000);
}
