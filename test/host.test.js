import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply, DIAGNOSTICS_PATH, diagnosticsFile } from "../lib/index.js";
import { diagnosticsEndpoint } from "../lib/client/diagnostics-sink.mjs";

function createHostContext() {
  const routes = [];
  const effects = [];
  return {
    routes,
    effects,
    webServer: {
      register(definition) {
        routes.push(definition);
        return () => { definition.disposed = true; };
      }
    },
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose });
      return dispose;
    }
  };
}

function requestWith(method, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (payload !== "") yield Buffer.from(payload, "utf8");
    }
  };
}

function createResponse() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; }
  };
}

async function withProfileDirectory(run) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-session-reminder-"));
  const previous = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = dir;
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function readLines(text) {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

test("host records a ready marker and appends client reports under the profile", async () => {
  await withProfileDirectory(async (dir) => {
    const diagnostics = diagnosticsFile();
    assert.equal(diagnostics, join(dir, ".dsh-session-reminder", "diagnostics.jsonl"));

    const ctx = createHostContext();
    apply(ctx);

    assert.equal(ctx.routes.length, 1);
    assert.equal(ctx.routes[0].path, DIAGNOSTICS_PATH);
    assert.equal(ctx.routes[0].kind, "exact");

    // host-ready 由 effect 异步写出（不阻塞插件加载）。
    let lines = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        lines = readLines(await readFile(diagnostics, "utf8"));
        if (lines.length > 0) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(lines[0]?.event, "host-ready");
    assert.equal(lines[0]?.payload?.route, DIAGNOSTICS_PATH);

    const response = createResponse();
    await ctx.routes[0].handler(
      requestWith("POST", { at: "2026-01-01T00:00:00.000Z", event: "attach", payload: { ok: true } }),
      response
    );
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).ok, true);

    const appended = readLines(await readFile(diagnostics, "utf8"));
    assert.equal(appended.length, 2);
    assert.equal(appended[1].event, "client:attach");
    assert.deepEqual(appended[1].payload, { ok: true });
  });
});

test("host diagnostics route rejects a wrong method and a missing event", async () => {
  await withProfileDirectory(async () => {
    const ctx = createHostContext();
    apply(ctx);
    const handler = ctx.routes[0].handler;

    const wrongMethod = createResponse();
    await handler(requestWith("GET"), wrongMethod);
    assert.equal(wrongMethod.status, 405);

    const missingEvent = createResponse();
    await handler(requestWith("POST", { payload: {} }), missingEvent);
    assert.equal(missingEvent.status, 400);
  });
});

// —— 以下是诊断契约的闸门（.scratch/session-status/issues/07-diagnostics-contract-owner.md）：坏记录不再静默落盘，而且拒绝这件事是可观察的。

const STATUS_PAYLOAD = {
  statusEntries: 1,
  currentId: "current",
  currentInStatuses: true,
  listHandlesCurrent: true,
  runs: []
};

test("host refuses a report whose shape is not in the diagnostics contract, and counts it", async () => {
  await withProfileDirectory(async (dir) => {
    const diagnostics = diagnosticsFile();
    const ctx = createHostContext();
    apply(ctx);
    const handler = ctx.routes[0].handler;

    // ① 词表外的事件名：以前会被原样落盘，现在被拒。
    const unknown = createResponse();
    await handler(requestWith("POST", { at: "2026-01-01T00:00:00.000Z", event: "telemetry", payload: {} }), unknown);
    assert.equal(unknown.status, 400);
    assert.equal(JSON.parse(unknown.body).rejected, 1);
    assert.match(JSON.parse(unknown.body).error, /未知事件 telemetry/);

    // ② 认识的事件、形状不符的载荷（deliver 少了读方依赖的字段）。
    const badShape = createResponse();
    await handler(requestWith("POST", {
      at: "2026-01-01T00:00:00.000Z",
      event: "deliver",
      payload: { channel: "browser" }
    }), badShape);
    assert.equal(badShape.status, 400);
    assert.equal(JSON.parse(badShape.body).rejected, 2);
    assert.match(JSON.parse(badShape.body).error, /缺少 key/);

    // ③ 合法记录照常落盘，并带上产生它的构建（这里显式说是调试构建）。
    const accepted = createResponse();
    await handler(requestWith("POST", {
      at: "2026-01-01T00:00:00.000Z",
      event: "attach",
      payload: { hasSessionsList: true },
      build: "debug"
    }), accepted);
    assert.equal(accepted.status, 200);
    assert.equal(JSON.parse(accepted.body).ok, true);

    const lines = readLines(await readFile(diagnostics, "utf8"));
    // `host-ready` 由 effect 异步写出：顺序不保证，所以按事件名找，不依赖行号。
    const ready = lines.filter((line) => line.event === "host-ready");
    assert.equal(ready.length, 1);
    // Host 自己写的行也标注是谁写的（`host`）：审计时不会把 Host 的事实当成 Client 观测。
    assert.equal(ready[0].build, "host");
    const refused = lines.filter((line) => line.event === "diagnostics-rejected");
    assert.deepEqual(refused.map((line) => [line.payload.event, line.payload.rejected, line.build]),
      [["telemetry", 1, "host"], ["deliver", 2, "host"]]);
    assert.match(refused[0].payload.reason, /未知事件/);
    assert.match(refused[1].payload.reason, /缺少 key/);
    const stored = lines.find((line) => line.event === "client:attach");
    assert.deepEqual(stored.payload, { hasSessionsList: true });
    assert.equal(stored.build, "debug");
  });
});

test("host stays byte-compatible with an older client: no build field when none was reported", async () => {
  await withProfileDirectory(async (dir) => {
    const diagnostics = diagnosticsFile();
    const ctx = createHostContext();
    apply(ctx);

    const response = createResponse();
    await ctx.routes[0].handler(requestWith("POST", {
      at: "2026-01-01T00:00:00.000Z",
      event: "status",
      payload: STATUS_PAYLOAD
    }), response);
    assert.equal(response.status, 200);

    // 同样按事件名找记录（host-ready 是异步写的）。
    let lines = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        lines = readLines(await readFile(diagnostics, "utf8"));
        if (lines.some((line) => line.event === "client:status")) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stored = lines.find((line) => line.event === "client:status");
    assert.ok(stored !== undefined, `诊断文件里应有 client:status 记录（读到 ${lines.length} 行）`);
    // 既有 envelope 的字段与取值逐字节不变：没标注构建就不写这个字段（契约只向前加字段）。
    assert.deepEqual(Object.keys(stored), ["at", "event", "payload"]);
    assert.deepEqual(stored.payload, STATUS_PAYLOAD);
  });
});

test("两端诊断端点必须一致：客户端派生的路径 == Host 注册的路由", () => {
  // 这是本次排障暴露的盲区：客户端的默认插件 id 在 delivery/diagnostics-sink 各有一份，
  // Host 的 DIAGNOSTICS_PATH 是第三份，旧测试三处各测各的字面量。改名或漂移时，
  // 客户端会把记录发往一个不存在的路由，静默 404 —— 表现是"插件在工作，但诊断什么都没有"。
  // 这条断言把两端钉在一起。
  assert.equal(diagnosticsEndpoint(), DIAGNOSTICS_PATH);
  // 显式传当前包名也必须得到同一条路径（包名改了而路由没改就会在这里炸）。
  assert.equal(diagnosticsEndpoint("@cningan/dsh-session-reminder".replace("@cningan/", "")), DIAGNOSTICS_PATH);
});
