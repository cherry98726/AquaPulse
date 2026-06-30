import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("proxies an image to Roboflow and returns normalized detections", async (t) => {
  let capturedRequest;
  const mockRoboflow = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      capturedRequest = {
        body,
        contentType: request.headers["content-type"],
        url: request.url,
      };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          image: { width: 640, height: 480 },
          predictions: [
            {
              class: "bottle",
              confidence: 0.93,
              x: 120,
              y: 160,
              width: 50,
              height: 100,
            },
          ],
        }),
      );
    });
  });

  await listen(mockRoboflow);
  t.after(() => mockRoboflow.close());
  const mockPort = mockRoboflow.address().port;
  const dashboardPort = await getFreePort();

  const dashboard = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      PORT: String(dashboardPort),
      ROBOFLOW_API_KEY: "test-key",
      ROBOFLOW_BROWSER_INFERENCE: "true",
      ROBOFLOW_PUBLISHABLE_KEY: "rf_publishable-test",
      ROBOFLOW_MODEL_ID: "aqua-model/2",
      ROBOFLOW_API_URL: `http://127.0.0.1:${mockPort}`,
    },
    stdio: "ignore",
  });
  t.after(() => dashboard.kill());

  await waitForServer(`http://127.0.0.1:${dashboardPort}/api/config`);
  const configResponse = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/config`,
  );
  const configPayload = await configResponse.json();
  assert.equal(configPayload.publishableKey, "rf_publishable-test");

  const appResponse = await fetch(`http://127.0.0.1:${dashboardPort}/`);
  assert.match(
    appResponse.headers.get("content-security-policy"),
    /worker-src 'self' blob:/,
  );
  const vendorResponse = await fetch(
    `http://127.0.0.1:${dashboardPort}/vendor/inference.es.js`,
  );
  assert.equal(vendorResponse.status, 200);
  assert.match(vendorResponse.headers.get("content-type"), /javascript/);
  const warmupResponse = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/warmup`,
    { method: "POST" },
  );
  const warmupPayload = await warmupResponse.json();
  assert.equal(warmupResponse.status, 200);
  assert.equal(warmupPayload.ready, true);

  const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/detect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image: "data:image/jpeg;base64,YWJj",
      confidence: 0.55,
      overlap: 0.2,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.modelId, "aqua-model/2");
  assert.equal(payload.predictions.length, 1);
  assert.equal(payload.predictions[0].class, "bottle");
  assert.equal(capturedRequest.body, "YWJj");
  assert.equal(capturedRequest.contentType, "application/json");

  const forwardedUrl = new URL(capturedRequest.url, "http://mock");
  assert.equal(forwardedUrl.pathname, "/aqua-model/2");
  assert.equal(forwardedUrl.searchParams.get("api_key"), "test-key");
  assert.equal(forwardedUrl.searchParams.get("confidence"), "0.55");
});

test("returns an error when Roboflow does not respond before the timeout", async (t) => {
  const mockRoboflow = createServer(() => {
    // Intentionally leave the request open to exercise the timeout.
  });
  await listen(mockRoboflow);
  t.after(() => mockRoboflow.closeAllConnections());
  t.after(() => mockRoboflow.close());

  const mockPort = mockRoboflow.address().port;
  const dashboardPort = await getFreePort();
  const dashboard = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      PORT: String(dashboardPort),
      ROBOFLOW_API_KEY: "test-key",
      ROBOFLOW_MODEL_ID: "aqua-model/2",
      ROBOFLOW_API_URL: `http://127.0.0.1:${mockPort}`,
      ROBOFLOW_TIMEOUT_MS: "100",
    },
    stdio: "ignore",
  });
  t.after(() => dashboard.kill());

  await waitForServer(`http://127.0.0.1:${dashboardPort}/api/config`);
  const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/detect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image: "YWJj",
      modelId: "aqua-model/2",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.match(payload.error, /逾時/);
});

