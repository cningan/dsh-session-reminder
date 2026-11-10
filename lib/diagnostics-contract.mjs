/**
 * 诊断契约（diagnostics contract）：**事件词表**、**载荷最小形状**与**记录 envelope**
 * 的唯一定义处。
 *
 * 同一条 wire 语义过去被三处各自理解：Client 上报（`client/diagnostics-sink` 的常量表）、
 * Host 原样落盘（无 schema，坏记录静默落盘）、读方 `scripts/check-diagnostics.mjs` 反过来
 * 重新推导语义。这个 module 把那份语义收成一个 owner，三方都消费它：
 *
 *   - **发送方**（`client/diagnostics-sink`、`client/delivery`）只取事件名，并用
 *     `createRecord` 造 envelope——落盘格式不再由调用点拼字符串；
 *   - **Host**（`lib/index.js`）落盘前用 `validateRecord` 校验：形状不符的记录**不再
 *     静默落盘**，而是拒绝、计数并写一条可观察的 `diagnostics-rejected` 事实；
 *   - **读方**（`scripts/check-diagnostics.mjs`）用 `bareEventName` 认事件，**只解释
 *     它认识的事件**，不认识的事件只出现在事件直方图里，不参与结论。
 *
 * 三条硬约束（都有测试盯着）：
 *   1. 落盘记录的 envelope 是 `{ at, event, payload, build }`，字段顺序固定；`build`
 *      是**唯一的新增字段**，既有字段与取值逐字节不变。
 *   2. 读方容忍未知字段：`build` 之外出现没见过的字段（旧读方读新记录、新读方读旧记录）
 *      都不算坏记录——契约只能向前加字段，不能改既有字段的含义。
 *   3. 落盘时的 `client:` 前缀规则只属 Host：Client 上报**裸事件名**，带前缀的名字是
 *      落盘后的形状（`storedEventName` / `bareEventName` 就是这条规则的唯一定义）。
 *
 * 为什么 `build` 在 envelope 上而不是 payload 里：它回答的是「这条记录是哪台观测仪器产生
 * 的」。历史上有正式与调试两种仪器（[ADR-0002](../docs/adr/0002-debug-capability-only-in-debug-build.md)），
 * 测试能力移出主插件后只剩一种构建（[ADR-0003](../docs/adr/0003-test-capability-lives-outside-the-plugin.md)）——
 * 字段与取值口径不变，审计时仍然先看自己在读哪一台。
 *
 * 这个 module 不 import 任何 Client / Host / Node 专有东西，因此三边都能消费它。
 */

/** Client 上报的事件名（**裸名**；Host 落盘时加 `client:` 前缀）。 */
export const DIAGNOSTIC_EVENTS = Object.freeze({
  /** 装载快照：Client 是否加载、拿到了哪些官方源、页面/权限/桥状态。 */
  ATTACH: "attach",
  /** 状态源摘要（内容变化才上报）：running 边沿到底有没有出现在官方快照里。 */
  STATUS: "status",
  /** 边沿记录：本轮观察到的运行/等待边沿（含只观察到、没有提醒的那一类）。 */
  EDGE: "edge",
  /** 投递尝试：渠道、结果与当时的权限/激活事实（含前台抑制那一次）。 */
  DELIVER: "deliver",
  /** 平台反馈：`onshow` / `onerror` / `onclose`。 */
  PLATFORM: "platform",
  /** 数据源形状不符：插件会直接放弃判定，读方据此给出 FAIL。 */
  SOURCE_SHAPE: "source-shape"
});

/** Host 半边自己写的事件名（**不加** `client:` 前缀：它们不是 Client 上报）。 */
export const HOST_EVENTS = Object.freeze({
  /** 加载标记：用来区分「Host 没跑」与「Client 没上报」。 */
  READY: "host-ready",
  /** 拒绝事实：一条上报因形状不符被拒绝（读方不解释它，只在直方图里看得见）。 */
  REJECTED: "diagnostics-rejected"
});

/** 事件词表（裸名，冻结）。 */
export const EVENT_NAMES = Object.freeze(Object.values(DIAGNOSTIC_EVENTS));

