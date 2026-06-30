import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInferenceUrl,
  clampThreshold,
  describeRoboflowError,
  normalizePredictions,
  stripDataUrl,
  validateModelId,
} from "./lib/roboflow.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(__dirname, "public");
const MAX_BODY_BYTES = 16 * 1024 * 1024;

loadEnvFile(path.join(__dirname, ".env"));

const REQUEST_TIMEOUT_MS =
  Number(process.env.ROBOFLOW_TIMEOUT_MS) || 20_000;
const portArgument = process.argv.find((argument) =>
  argument.startsWith("--port="),
);
const port = Number(portArgument?.slice("--port=".length) || process.env.PORT) || 3000;
const apiKey = process.env.ROBOFLOW_API_KEY?.trim() || "";
const rawPublishableKey =
  process.env.ROBOFLOW_PUBLISHABLE_KEY?.trim() || "";
const defaultModelId = process.env.ROBOFLOW_MODEL_ID?.trim() || "";
const apiUrl =
  process.env.ROBOFLOW_API_URL?.trim() || "https://serverless.roboflow.com";
const selfHostedInference = isLoopbackUrl(apiUrl);
const browserInferenceEnabled = flagEnabled(
  process.env.ROBOFLOW_BROWSER_INFERENCE,
  Boolean(rawPublishableKey),
);
const publishableKey = browserInferenceEnabled ? rawPublishableKey : "";
const dashboards = parseDashboardModels(
  process.env.DASHBOARD_MODELS,
  defaultModelId,
);
const defaultDashboard = dashboards[0] || {
  key: "default",
  label: "Default",
  modelId: defaultModelId,
};
const WARMUP_IMAGE_BASE64 = createSolidBmpBase64(64, 64);

const modelWarmupPromises = new Map();
const modelWarmupStatuses = new Map();
const modelWarmupErrors = new Map();

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && requestUrl.pathname === "/api/config") {
      const dashboard = resolveDashboard(requestUrl);
      return sendJson(response, 200, {
        configured: Boolean(apiKey || selfHostedInference),
        dashboard,
        dashboards,
        defaultModelId: dashboard.modelId,
        browserInferenceEnabled,
        inferenceTarget: selfHostedInference ? "self-hosted" : "hosted",
        publishableKey,
        warmupError: getWarmupError(dashboard.modelId),
        warmupStatus: getWarmupStatus(dashboard.modelId),
      });
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/warmup") {
      const dashboard = resolveDashboard(requestUrl);
      const result = await warmRoboflowModel(dashboard.modelId);
      return sendJson(response, result.ready ? 200 : 503, result);
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/detect") {
      return await handleDetection(request, response);
    }

    if (request.method === "GET" || request.method === "HEAD") {
      if (
        requestUrl.pathname === "/dashboards" ||
        requestUrl.pathname.startsWith("/dashboards/")
      ) {
        return await serveStatic("/", request, response);
      }
      return await serveStatic(requestUrl.pathname, request, response);
    }

    return sendJson(response, 404, { error: "找不到這個 API 路徑。" });
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: "伺服器發生未預期的錯誤。" });
  }
});

