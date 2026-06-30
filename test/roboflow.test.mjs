import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInferenceUrl,
  clampThreshold,
  describeRoboflowError,
  normalizePredictions,
  stripDataUrl,
  validateModelId,
} from "../lib/roboflow.mjs";

test("validates Roboflow project/version model identifiers", () => {
  assert.equal(validateModelId("lego-people/3"), true);
  assert.equal(validateModelId("workspace/project/3"), false);
  assert.equal(validateModelId("lego-people/latest"), false);
});

test("clamps confidence thresholds", () => {
  assert.equal(clampThreshold(1.5, 0.4), 1);
  assert.equal(clampThreshold(-0.5, 0.4), 0);
  assert.equal(clampThreshold("bad", 0.4), 0.4);
});

test("strips data URL metadata", () => {
  assert.equal(stripDataUrl("data:image/jpeg;base64,abc123"), "abc123");
  assert.equal(stripDataUrl("abc123"), "abc123");
});

test("builds the serverless inference URL", () => {
  const url = buildInferenceUrl({
    apiUrl: "https://serverless.roboflow.com",
    modelId: "lego-people/3",
    apiKey: "secret",
    confidence: 0.55,
    overlap: 0.2,
  });

  assert.equal(url.origin, "https://serverless.roboflow.com");
  assert.equal(url.pathname, "/lego-people/3");
  assert.equal(url.searchParams.get("api_key"), "secret");
  assert.equal(url.searchParams.get("confidence"), "0.55");
});

test("omits api_key from inference URLs when no key is configured", () => {
  const url = buildInferenceUrl({
    apiUrl: "http://127.0.0.1:9001",
    modelId: "lego-people/3",
    apiKey: "",
    confidence: 0.55,
    overlap: 0.2,
  });

  assert.equal(url.origin, "http://127.0.0.1:9001");
  assert.equal(url.pathname, "/lego-people/3");
  assert.equal(url.searchParams.has("api_key"), false);
});

test("normalizes detection predictions", () => {
  const predictions = normalizePredictions({
    predictions: [
      {
        detection_id: "abc",
        class: "bottle",
        confidence: 0.91,
        x: 100,
        y: 120,
        width: 40,
        height: 80,
      },
    ],
  });

  assert.deepEqual(predictions[0], {
    id: "abc",
    class: "bottle",
    classId: null,
    confidence: 0.91,
    x: 100,
    y: 120,
    width: 40,
    height: 80,
  });
});

test("replaces upstream HTML error pages with a useful network message", () => {
  const message = describeRoboflowError({
    payload: null,
    responseText:
      '<!DOCTYPE html><!--[if lt IE 7]><html class="no-js ie6 oldie">',
    status: 403,
    contentType: "text/html; charset=UTF-8",
  });

  assert.match(message, /網路或 CDN 攔截/);
  assert.match(message, /HTTP 403/);
  assert.doesNotMatch(message, /DOCTYPE/);
});
