/**
 * 诊断上报 sink：Client 半边的**发送方**——事件名取自共享契约，记录用契约的
 * `createRecord` 造，落盘形状不再由调用点拼字符串。
 *
 * Client 半边把运行时的关键判定交给 Host 半边落盘（profile 下的 diagnostics.jsonl），
 * 用于事后审计「边沿是否被观察到 / 当时是否失焦 / 投递结果如何」。读方
 * `scripts/check-diagnostics.mjs` 依赖每行 `{"at":ISO,"event":"<name>","payload":{...}}`
 * （外加标明产生它的构建的 `build` 字段，见下），事件名在落盘时由 Host 加上 `client:`
 * 前缀（Host 自己另写 `host-ready`）。
 *
 * **词表与记录形状的 owner 是 `lib/diagnostics-contract.mjs`**（Host 落盘校验与读方
 * 解释也消费同一份）。本 module 因此只做三件事：
 *   1. 取词表（并把它转出，供投递层与装配层消费——调用点不散写字面量）；
 *   2. 上报本身：`report(event, payload)` 把一条记录交给 Host，**绝不抛**
 *      （缺 fetch、fetch 抛错、返回非 Promise 都当作「没上报」，提醒行为不受影响），
 *      记录在 envelope 里带上**产生它的构建**（`build`，见契约 module）；
 *   3. 边沿记录通道：`reportEdge(edge)` 把判定核心（`core/decide`）的只读边沿事实
 *      转成同形记录并上报。被抑制（列表行不在）与静默（用户取消、已显式移除）的
 *      停止边沿**没有提醒可投**，但读方需要「边沿被观察到、只是没有投递」这条证据，
 *      否则只能把「边沿被抑制」与「还没观察到边沿」混为一谈——这个通道就是为它留的。
 *
 * 路由约定：Host 半边把路由注册在 `/plugins/<包名>/diagnostics`（见 `lib/index.js` 的
 * `DIAGNOSTICS_PATH`）。`pluginId` 就是那个包名（可带 scope），endpoint 由它推导；
 * 需要覆盖时显式传 `endpoint`。
 */

import {
  CLIENT_BUILDS,
  DIAGNOSTIC_EVENTS,
  compileTimeBuild,
  createRecord
} from "../diagnostics-contract.mjs";

/** 词表转出：词表定义在 `lib/diagnostics-contract.mjs`，这里只是它的消费口。 */
export { DIAGNOSTIC_EVENTS };

const DEFAULT_PLUGIN_ID = "@cningan/dsh-session-status";

function defaultFetch() {
  try {
    return typeof fetch === "function" ? fetch : undefined;
  } catch {
    return undefined;
  }
}

/** 诊断路由：`/@scope/name` 与 `name` 都得到 `/plugins/name/diagnostics`。 */
export function diagnosticsEndpoint(pluginId = DEFAULT_PLUGIN_ID) {
  const id = typeof pluginId === "string" && pluginId !== "" ? pluginId : DEFAULT_PLUGIN_ID;
  return `/plugins/${id.slice(id.lastIndexOf("/") + 1)}/diagnostics`;
}

/**
 * pending 边沿的记录：只带上游交互子类（与既有 JSONL 同形）。
 * `noticeIndex` 与本记录无关——它只是装配层把边沿与提醒对上号的依据。
 */
function pendingEdgeRecord(edge) {
  return {
    sessionId: edge.sessionId,
    kind: "pending",
    interactionKind: edge.interactionKind ?? null
  };
}

/**
 * terminal 边沿的记录。两个分支的形状都与既有 JSONL 逐字段同形（含字段顺序）：
 *   - 被抑制（列表行不在）额外带 `suppressed: "missing-list-row"`，不带原因位；
 *   - 其余（已提醒、静默、选中会话被移除）都是 `suppressed: null`，带原因位。
 */
function terminalEdgeRecord(edge) {
  if (edge.suppressed === "missing-list-row") {
    return {
      sessionId: edge.sessionId,
      kind: "terminal",
      suppressed: "missing-list-row",
      isCurrent: edge.isCurrent === true
    };
  }
  return {
    sessionId: edge.sessionId,
    kind: "terminal",
    suppressed: null,
    isCurrent: edge.isCurrent === true,
    hasTurnEndReason: edge.hasTurnEndReason === true
  };
}

/**
 * 创建诊断上报 sink。
 *
 * 选项（都可缺省）：
 *   - `fetch`    注入的上报函数（缺省用全局 `fetch`；传 `null` 表示没有可用 fetch）
 *   - `now()`    时钟，只用于记录 `at`（缺省 `new Date()`）
 *   - `pluginId` 所属插件包名，用于推导默认路由
 *   - `endpoint` 显式路由，覆盖由 `pluginId` 推导出来的那一个
 *   - `build`    产生这些记录的构建（`production` / `debug`，见契约 module 的
 *                `CLIENT_BUILDS`）；缺省按构建期常量 `__DEBUG__` 算，因此**调用方不必
 *                记得传**——正式产物与调试构建因此不可能各自说错自己是谁
 *
 * 返回 `{ report(event, payload), reportEdge(edge) }`：两者都**不抛**。
 */
export function createDiagnosticsSink(options = {}) {
  const injectedFetch = options.fetch;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const endpoint = typeof options.endpoint === "string" && options.endpoint !== ""
    ? options.endpoint
    : diagnosticsEndpoint(options.pluginId);
  const build = typeof options.build === "string" && options.build !== "" ? options.build : compileTimeBuild();

  // fetch 在调用时解析：注入的优先，否则用当时的全局 fetch（浏览器/Node 都可能有，
  // 也可能都没有——没有就当没有上报能力）。
  const readFetch = () => (injectedFetch !== void 0 ? injectedFetch : defaultFetch());

  /** 上报一条记录。上报是诊断，绝不反过来影响提醒行为：任何失败都在这里被吞掉。 */
  function report(event, payload) {
    const send = readFetch();
    if (typeof send !== "function") return;
    try {
      const body = JSON.stringify(createRecord({ at: now().toISOString(), event, payload, build }));
      const result = send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true
      });
      if (result !== null && typeof result === "object" && typeof result.catch === "function") {
        result.catch(() => {});
      }
    } catch {
      // 上报失败（fetch 缺失/抛错/序列化失败）不影响提醒行为。
    }
  }

  /**
   * 上报一条边沿事实并返回落盘记录本身（装配层把它并进内存诊断，供设置区显示）。
   * 「事实 → 载荷」的映射由本 module 独占（判定核心给的是事实，不是线格式），
   * 载荷是否合法由契约 module 的 `PAYLOAD_SHAPES` 说了算。
   */
  function reportEdge(edge) {
    const fact = edge !== null && typeof edge === "object" ? edge : {};
    const record = fact.kind === "pending" ? pendingEdgeRecord(fact) : terminalEdgeRecord(fact);
    report(DIAGNOSTIC_EVENTS.EDGE, record);
    return record;
  }

  return { report, reportEdge };
}
