/**
 * Host half: the diagnostics sink for the browser-owned status surface.
 *
 * The Client half decides when a reminder is due; this half only *records* what
 * the Client observed — the shape of the session list/status sources, run edges,
 * the foreground test, and the delivery result — as JSONL under the profile
 * directory. A run can then be audited after the fact, without a debugger
 * attached to the renderer and without a human watching the window.
 *
 * This half is the **gate** of the diagnostics contract
 * (`lib/diagnostics-contract.mjs`, shared with the Client sender and the reader):
 * a report whose envelope or payload shape does not match the vocabulary is
 * refused instead of silently appended. Refusals are observable twice — a 400
 * response carrying the running refusal count, and a `diagnostics-rejected`
 * record in the same JSONL (which the reader counts but does not interpret).
 *
 * @module @cningan/dsh-session-status
 */
import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  HOST_BUILD,
  HOST_EVENTS,
  createRecord,
  readBuild,
  storedEventName,
  validateRecord
} from "./diagnostics-contract.mjs";

export const inject = ["webServer"];

export const DIAGNOSTICS_PATH = "/plugins/dsh-session-status/diagnostics";

/** Hard cap on a single reported record; reports are small and self-produced. */
export const DIAGNOSTICS_BODY_LIMIT = 64 * 1024;

/** Where the diagnostics JSONL lives: inside the active profile, never the plugin tarball. */
export function diagnosticsFile(env = process.env) {
  const base = env.DSH_PROFILE_DIR || env.DSH_HOME || ".";
  return join(base, ".dsh-session-status", "diagnostics.jsonl");
}

/**
 * 本插件自身的版本（同包根的 `package.json`）。
 *
 * 写进 `host-ready`：诊断里因此同时有「Host 跑的是插件哪个版本」与「Client 连的是 DSH
 * 哪个版本」（后者见 `client:attach` 的 `dshVersion`）。兼容问题不必再靠猜——例如
 * 「0.2.2 换了事件窗口形状，而用户装的是 0.3.1」这件事，事后读 JSONL 就能看出来。
 * 读不到就是不写这个字段（旧产物、被裁剪的安装），不猜版本号。
 */
export function pluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : null;
  } catch {
    return null;
  }
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > DIAGNOSTICS_BODY_LIMIT) throw new RangeError("diagnostics body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

export function apply(ctx) {
  const file = diagnosticsFile();
  /** 落盘一条记录：envelope 由契约 module 造（字段顺序固定），记录自己是哪台仪器写的。 */
  const append = async (event, payload, build) => {
    await mkdir(dirname(file), { recursive: true });
    const record = createRecord({ at: new Date().toISOString(), event, payload, build });
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  };
  // 被拒绝的上报条数：随每次拒绝递增，既进 400 响应体，也进 diagnostics-rejected 记录。
  // 「坏记录不再静默落盘」因此是可观察、可断言的事实，而不是一句注释。
  let rejected = 0;

  // Written before any HTTP traffic: proves this half loaded and can write, which
  // separates "Host never ran" from "Client never reported".
  ctx.effect(() => {
    const payload = { route: DIAGNOSTICS_PATH, pid: process.pid };
    const version = pluginVersion();
    if (version !== null) payload.version = version;
    void append(HOST_EVENTS.READY, payload, HOST_BUILD)
      .catch((error) => {
        ctx.logger?.warn("dsh-session-status: diagnostics sink unavailable: %s", error?.message ?? String(error));
      });
  }, "dsh-session-status: diagnostics ready marker");

  const dispose = ctx.webServer.register({
    kind: "exact",
    path: DIAGNOSTICS_PATH,
    handler: async (request, response) => {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "method not allowed" });
        return;
      }
      try {
        const body = JSON.parse(await readBody(request));
        // 落盘前的闸门：envelope + 事件词表 + 载荷最小形状（契约 module 是唯一定义处）。
        const verdict = validateRecord(body);
        if (!verdict.ok) {
          rejected += 1;
          await append(HOST_EVENTS.REJECTED, {
            // 原样记下收到的那个名字（可能是 `client:` 前缀过的、词表外的、甚至不是字符串）。
            event: body !== null && typeof body === "object" && typeof body.event === "string" ? body.event : null,
            reason: verdict.reason,
            rejected,
            build: readBuild(body)
          }, HOST_BUILD);
          sendJson(response, 400, { error: verdict.reason, rejected });
          return;
        }
        await append(storedEventName(verdict.event), verdict.payload, readBuild(body));
        const { at } = body ?? {};
        sendJson(response, 200, { ok: true, at: at ?? null });
      } catch (error) {
        const tooLarge = error instanceof RangeError && /too large/.test(error.message);
        sendJson(response, tooLarge ? 413 : 400, { error: error?.message ?? String(error) });
      }
    }
  });

  ctx.effect(() => dispose, "dsh-session-status: diagnostics route");
}
