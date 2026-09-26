/**
 * 归一化层（纯 module）：官方快照片段 → 领域快照，以及「这个页面现在是否在前台」的
 * **唯一**判定。
 *
 * 入参一律是官方来源的**快照片段**（列表行、全会话状态映射、选中会话详情、宿主页面
 * 替身），出参是判定核心与诊断展示消费的领域值。本 module 不订阅任何源、不持有状态、
 * 不打印、不碰时钟——装配层只负责「读官方源 → 调这里 → 喂 decider」。
 *
 * 为什么必须集中在这一个 module：
 *   - **承重前置条件只有一份实现**：整条插件的不变式「仅在前台之外投递」依赖
 *     `readPageState` 对宿主页面的读取。过去装配层与设置区各写了一份等价表达式
 *     （今天恰好一致，但没有任何机制维持一致：UI 可能显示「失焦判定 否」，而真正
 *     决定投递的是另一个表达式）。现在只有这里读页面可见性/焦点，调用方拿到的
 *     是**值**（`{ visibility, focused, background }`）。
 *   - **归一化可直测**：标题回退链与错误详情抽取过去只写在装配层的闭包里，没有任何
 *     直测能断言它们（装配层的 `vm` 集成测试只保留端到端链路）。搬到这里以后，
 *     每一条分支都能用纯输入直测（见 `test/normalize.test.mjs`）。
 *
 * 领域形状与判定核心的契约见 `core/decide` 的文件头：`titleOf` 出标题、`normalizeSessions`
 * 出 `sessions[]`、`normalizeCurrent` 出 `current`，`detailShapeOf` 出 `current.detail`。
 *
 * 本 module 还是**归属过滤**（哪个会话参与提醒）的唯一实现处：`normalizeSessions` 只把
 * 父/普通会话放进领域快照，子代理会话根本不进入判定（见 `isSubagentSession` 与 SPEC 的
 * 「提醒范围只覆盖父/普通会话」）。
 */

/** 宿主页面替身缺省来源：没有浏览器全局时（Node 直测）返回 null。 */
function defaultDocument() {
  try {
    return typeof document === "undefined" ? null : document;
  } catch {
    return null;
  }
}

/**
 * **前台判定**：整条插件唯一读宿主页面可见性/焦点的地方。
 *
 * 返回 `{ visibility, focused, background }`——三者是同一次读取的三个面：
 *   - `visibility` 官方 `document.visibilityState`（读不到/形状不符为 null）
 *   - `focused`    官方 `document.hasFocus()` 的原样结果（没有该函数为 null）
 *   - `background` 「现在是否在前台之外」的唯一答案：页面隐藏，或明确失焦
 *
 * `background` 是唯一被投递判定消费的那一位：它既决定一条自动提醒投不投，也原样进入
 * 投递诊断记录与上报请求体——判定与「诊断行显示的那个值」因此不可能分叉。
 * 没有宿主页面（Node 直测/非浏览器环境）时不是前台之外的结论（`background: false`），
 * 前台抑制照旧由调用方的策略决定。
 */
export function readPageState(documentLike = defaultDocument()) {
  const doc = documentLike;
  if (doc === null || doc === undefined) return { visibility: null, focused: null, background: false };
  let visibility = null;
  try {
    if (typeof doc.visibilityState === "string") visibility = doc.visibilityState;
  } catch {
    visibility = null;
  }
  let focused = null;
  try {
    if (typeof doc.hasFocus === "function") focused = doc.hasFocus();
  } catch {
    focused = null;
  }
  return { visibility, focused, background: visibility === "hidden" || focused === false };
}

/**
 * 标题三段回退：`displayTitle` → `title` → `sessionId`。
 * 非字符串与空串一律继续回退（官方行可能只有 id 可用）。
 */
export function titleOf(row, sessionId) {
  if (typeof row?.displayTitle === "string" && row.displayTitle !== "") return row.displayTitle;
  if (typeof row?.title === "string" && row.title !== "") return row.title;
  return sessionId;
}

/**
 * 官方会话详情快照 → 领域详情形状（只抽 `classifyDetail` 消费的字段）：
 * `lastAgentError` / `promptError.error.{code,message}` / `openState` / `openError.{code,message}`。
 * 形状不符（null / 非对象）时返回 `undefined`：判定核心对 undefined 无话可说。
 */
