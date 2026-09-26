import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply, DIAGNOSTICS_PATH, diagnosticsFile } from "../lib/index.js";

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
  const dir = await mkdtemp(join(tmpdir(), "dsh-session-status-"));
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
    assert.equal(diagnostics, join(dir, ".dsh-session-status", "diagnostics.jsonl"));

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