/** Host 落盘时给 Client 事件加的前缀。 */
export const CLIENT_EVENT_PREFIX = "client:";

/**
 * 产生记录的那台仪器是哪种构建。历史上有正式与调试两种；测试能力移出主插件后构建脚本
 * 不再定义 `__DEBUG__`，所以真实产物恒为 `PRODUCTION`，而 `DEBUG` 仍留给旧产物与历史记录
 * 的解释（读方认识这个取值）。
 */
export const CLIENT_BUILDS = Object.freeze({
  PRODUCTION: "production",
  DEBUG: "debug"
});

/** Host 自己写的记录没有 Client 构建可言：用这个名字标明「不是 Client 观测」。 */
export const HOST_BUILD = "host";

/** 平台生命周期事件名：只有 `onshow` / `onclose` 证明通知被平台显示过。 */
export const PLATFORM_EVENT_NAMES = Object.freeze(["onshow", "onerror", "onclose"]);

/**
 * 每种事件的载荷**最小形状**：
 *   - `required`  消费者（读方或测试服务）依赖的字段，必须存在；
 *   - `fields`    已知字段的取值类型，出现即校验（缺席容忍——契约只向前加字段）；
 *   - `enums`     取值被枚举化的字段；
 *   - `variants`  载荷随分支变化的事件（`edge` 按 `kind` 分叉）在此声明变体。
 *
 * 类型名是 `typeof` 的结果（`null` / `array` 单独成类），数组表示「允许其中任意一种」。
 * `required` 只收「读方拿不到就没法解释这条记录」的字段；`attach` 的字段读方一个都不用，
 * 所以它没有必填字段——但它的字段类型仍被校验（漂移会被拒绝），未知字段则按第 2 条约束容忍。
 */
export const PAYLOAD_SHAPES = Object.freeze({
  [DIAGNOSTIC_EVENTS.ATTACH]: Object.freeze({
    required: Object.freeze([]),
    fields: Object.freeze({
      hasSessionsList: Object.freeze(["boolean"]),
      hasSessionStatus: Object.freeze(["boolean"]),
      hasCurrentScope: Object.freeze(["boolean"]),
      // 「点通知能不能跳转」的能力位：官方 ui-workspace 服务在不在。
      hasWorkspaceOpen: Object.freeze(["boolean"]),
      // DSH 自身版本（`__DSH_BOOT__.release.version`）：读不到就是 null。
      dshVersion: Object.freeze(["string", "null"]),
      visibility: Object.freeze(["string"]),
      focused: Object.freeze(["boolean"]),
      browserPermission: Object.freeze(["string"]),
      nativeBridge: Object.freeze(["boolean"]),
      userActivation: Object.freeze(["object", "null"])
    })
  }),
  [DIAGNOSTIC_EVENTS.STATUS]: Object.freeze({
    required: Object.freeze(["statusEntries", "currentId", "currentInStatuses", "listHandlesCurrent", "runs"]),
    fields: Object.freeze({
      statusEntries: Object.freeze(["number"]),
      currentId: Object.freeze(["string", "null"]),
      currentInStatuses: Object.freeze(["boolean"]),
      listHandlesCurrent: Object.freeze(["boolean"]),
      runs: Object.freeze(["array"])
    })
  }),
  [DIAGNOSTIC_EVENTS.EDGE]: Object.freeze({
    discriminator: "kind",
    variants: Object.freeze({
      pending: Object.freeze({
        required: Object.freeze(["sessionId", "kind", "interactionKind"]),
        fields: Object.freeze({
          sessionId: Object.freeze(["string"]),
          kind: Object.freeze(["string"]),
          interactionKind: Object.freeze(["string", "null"])
        })
      }),
      terminal: Object.freeze({
        // `suppressed` 必须出现：读方靠 `suppressed != null` 区分「边沿被抑制」与「边沿被观察到」，
        // 缺席会被读成「没有抑制」，所以它是这条记录语义的一部分。
        required: Object.freeze(["sessionId", "kind", "suppressed"]),
        fields: Object.freeze({
          sessionId: Object.freeze(["string"]),
          kind: Object.freeze(["string"]),
          suppressed: Object.freeze(["string", "null"]),
          isCurrent: Object.freeze(["boolean"]),
          hasTurnEndReason: Object.freeze(["boolean"])
        })
      })
    })
  }),
  [DIAGNOSTIC_EVENTS.DELIVER]: Object.freeze({
    required: Object.freeze(["key", "channel", "delivered", "background"]),
    fields: Object.freeze({
      key: Object.freeze(["string"]),
      kind: Object.freeze(["string"]),
      // 停止原因（`core/classify` 的词表）：投递记录据此可审计「文案为什么是这一句」。
      reason: Object.freeze(["string", "null"]),
      sessionId: Object.freeze(["string", "null"]),
      channel: Object.freeze(["string"]),
      delivered: Object.freeze(["boolean"]),
      background: Object.freeze(["boolean"]),
      browserPermission: Object.freeze(["string"]),
      nativeBridge: Object.freeze(["boolean"]),
      userActivation: Object.freeze(["object", "null"])
    })
  }),
  [DIAGNOSTIC_EVENTS.PLATFORM]: Object.freeze({
    required: Object.freeze(["key", "event", "error"]),
    fields: Object.freeze({
      key: Object.freeze(["string"]),
      event: Object.freeze(["string"]),
      error: Object.freeze(["string", "null"])
    }),
    enums: Object.freeze({ event: PLATFORM_EVENT_NAMES })
  }),
  [DIAGNOSTIC_EVENTS.SOURCE_SHAPE]: Object.freeze({
    required: Object.freeze(["stage"]),
    fields: Object.freeze({
      stage: Object.freeze(["string"]),
      byIdType: Object.freeze(["string"]),
      snapshotKeys: Object.freeze(["array", "null"]),
      reason: Object.freeze(["string"])
    })
  })
});