async function handleDetection(request, response) {
  if (!apiKey && !selfHostedInference) {
    return sendJson(response, 503, {
      error:
        "尚未設定 ROBOFLOW_API_KEY。若要不開 VPN，請先啟動本機 Inference Server 並將 ROBOFLOW_API_URL 設為 http://127.0.0.1:9001。",
    });
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return sendJson(response, error.statusCode || 400, { error: error.message });
  }

  const modelId = String(body.modelId || defaultModelId).trim();
  if (!validateModelId(modelId)) {
    return sendJson(response, 400, {
      error: "Model ID 格式需為 project/version，例如 aqua-monitor/1。",
    });
  }

  const image = stripDataUrl(body.image).replace(/\s/g, "");
  if (!image || !/^[a-zA-Z0-9+/]+=*$/.test(image)) {
    return sendJson(response, 400, { error: "沒有收到有效的圖片資料。" });
  }

  const warmupPromise = modelWarmupPromises.get(modelId);
  if (getWarmupStatus(modelId) === "warming" && warmupPromise) {
    await warmupPromise;
  }

  const inferenceUrl = buildInferenceUrl({
    apiUrl,
    modelId,
    apiKey,
    confidence: clampThreshold(body.confidence, 0.4),
    overlap: clampThreshold(body.overlap, 0.3),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const handleClientClose = () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  };
  response.once("close", handleClientClose);
  const startedAt = performance.now();

  try {
    const roboflowResponse = await fetch(inferenceUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: image,
      signal: controller.signal,
    });
    const responseText = await roboflowResponse.text();
    const contentType = roboflowResponse.headers.get("content-type") || "";
    let payload;

    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }

    if (!roboflowResponse.ok || !payload || typeof payload !== "object") {
      const statusCode = roboflowResponse.ok ? 502 : roboflowResponse.status;
      return sendJson(response, statusCode, {
        error: describeRoboflowError({
          payload,
          responseText,
          status: roboflowResponse.status,
          contentType,
        }),
      });
    }

    return sendJson(response, 200, {
      predictions: normalizePredictions(payload),
      image: payload?.image || null,
      inferenceTimeMs: Math.round(performance.now() - startedAt),
      modelId,
    });
  } catch (error) {
    const message =
      error.name === "AbortError"
        ? "Roboflow 推論逾時，請稍後再試。"
        : selfHostedInference
          ? "無法連線到本機 Roboflow Inference Server。請確認 http://127.0.0.1:9001 已啟動。"
          : "無法連線到 Roboflow Inference Server。";
    return sendJson(response, 502, { error: message });
  } finally {
    clearTimeout(timeout);
    response.removeListener("close", handleClientClose);
  }
}

function warmRoboflowModel(modelId = defaultDashboard.modelId) {
  if ((!apiKey && !selfHostedInference) || !validateModelId(modelId)) {
    const error =
      "Roboflow API key、本機 Inference Server 或預設 Model ID 尚未設定。";
    setWarmupError(modelId, error);
    return Promise.resolve({
      ready: false,
      error,
    });
  }

  const currentPromise = modelWarmupPromises.get(modelId);
  if (currentPromise) {
    return currentPromise;
  }

  setWarmupStatus(modelId, "warming");
  const modelWarmupPromise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = performance.now();

    try {
      const inferenceUrl = buildInferenceUrl({
        apiUrl,
        modelId,
        apiKey,
        confidence: 0.99,
        overlap: 0.3,
      });
      const response = await fetch(inferenceUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: WARMUP_IMAGE_BASE64,
        signal: controller.signal,
      });
      const responseText = await response.text();
      const contentType = response.headers.get("content-type") || "";
      let payload;

      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = null;
      }

      if (!response.ok || !payload || typeof payload !== "object") {
        setWarmupStatus(modelId, "error");
        const error = describeRoboflowError({
          payload,
          responseText,
          status: response.status,
          contentType,
        });
        setWarmupError(modelId, error);
        return {
          ready: false,
          error,
        };
      }

      setWarmupStatus(modelId, "ready");
      setWarmupError(modelId, "");
      return {
        ready: true,
        modelId,
        warmupTimeMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      setWarmupStatus(modelId, "error");
      const cause = error.cause?.code || error.cause?.message;
      const message = `模型預熱失敗：${cause || error.message || "未知錯誤"}`;
      setWarmupError(modelId, message);
      return {
        ready: false,
        modelId,
        error: message,
      };
    } finally {
      clearTimeout(timeout);
    }
  })().then((result) => {
    if (!result.ready) {
      modelWarmupPromises.delete(modelId);
    }
    return result;
  });

  modelWarmupPromises.set(modelId, modelWarmupPromise);
  return modelWarmupPromise;
}

function getWarmupStatus(modelId) {
  if (!modelWarmupStatuses.has(modelId)) {
    modelWarmupStatuses.set(
      modelId,
      (apiKey || selfHostedInference) && validateModelId(modelId)
        ? "idle"
        : "disabled",
    );
  }
  return modelWarmupStatuses.get(modelId);
}