export function detailShapeOf(snapshot) {
  if (snapshot === null || typeof snapshot !== "object") return undefined;
  const errorPair = (error) => (error !== null && typeof error === "object"
    ? { code: error.code ?? null, message: error.message ?? null }
    : null);
  const promptError = snapshot.promptError;
  return {
    lastAgentError: snapshot.lastAgentError ?? null,
    promptError: promptError !== null && typeof promptError === "object"
      ? { error: errorPair(promptError.error) }
      : null,
    openState: snapshot.openState ?? null,
    openError: errorPair(snapshot.openError)
  };
}

/**
 * **归属过滤**：这一行是不是子代理会话？是则它不参与提醒（SPEC「提醒范围只覆盖
 * 父/普通会话」）。
 *
 * 判据唯一：官方会话列表行上的 `origin`。它是会话 header 的**闭集**标记——上游只允许
 * `"subagent"` 或缺席（`SessionHeader.origin?: 'subagent'`），父/普通会话该字段不存在；
 * Client 侧由 session controller 的列表投影把它原样搬到 `byId[id].origin`，子代理目录/
 * 已 retain 的子会话更由投影直接写死 `"subagent"`。因此 `origin === "subagent"` 是契约，
 * 不是启发式。
 *
 * **不能用 `parentId` / `parentSession` 代替**：fork 出来的会话共享血缘字段却没有 `origin`，
 * 它是独立的普通会话（上游 `@deepseek-ai/dsh-subagent` 的原话是「A fork shares the lineage
 * field without the origin and is an independent conversation」）。按血缘过滤会把用户的
 * fork 会话一起误伤。同理，会话 id 的形态（`session-<uuid>` vs 裸 uuid）只是巧合。
 *
 * 形状不符（没有列表行、非对象、`origin` 是别的值）一律**不**过滤——判据只有严格等于
 * `"subagent"` 这一个取值，"认不出来"必须落回既有行为，而不是把会话悄悄丢掉。
 */
export function isSubagentSession(row) {
  return row !== null && typeof row === "object" && row.origin === "subagent";
}

/**
 * 官方两条来源（列表行 `sessions.list.byId` + 全会话状态映射 `uiSession.sessionStatus`）
 * → 领域会话快照数组。顺序即状态映射的顺序。
 *
 *   - **归属过滤**：`origin === "subagent"` 的行**不产出领域会话**（见 `isSubagentSession`），
 *     因此它既没有任何等待/停止提醒，也没有任何边沿记录——判定核心从来没见过它。
 *     「没有边沿」正是它被归属过滤跳过的签名；诊断读方另有状态源摘要里的 `origin` 标注
 *     （装配层的 `status` 上报）把「按归属跳过」与「还没观察到边沿」区分开。
 *   - `inList`：列表快照里有没有这一行——停止边沿据此抑制（可能是归档/移除）。
 *   - `pending`：**原样带走同一个交互对象**（等待边沿按对象同一性判断，不得在此复制或
 *     改写）；没有等待时是 `null`。
 *   - `unread`（官方 completionUnread）只忠实反映上游未读标记，不参与判定。
 *
 * 列表行缺失（形状不符）时按「没有列表行」处理，标题退回 `sessionId`；状态源不可迭代
 * 时返回空数组（调用方本来就会先校验形状并上报 `source-shape`）。
 */
export function normalizeSessions(byId, statuses) {
  const rows = byId !== null && typeof byId === "object" ? byId : {};
  const sessions = [];
  if (statuses === null || statuses === undefined || typeof statuses[Symbol.iterator] !== "function") {
    return sessions;
  }
  for (const [sessionId, status] of statuses) {
    const row = rows[sessionId];
    // 归属过滤：子代理会话在这里被丢掉，不入领域快照（更不会进入判定核心的 runs/edges 记账）。
    if (isSubagentSession(row)) continue;
    sessions.push({
      id: sessionId,
      title: titleOf(row, sessionId),
      running: status?.running === true,
      pending: status?.pendingInteraction ?? null,
      unread: status?.completionUnread === true,
      inList: row !== void 0
    });
  }
  return sessions;
}

/**
 * 选中会话的领域 `current` 段：`removed`（官方显式移除标记，真 = 归档/移除而不是停止）、
 * `turnEnd`（`turn/end` 的原始原因对象，原样交给 `classifyTurnEnd`）与已抽取的详情形状。
 * 没有绑定选中会话时由调用方给 `undefined`（判定核心据此把停止当成通用原因处理）。
 */
export function normalizeCurrent(detail, turnEnd) {
  return {
    removed: detail !== null && typeof detail === "object" ? detail.removed === true : false,
    turnEnd,
    detail: detailShapeOf(detail)
  };
}