/** 事件名是否在词表内（裸名）。 */
export function isKnownEvent(event) {
  return typeof event === "string" && EVENT_NAMES.includes(event);
}

/**
 * Host 落盘时的前缀规则：Client 上报的裸事件名 → 落盘名。
 * 已经带前缀的原样返回（幂等），非字符串原样返回。
 */
export function storedEventName(event) {
  if (typeof event !== "string" || event === "") return event;
  return event.startsWith(CLIENT_EVENT_PREFIX) ? event : `${CLIENT_EVENT_PREFIX}${event}`;
}

/**
 * 读方视角的逆规则：落盘的 Client 事件名 → 裸事件名。
 * **只认「带前缀且词表里有」的名字**：Host 自己写的行（`host-ready`）、没见过的名字
 * 都得到 `null`——读方据此「只解释它认识的事件」。
 */
export function bareEventName(storedEvent) {
  if (typeof storedEvent !== "string") return null;
  if (!storedEvent.startsWith(CLIENT_EVENT_PREFIX)) return null;
  const bare = storedEvent.slice(CLIENT_EVENT_PREFIX.length);
  return isKnownEvent(bare) ? bare : null;
}

/** 读方容错读取 `build`：不是非空字符串（没标注、旧记录、Host 行）就给 `null`。 */
export function readBuild(record) {
  const value = record !== null && typeof record === "object" ? record.build : undefined;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 当前 bundle 由哪种构建产生。
 *
 * 这条区分原本由构建期常量 `__DEBUG__`（esbuild `define`）给出，供「调试构建 vs 正式构建」
 * 的审计用；测试能力移出主插件后只剩一种构建，构建脚本不再定义它（[ADR-0003](../docs/adr/0003-test-capability-lives-outside-the-plugin.md)），
 * 因此真实产物恒报正式构建。`__DEBUG__` 为真的判定保留：旧调试产物与 Node 直测里显式定义
 * 它的场景，解释口径不变。
 */
export function compileTimeBuild() {
  try {
    return typeof __DEBUG__ !== "undefined" && __DEBUG__ === true
      ? CLIENT_BUILDS.DEBUG
      : CLIENT_BUILDS.PRODUCTION;
  } catch {
    return CLIENT_BUILDS.PRODUCTION;
  }
}

/**
 * 造一条规范 envelope：字段顺序固定为 `at` / `event` / `payload` / `build`。
 * `build` 缺省（不是非空字符串）就不写这个字段——旧记录、Host 自己写的记录都不带它，
 * 既有字段因此保持逐字节不变。
 */
export function createRecord({ at, event, payload, build } = {}) {
  const record = { at, event, payload };
  if (typeof build === "string" && build !== "") record.build = build;
  return record;
}

/** `typeof` 的取值，但把数组与 null 单独成类（`typeof [] === "object"` 太糊）。 */
function actualType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectProblems(shape, payload, label, problems) {
  for (const field of shape.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) problems.push(`${label} 缺少 ${field}`);
  }
  for (const [field, allowed] of Object.entries(shape.fields ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const type = actualType(payload[field]);
    if (!allowed.includes(type)) {
      problems.push(`${label}.${field} 期望 ${allowed.join("|")}，收到 ${type}`);
    }
  }
  for (const [field, values] of Object.entries(shape.enums ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    if (!values.includes(payload[field])) {
      problems.push(`${label}.${field} 只接受 ${values.join("/")}，收到 ${JSON.stringify(payload[field])}`);
    }
  }
}

/**
 * 校验一种事件的载荷最小形状。返回 `{ ok: true }` 或 `{ ok: false, reason }`
 * （`reason` 是给人看的一句话，可能含多条问题）。
 */
export function validatePayload(event, payload) {
  const shape = Object.prototype.hasOwnProperty.call(PAYLOAD_SHAPES, event) ? PAYLOAD_SHAPES[event] : undefined;
  if (shape === undefined) return { ok: false, reason: `未知事件 ${JSON.stringify(event)}：不在词表内` };
  if (!isPlainObject(payload)) return { ok: false, reason: `${event}: payload 必须是对象` };

  const problems = [];
  if (shape.variants !== void 0) {
    const value = payload[shape.discriminator];
    const variant = typeof value === "string" ? shape.variants[value] : undefined;
    if (variant === undefined) {
      return {
        ok: false,
        reason: `${event}: ${shape.discriminator} 必须是 ${Object.keys(shape.variants).join(" / ")} 之一，`
          + `收到 ${JSON.stringify(value)}`
      };
    }
    collectProblems(variant, payload, `${event}[${value}]`, problems);
  } else {
    collectProblems(shape, payload, event, problems);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, reason: problems.join("；") };
}

/**
 * 校验一条 **Client 上报记录**（envelope + 事件词表 + 载荷最小形状）。
 *
 * 这是 Host 落盘前的闸门：`{ ok: true, event, payload }` 才落盘，
 * 否则 `{ ok: false, reason }`——Host 拒绝并记录这条事实，不再静默写入。
 * envelope 里未声明的字段（契约向前加字段，例如读方不认识的 `build` 之外的东西）容忍通过。
 */
export function validateRecord(record) {
  if (!isPlainObject(record)) return { ok: false, reason: "记录必须是对象" };
  const { event, at, payload } = record;
  if (typeof event !== "string" || event === "") return { ok: false, reason: "event 必须是非空字符串" };
  if (event.startsWith(CLIENT_EVENT_PREFIX)) {
    return { ok: false, reason: `event 必须是裸事件名（${CLIENT_EVENT_PREFIX} 前缀由 Host 落盘时加）` };
  }
  if (!isKnownEvent(event)) return { ok: false, reason: `未知事件 ${event}：不在词表内，Host 不再静默落盘` };
  if (typeof at !== "string" || at === "" || Number.isNaN(Date.parse(at))) {
    return { ok: false, reason: "at 必须是可解析的 ISO 时间字符串" };
  }
  if (record.build !== void 0 && (typeof record.build !== "string" || record.build === "")) {
    return { ok: false, reason: "build 必须是非空字符串" };
  }
  const shape = validatePayload(event, payload);
  if (!shape.ok) return shape;
  return { ok: true, event, payload };
}