function setWarmupStatus(modelId, status) {
  modelWarmupStatuses.set(modelId, status);
}

function getWarmupError(modelId) {
  return modelWarmupErrors.get(modelId) || "";
}

function setWarmupError(modelId, error) {
  if (error) {
    modelWarmupErrors.set(modelId, error);
  } else {
    modelWarmupErrors.delete(modelId);
  }
}

function createSolidBmpBase64(width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const buffer = Buffer.alloc(54 + pixelBytes);

  buffer.write("BM", 0, 2, "ascii");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelBytes, 34);
  buffer.writeInt32LE(2835, 38);
  buffer.writeInt32LE(2835, 42);
  buffer.fill(255, 54);

  return buffer.toString("base64");
}

async function serveStatic(urlPath, request, response) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    return sendJson(response, 400, { error: "網址格式不正確。" });
  }

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
  const filePath = path.resolve(publicDirectory, relativePath);
  const relativeToPublic = path.relative(publicDirectory, filePath);

  if (
    relativeToPublic.startsWith("..") ||
    path.isAbsolute(relativeToPublic) ||
    !existsSync(filePath)
  ) {
    return sendJson(response, 404, { error: "找不到頁面。" });
  }

  const extension = path.extname(filePath).toLowerCase();
  const content = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
    "Content-Length": content.length,
    "Cache-Control": [".html", ".js", ".css"].includes(extension)
      ? "no-store"
      : "public, max-age=3600",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self'; style-src 'self'; worker-src 'self' blob:; connect-src 'self' https://api.roboflow.com https://*.roboflow.com https://storage.googleapis.com;",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });

  if (request.method === "HEAD") {
    return response.end();
  }
  response.end(content);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error("圖片太大，請使用 12 MB 以下的圖片。");
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      body += chunk;
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        const error = new Error("請求內容不是有效的 JSON。");
        error.statusCode = 400;
        reject(error);
      }
    });

    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function flagEnabled(value, fallback = false) {
  if (value == null || value === "") {
    return fallback;
  }
  return !/^(?:0|false|no|off)$/i.test(String(value).trim());
}

function parseDashboardModels(value, fallbackModelId) {
  const models = [];
  const source = value?.trim();

  if (source) {
    for (const entry of source.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) {
        continue;
      }

      const separatorIndex = trimmed.search(/[:=]/);
      const rawKey =
        separatorIndex === -1 ? trimmed.split("/")[0] : trimmed.slice(0, separatorIndex);
      const modelId =
        separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1).trim();
      const key = normalizeDashboardKey(rawKey);

      if (key && validateModelId(modelId) && !models.some((item) => item.key === key)) {
        models.push({
          key,
          label: labelForDashboardKey(key),
          modelId,
        });
      }
    }
  }

  if (!models.length && validateModelId(fallbackModelId)) {
    models.push({
      key: "default",
      label: "Default",
      modelId: fallbackModelId,
    });
  }

  return models;
}

function resolveDashboard(requestUrl) {
  const pathMatch = requestUrl.pathname.match(/^\/dashboards\/([^/]+)/);
  const requestedKey = normalizeDashboardKey(
    requestUrl.searchParams.get("dashboard") || pathMatch?.[1] || "",
  );
  return (
    dashboards.find((dashboard) => dashboard.key === requestedKey) ||
    defaultDashboard
  );
}

function normalizeDashboardKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function labelForDashboardKey(key) {
  return key
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isLoopbackUrl(value) {
  try {
    const { hostname } = new URL(value);
    return ["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

server.listen(port, "127.0.0.1", () => {
  console.log(`AquaPulse Vision Dashboard: http://127.0.0.1:${port}`);
  if (!apiKey && !selfHostedInference) {
    console.log(
      "Roboflow API key is not configured. Demo mode is still available.",
    );
} else {
    for (const dashboard of dashboards) {
      void warmRoboflowModel(dashboard.modelId);
    }
  }
});