test("serves named dashboards with different default models", async (t) => {
  const mockRoboflow = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ predictions: [] }));
    });
  });
  await listen(mockRoboflow);
  t.after(() => mockRoboflow.close());

  const mockPort = mockRoboflow.address().port;
  const dashboardPort = await getFreePort();
  const dashboard = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      PORT: String(dashboardPort),
      DASHBOARD_MODELS: "lego=lego-ai/3,people=people-mvoqs/4",
      ROBOFLOW_API_KEY: "test-key",
      ROBOFLOW_MODEL_ID: "lego-ai/3",
      ROBOFLOW_API_URL: `http://127.0.0.1:${mockPort}`,
    },
    stdio: "ignore",
  });
  t.after(() => dashboard.kill());

  await waitForServer(`http://127.0.0.1:${dashboardPort}/api/config`);
  const peopleConfigResponse = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/config?dashboard=people`,
  );
  const peopleConfig = await peopleConfigResponse.json();
  assert.equal(peopleConfig.dashboard.key, "people");
  assert.equal(peopleConfig.defaultModelId, "people-mvoqs/4");
  assert.equal(peopleConfig.dashboards.length, 2);

  const legoConfigResponse = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/config?dashboard=lego`,
  );
  const legoConfig = await legoConfigResponse.json();
  assert.equal(legoConfig.dashboard.key, "lego");
  assert.equal(legoConfig.defaultModelId, "lego-ai/3");

  const pageResponse = await fetch(
    `http://127.0.0.1:${dashboardPort}/dashboards/people`,
  );
  const pageHtml = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(pageHtml, /app\.js\?v=12/);
});

test("supports self-hosted inference without exposing a publishable key", async (t) => {
  const capturedRequests = [];
  const mockRoboflow = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      capturedRequests.push({
        body,
        contentType: request.headers["content-type"],
        url: request.url,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ predictions: [] }));
    });
  });

  await listen(mockRoboflow);
  t.after(() => mockRoboflow.close());
  const mockPort = mockRoboflow.address().port;
  const dashboardPort = await getFreePort();

  const dashboard = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      PORT: String(dashboardPort),
      ROBOFLOW_API_KEY: "",
      ROBOFLOW_BROWSER_INFERENCE: "false",
      ROBOFLOW_PUBLISHABLE_KEY: "rf_publishable-test",
      ROBOFLOW_MODEL_ID: "aqua-model/2",
      ROBOFLOW_API_URL: `http://127.0.0.1:${mockPort}`,
    },
    stdio: "ignore",
  });
  t.after(() => dashboard.kill());

  await waitForServer(`http://127.0.0.1:${dashboardPort}/api/config`);
  const configResponse = await fetch(
    `http://127.0.0.1:${dashboardPort}/api/config`,
  );
  const configPayload = await configResponse.json();
  assert.equal(configPayload.configured, true);
  assert.equal(configPayload.browserInferenceEnabled, false);
  assert.equal(configPayload.inferenceTarget, "self-hosted");
  assert.equal(configPayload.publishableKey, "");

  const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/detect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image: "YWJj",
      modelId: "aqua-model/2",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.predictions, []);
  const detectRequest = capturedRequests.find((request) => request.body === "YWJj");
  assert.ok(detectRequest);

  const forwardedUrl = new URL(detectRequest.url, "http://mock");
  assert.equal(forwardedUrl.pathname, "/aqua-model/2");
  assert.equal(forwardedUrl.searchParams.has("api_key"), false);
});

test("does not expose an upstream HTML error page to the dashboard", async (t) => {
  const mockRoboflow = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(403, { "Content-Type": "text/html; charset=UTF-8" });
      response.end(
        '<!DOCTYPE html><!--[if lt IE 7]><html class="no-js ie6 oldie">',
      );
    });
  });
  await listen(mockRoboflow);
  t.after(() => mockRoboflow.close());

  const mockPort = mockRoboflow.address().port;
  const dashboardPort = await getFreePort();
  const dashboard = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      PORT: String(dashboardPort),
      ROBOFLOW_API_KEY: "test-key",
      ROBOFLOW_MODEL_ID: "aqua-model/2",
      ROBOFLOW_API_URL: `http://127.0.0.1:${mockPort}`,
    },
    stdio: "ignore",
  });
  t.after(() => dashboard.kill());

  await waitForServer(`http://127.0.0.1:${dashboardPort}/api/config`);
  const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/detect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: "YWJj" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.match(payload.error, /網路或 CDN 攔截/);
  assert.doesNotMatch(payload.error, /DOCTYPE/);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function getFreePort() {
  const server = createServer();
  await listen(server);
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Dashboard server did not start in time.");
}
