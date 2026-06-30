const MODEL_ID_PATTERN = /^[a-zA-Z0-9_-]+\/[1-9]\d*$/;

export function validateModelId(modelId) {
  return typeof modelId === "string" && MODEL_ID_PATTERN.test(modelId.trim());
}

export function clampThreshold(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, number));
}

export function stripDataUrl(image) {
  if (typeof image !== "string") {
    return "";
  }

  const commaIndex = image.indexOf(",");
  return image.startsWith("data:") && commaIndex !== -1
    ? image.slice(commaIndex + 1)
    : image;
}

export function buildInferenceUrl({
  apiUrl,
  modelId,
  apiKey,
  confidence = 0.4,
  overlap = 0.3,
}) {
  const baseUrl = new URL(apiUrl);
  const [project, version] = modelId.split("/");
  const pathPrefix = baseUrl.pathname.replace(/\/+$/, "");
  baseUrl.pathname = `${pathPrefix}/${encodeURIComponent(project)}/${encodeURIComponent(version)}`;
  baseUrl.search = "";
  if (apiKey) {
    baseUrl.searchParams.set("api_key", apiKey);
  }
  baseUrl.searchParams.set("confidence", String(clampThreshold(confidence, 0.4)));
  baseUrl.searchParams.set("overlap", String(clampThreshold(overlap, 0.3)));
  return baseUrl;
}

export function normalizePredictions(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const predictions = Array.isArray(payload.predictions)
    ? payload.predictions
    : [];

  return predictions
    .filter((prediction) => prediction && typeof prediction === "object")
    .map((prediction, index) => ({
      id: prediction.detection_id || `detection-${index + 1}`,
      class: String(prediction.class ?? prediction.class_name ?? "object"),
      classId: prediction.class_id ?? null,
      confidence: clampThreshold(prediction.confidence, 0),
      x: Number(prediction.x) || 0,
      y: Number(prediction.y) || 0,
      width: Math.max(0, Number(prediction.width) || 0),
      height: Math.max(0, Number(prediction.height) || 0),
    }));
}

export function describeRoboflowError({
  payload,
  responseText,
  status,
  contentType = "",
}) {
  const payloadMessage = payload?.message || payload?.error;
  if (typeof payloadMessage === "string" && payloadMessage.trim()) {
    return (
      formatKnownRoboflowError(payloadMessage.trim(), status) ||
      payloadMessage.trim()
    );
  }

  const text = String(responseText || "").trim();
  const knownError = formatKnownRoboflowError(text, status);
  if (knownError) {
    return knownError;
  }

  const receivedHtml =
    contentType.toLowerCase().includes("text/html") ||
    /^(?:<!doctype html|<html\b)/i.test(text);

  if (receivedHtml) {
    return `Roboflow 連線被網路或 CDN 攔截（HTTP ${status}，收到 HTML 而非推論結果）。請切換網路、啟用 VPN，或使用本機 Inference Server。`;
  }

  const compactText = text.replace(/\s+/g, " ").slice(0, 240);
  return compactText || `Roboflow 推論失敗（HTTP ${status}）。`;
}

function formatKnownRoboflowError(message, status) {
  if (!message) {
    return "";
  }

  if (
    /CORE_MODEL_SAM3_ENABLED|SAM3 dependencies|SMA3 dependencies|does not support SAM3|does not support SMA3/i.test(
      message,
    )
  ) {
    return `這個 Roboflow 模型需要 SAM3，但目前的本機 Roboflow Inference Server 不支援 SAM3（HTTP ${status}）。Windows/CPU installer 通常只能跑一般 object detection；請改用 Roboflow 上的 Object Detection model/version，或使用支援 SAM3 的 GPU inference/Roboflow hosted 端點。`;
  }

  return "";
}
