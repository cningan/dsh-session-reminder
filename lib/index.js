/**
 * Host half: the diagnostics sink for the browser-owned status surface.
 *
 * The Client half decides when a reminder is due; this half only *records* what
 * the Client observed — the shape of the session list/status sources, run edges,
 * the foreground test, and the delivery result — as JSONL under the profile
 * directory. A run can then be audited after the fact, without a debugger
 * attached to the renderer and without a human watching the window.
 *
 * @module @cningan/dsh-session-status
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const inject = ["webServer"];

export const DIAGNOSTICS_PATH = "/plugins/dsh-session-status/diagnostics";

/** Hard cap on a single reported record; reports are small and self-produced. */
export const DIAGNOSTICS_BODY_LIMIT = 64 * 1024;

/** Where the diagnostics JSONL lives: inside the active profile, never the plugin tarball. */
export function diagnosticsFile(env = process.env) {
  const base = env.DSH_PROFILE_DIR || env.DSH_HOME || ".";
  return join(base, ".dsh-session-status", "diagnostics.jsonl");
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
  const append = async (event, payload) => {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), event, payload })}\n`, "utf8");
  };

  // Written before any HTTP traffic: proves this half loaded and can write, which
  // separates "Host never ran" from "Client never reported".
  ctx.effect(() => {
    void append("host-ready", { route: DIAGNOSTICS_PATH, pid: process.pid }).catch((error) => {
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
        const { at, event, payload } = body ?? {};
        if (typeof event !== "string" || event === "") {
          sendJson(response, 400, { error: "event is required" });
          return;
        }
        await append(`client:${event}`, payload);
        sendJson(response, 200, { ok: true, at: at ?? null });
      } catch (error) {
        const tooLarge = error instanceof RangeError && /too large/.test(error.message);
        sendJson(response, tooLarge ? 413 : 400, { error: error?.message ?? String(error) });
      }
    }
  });

  ctx.effect(() => dispose, "dsh-session-status: diagnostics route");
}
