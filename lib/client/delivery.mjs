/**
 * 投递层：**有序的渠道 adapter 序列** + 能力/权限的**单一来源**。
 *
 * 它**不含判定语义**：既不知道「该不该提醒」（判定在 `core/decide`），也不知道
 * 「页面是否在前台」（前台否决留在装配层）。调用者把一条已经决定要投的提醒交给它，
 * 它按序列投递并回报。
 *
 * **渠道是 adapter**，每一项自己声明三件事：
 *   - `available(ctx)` 这个渠道**现在**能不能投——只读派生出来的能力值
 *     （`ctx.capability.channels[<id>]`），不自己猜桥的形状；
 *   - `send(ctx)`      投出去的结果：`accepted` / `rejected`（带错误）/ `unavailable`；
 *   - `results`        结果落到调用方的结论（`channel` + `outcome`），
 *                      分 `accepted` / `rejected` / `unavailable` 三态。
 * 顺序与回退由序列驱动（`runDeliveryChain`）：`shell` → `webview` → `browser`。
 * 前两个是原生桥（可回退：抛错后还有后续渠道，所以计入 `errors`/`fellBack`），
 * 最后一个是**终局渠道**：它负责「无渠道」这一说法的具体措辞
 * （`browser-<权限>` / `browser-unsupported` / `browser-error`）。
 *
 * **能力/权限只有一个来源**：`readCapabilities()` 一次回答「现在有哪些渠道可用」
 * （桥的形状宣称、已被证明抛错、浏览器权限、用户激活，以及面向调用方的那一问）。
 * 一次投递只派生一次，那个值同时喂给可用性判定、结果与上报体——所以「记录里写的」
 * 不可能与「决策用的」分叉；权限请求与模型快照读的那一问（`permission()`）走的也是同一个
 * 派生函数，不是另一份等价表达式。
 *
 * 副作用出口只有两个，都是注入的（缺省 no-op，投递照常工作、绝不因上报失败而中断）：
 *   - `report(event, payload)`  诊断 sink：`deliver`（每次投递尝试）与 `platform`（平台反馈）
 *                              事件名取自共享契约 `lib/diagnostics-contract.mjs`（不在这里
 *                              散写字面量，也不经上报层转手）
 *   - `onPlatform(feedback)`    平台事件回灌给调用方（onshow / onerror / onclose）
 *
 * 前台否决与投递去重记账（`deliveredKeys`）留在装配层：那是「该不该投」的决定，
 * 不属于「怎么投」。
 *
 * ADR-0001：通知参数**绝不设置** `requireInteraction`，`tag` 逐条唯一且短（`dshss-N`）。
 */

import { DIAGNOSTIC_EVENTS } from "../diagnostics-contract.mjs";

/** 投递结果的渠道状况（显式枚举，不要按 channel 字符串反推）。 */
export const DELIVERY_OUTCOMES = Object.freeze({
  /** 已交给原生桥（workbench shell 或 WebView）。 */
  NATIVE_BRIDGE: "native-bridge",
  /** 已交给浏览器 Notification API（构造未抛错）。 */
  BROWSER: "browser",
  /** 没有任何可用渠道。 */
  NO_CHANNEL: "no-channel",
  /** 浏览器 API 存在，但构造抛错。 */
  BROWSER_ERROR: "browser-error"
});

/** 渠道 id：序列里每个 adapter 的身份，也是错误表里的渠道名。 */
export const CHANNEL_IDS = Object.freeze({
  SHELL: "shell",
  WEBVIEW: "webview",
  BROWSER: "browser"
});

/** 单个 adapter 的投递结果（渠道自己的话，与面向调用方的 `DELIVERY_OUTCOMES` 分开）。 */
export const ADAPTER_RESULTS = Object.freeze({
  /** 渠道接住了。 */
  ACCEPTED: "accepted",
  /** 渠道在，但拒绝/抛错：记一次错误并交给后续渠道。 */
  REJECTED: "rejected",
  /** 渠道现在不可用（没能力 / 权限没给 / API 不存在）：不记错误，交给后续渠道。 */
  UNAVAILABLE: "unavailable"
});

/**
 * 通知 tag 前缀。tag 必须短：Windows toast 对 tag 长度敏感，把会话 id 拼进去
 * （曾达 94 字符）会导致通知被平台丢弃（ADR-0001）。
 */
export const TAG_PREFIX = "dshss";

const DEFAULT_PLUGIN_ID = "dsh-session-reminder";

function defaultWindow() {
  try {
    return typeof window !== "undefined" ? window : undefined;
  } catch {
    return undefined;
  }
}

function defaultNotificationCtor() {
  try {
    return typeof Notification !== "undefined" ? Notification : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 用户激活状态：Chromium 的 sticky activation（`hasBeenActive`）在页面刷新后重置，
 * 若平台对"从未被用户激活的页面"丢弃通知，它能解释"探针能弹、自动通知不弹"。
 */
export function readUserActivation() {
  try {
    const activation = typeof navigator !== "undefined" ? navigator.userActivation : void 0;
    if (activation === void 0 || activation === null) return null;
    return {
      active: activation.isActive === true,
      everActive: activation.hasBeenActive === true
    };
  } catch {
    return null;
  }
}

/** workbench shell 桥是否**在形状上**宣称能通知（这只是宣称，静默无操作无法由形状看出）。 */
function shellClaimsNotify(windowLike) {
  try {
    const shell = windowLike !== null && windowLike !== undefined ? windowLike.dshShell : void 0;
    return shell !== void 0 && typeof shell.notify === "function";
  } catch {
    return false;
  }
}

/** WebView 桥是否在形状上宣称能通知。 */
function webviewClaimsPostMessage(windowLike) {
  try {
    const webview = windowLike !== null && windowLike !== undefined ? windowLike.chrome?.webview : void 0;
    return webview !== void 0 && typeof webview.postMessage === "function";
  } catch {
    return false;
  }
}

/** 原生桥是否存在（只看形状宣称，不看上次是否抛错）。 */
export function hasNativeBridge(windowLike = defaultWindow()) {
  return shellClaimsNotify(windowLike) || webviewClaimsPostMessage(windowLike);
}

/** 浏览器通知权限：`granted` / `default` / `denied`，没有 Notification API 时为 `unsupported`。 */
export function readBrowserPermission(notificationCtor = defaultNotificationCtor()) {
  if (notificationCtor === void 0 || notificationCtor === null) return "unsupported";
  try {
    return notificationCtor.permission || "default";
  } catch {
    return "unsupported";
  }
}

/**
 * 「现在有哪些渠道可用」的**唯一**回答处——权限与桥状态的派生只在这里发生。
 *
 * 选项（与 `createDelivery` 同一套约定，都可缺省）：
 *   - `window`            桥的宿主；传 `null` 表示没有 window，缺省读全局
 *   - `notificationCtor`  浏览器 Notification 构造器；传 `null` 表示没有该 API，缺省读全局
 *   - `bridgeFailed`      投递侧的事实：原生桥是否**已被证明**抛错（形状宣称看不出来）
 *
 * 返回冻结的值：
 *   - `nativeBridge` / `bridgeFailed` / `browserPermission` / `browserApi` / `userActivation`
 *   - `permission`  面向调用方的那一问：有可用原生桥（且没被证伪）就是 `native`，
 *                   否则是浏览器权限（含 `unsupported`）
 *   - `channels`    逐渠道的可用性：`claimed` 是**形状宣称**（`dshShell.notify` /
 *                   `chrome.webview.postMessage` / Notification API 在不在），
 *                   `available` 是这一轮能不能投；adapter 只读它，不自己碰宿主对象
 */
export function readCapabilities(options = {}) {
  const windowLike = options.window !== void 0 ? options.window : defaultWindow();
  const notificationCtor = options.notificationCtor !== void 0
    ? options.notificationCtor
    : defaultNotificationCtor();
  const shell = shellClaimsNotify(windowLike);
  const webview = webviewClaimsPostMessage(windowLike);
  const browserApi = notificationCtor !== void 0 && notificationCtor !== null;
  const browserPermission = readBrowserPermission(notificationCtor);
  const bridgeFailed = options.bridgeFailed === true;
  const nativeBridge = shell || webview;

  return Object.freeze({
    nativeBridge,
    bridgeFailed,
    browserApi,
    browserPermission,
    userActivation: readUserActivation(),
    permission: nativeBridge && !bridgeFailed ? "native" : browserPermission,
    channels: Object.freeze({
      [CHANNEL_IDS.SHELL]: Object.freeze({ available: shell, claimed: shell, kind: "bridge" }),
      [CHANNEL_IDS.WEBVIEW]: Object.freeze({ available: webview, claimed: webview, kind: "bridge" }),
      [CHANNEL_IDS.BROWSER]: Object.freeze({
        available: browserApi && browserPermission === "granted",
        claimed: browserApi,
        kind: "browser"
      })
    })
  });
}

/** 结论条目可以是值，也可以是 `(ctx) => 值`（不可用时的话依赖当时的权限）。 */
function resolveVerdict(value, ctx) {
  if (value === undefined || value === null) return null;
  return typeof value === "function" ? value(ctx) : value;
}

/**
 * 造**有序**的渠道 adapter 序列：`shell` → `webview` → `browser`。
 *
 * `deps` 是渠道做副作用所需的注入物（都由 `createDelivery` 提供，也可在直测里替身）：
 *   `readWindow()` / `readNotification()` / `pluginId` / `nextTag()` /
 *   `onError(label, error)` / `openSession(id)` / `report(event, payload)` / `onPlatform(feedback)`
 *
 * 每个 adapter 也因此可以**单独**测：喂一份 capability 值就能断言它的可用性与三种结果，
 * 不必重建假浏览器。
 */
export function createChannelAdapters(deps) {
  const pluginId = typeof deps.pluginId === "string" && deps.pluginId !== "" ? deps.pluginId : DEFAULT_PLUGIN_ID;
  const nativePayload = (notice) => ({
    type: `${pluginId}/notify`,
    kind: notice.kind,
    title: notice.title,
    message: notice.message
  });

  /** 原生桥的公共形状：可用性读能力值，`send` 只负责把载荷交出去（抛错即被拒）。 */
  const bridgeAdapter = (id, errorLabel, deliverToBridge) => ({
    id,
    kind: "bridge",
    // 抛错后还有后续渠道：这一笔计入 `errors`/`fellBack`。
    fallback: true,
    errorLabel,
    available: (ctx) => ctx.capability.channels[id].available === true,
    send: (ctx) => {
      deliverToBridge(deps.readWindow(), nativePayload(ctx.notice));
      return { result: ADAPTER_RESULTS.ACCEPTED };
    },
    results: {
      accepted: { channel: "native-bridge", outcome: DELIVERY_OUTCOMES.NATIVE_BRIDGE },
      // 桥被拒/桥不在都给不出结论：交给序列里的下一个渠道（最后是浏览器那一支）。
      rejected: null,
      unavailable: null
    }
  });

  /** 平台反馈：既上报 sink，也回灌调用方（调用方据此更新自己的诊断显示）。 */
  const markPlatform = (notice, event, error) => {
    deps.report(DIAGNOSTIC_EVENTS.PLATFORM, { key: notice.key, event, error: error === void 0 ? null : error });
    deps.onPlatform({ key: notice.key, kind: notice.kind, event, error });
  };

  const browser = {
    id: CHANNEL_IDS.BROWSER,
    kind: "browser",
    // 终局渠道：抛错就是这一轮的结果（browser-error），不是「回退到下一个」。
    fallback: false,
    errorLabel: "system notification failed",
    available: (ctx) => ctx.capability.channels[CHANNEL_IDS.BROWSER].available === true,
    send: (ctx) => {
      const notice = ctx.notice;
      const system = new (deps.readNotification())(notice.title, {
        body: notice.message,
        // tag 必须短且唯一：见 TAG_PREFIX 与 ADR-0001。
        tag: deps.nextTag(),
        renotify: true,
        silent: false
      });
      system.onclick = () => {
        try {
          if (notice.sessionId !== void 0) deps.openSession(notice.sessionId);
        } catch (error) {
          deps.onError("could not open session", error);
        }
        try {
          const win = deps.readWindow();
          if (win !== void 0 && win !== null) win.focus();
        } catch {}
        try {
          system.close();
        } catch {}
      };
      // 平台反馈：onshow 证明通知真的被平台显示过，onerror 说明提交失败，
      // onclose 说明它显示过（只有显示过的通知才会 close）。这是区分
      // "API 调用成功但没呈现" 与 "呈现了但用户没看到" 的关键证据。
      system.onshow = () => markPlatform(notice, "onshow");
      system.onerror = (event) => markPlatform(notice, "onerror", String(event?.error ?? "unknown"));
      system.onclose = () => markPlatform(notice, "onclose");
      return { result: ADAPTER_RESULTS.ACCEPTED };
    },
    results: {
      accepted: { channel: "browser", outcome: DELIVERY_OUTCOMES.BROWSER },
      // 终局拒绝：调用方拿到的是「浏览器 API 抛错」，而不是「没有渠道」。
      rejected: { channel: "browser-error", outcome: DELIVERY_OUTCOMES.BROWSER_ERROR },
      // 终局不可用：这一轮没有任何渠道，措辞由这里给出（权限未授予 / 没有 API）。
      unavailable: (ctx) => ({
        channel: `browser-${ctx.capability.browserPermission}`,
        outcome: DELIVERY_OUTCOMES.NO_CHANNEL
      })
    }
  };

  return [
    bridgeAdapter(CHANNEL_IDS.SHELL, "shell notification failed", (win, payload) => win.dshShell.notify(payload)),
    bridgeAdapter(CHANNEL_IDS.WEBVIEW, "WebView notification failed", (win, payload) => win.chrome?.webview.postMessage(payload)),
    browser
  ];
}

/**
 * 跑一遍有序 adapter 序列，得到这一轮投递的结果。
 *
 * `ctx` 至少要带 `{ notice, capability, onError }`；序列的每一项自己决定回退：
 *   - 不可用的渠道跳过，并把它给出的「没有渠道」结论（若有）记为候选；
 *   - 可用就投：`accepted` 立即收工；`rejected` 记一笔错误（只有声明可回退的渠道才计入）
 *     并继续；`unavailable` 继续；
 *   - 全部走完后用最后一个候选结论收口（终局渠道的措辞优先）。
 *
 * 返回值：`{ delivered, adapter, channel, outcome, errors, consulted }`。
 * 抛错被当作 `rejected`：渠道的犹豫不该炸穿调用方的提醒路径。
 */
export function runDeliveryChain(adapters, ctx) {
  const errors = [];
  const consulted = [];
  let verdict = null;

  for (const adapter of adapters) {
    consulted.push(adapter.id);
    if (adapter.available(ctx) !== true) {
      verdict = resolveVerdict(adapter.results?.unavailable, ctx) ?? verdict;
      continue;
    }

    let outcome;
    try {
      outcome = adapter.send(ctx) ?? {};
    } catch (error) {
      outcome = { result: ADAPTER_RESULTS.REJECTED, error };
    }
    const result = outcome.result ?? ADAPTER_RESULTS.REJECTED;

    if (result === ADAPTER_RESULTS.ACCEPTED) {
      const accepted = resolveVerdict(adapter.results?.accepted, ctx) ?? {};
      return { delivered: true, adapter, channel: accepted.channel, outcome: accepted.outcome, errors, consulted };
    }
    if (result === ADAPTER_RESULTS.UNAVAILABLE) {
      verdict = resolveVerdict(outcome.verdict ?? adapter.results?.unavailable, ctx) ?? verdict;
      continue;
    }
    // rejected：渠道自己的话（可回退的渠道才计入错误表），然后交给后续渠道。
    if (outcome.error !== void 0) ctx.onError(adapter.errorLabel, outcome.error);
    if (adapter.fallback === true) errors.push({ channel: adapter.id, error: outcome.error });
    verdict = resolveVerdict(adapter.results?.rejected, ctx) ?? verdict;
  }

  return {
    delivered: false,
    adapter: null,
    errors,
    consulted,
    channel: verdict?.channel ?? "none",
    outcome: verdict?.outcome ?? DELIVERY_OUTCOMES.NO_CHANNEL
  };
}

/**
 * 创建投递实例。它自己持有投递侧的状态：原生桥是否已被证明不可用（`bridgeFailed`）
 * 与通知 tag 序号——两者都是「投递」的事实，与判定无关。
 *
 * 选项（都可缺省，缺省即浏览器/Node 里的全局对象与 no-op sink）：
 *   - `report(event, payload)`   诊断 sink
 *   - `onPlatform(feedback)`     平台事件回灌（`{ key, kind, event, error }`）
 *   - `now()`                    时钟，只用于回报投递时刻
 *   - `notificationCtor`         浏览器 Notification 构造器（传 null 表示不存在）
 *   - `window`                   桥与 `focus()` 的宿主（传 null 表示没有 window）
 *   - `openSession(sessionId)`   点击浏览器通知时打开会话
 *   - `onError(label, error)`    投递失败日志（缺省走 console.error）
 *   - `pluginId`                 原生桥载荷的 `type` 前缀
 */
export function createDelivery(options = {}) {
  const report = typeof options.report === "function" ? options.report : () => {};
  const onPlatform = typeof options.onPlatform === "function" ? options.onPlatform : () => {};
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const openSession = typeof options.openSession === "function" ? options.openSession : () => {};
  const onError = typeof options.onError === "function"
    ? options.onError
    : (label, error) => {
      try {
        console.error(label, error);
      } catch {}
    };
  const pluginId = typeof options.pluginId === "string" && options.pluginId !== ""
    ? options.pluginId
    : DEFAULT_PLUGIN_ID;
  const windowOption = options.window;
  const notificationOption = options.notificationCtor;

  const readWindow = () => (windowOption !== void 0 ? windowOption : defaultWindow());
  const readNotification = () => (notificationOption !== void 0 ? notificationOption : defaultNotificationCtor());

  // 任一桥抛错即置位，任一桥成功即复位。只影响「能力/权限怎么报告」，
  // 不影响投递顺序：每次投递都重新按顺序尝试。
  let bridgeFailed = false;
  // 每条通知一个唯一且短的 tag（ADR-0001）：同 tag 的已存在通知在 Windows/Chromium 上
  // 只会被「替换」，既不弹 toast 也不触发 onshow（实测：自动停止提醒因此静默丢失）。
  let tagSequence = 0;

  // 上报是诊断，绝不反过来影响投递：sink 抛错按「没上报」处理。
  const safeReport = (event, payload) => {
    try {
      report(event, payload);
    } catch {}
  };
  const safePlatform = (feedback) => {
    try {
      onPlatform(feedback);
    } catch {}
  };

  /**
   * 能力/权限的**单一来源**：一次派生回答「现在有哪些渠道可用」（含权限与桥状态）。
   * 投递决策、投递结果、上报体与权限请求都取这里的值，不在使用点重算。
   */
  const capability = () => readCapabilities({
    window: readWindow(),
    notificationCtor: readNotification(),
    bridgeFailed
  });
  /** 面向调用方的那一问：有可用原生桥就是 native，否则是浏览器权限。 */
  const permission = () => capability().permission;
  const browserPermission = () => capability().browserPermission;
  const nativeBridge = () => capability().nativeBridge;

  // 有序的渠道序列（顺序与回退都在里面声明，不散在 if 链里）。
  const adapters = createChannelAdapters({
    readWindow,
    readNotification,
    pluginId,
    nextTag: () => `${TAG_PREFIX}-${++tagSequence}`,
    onError,
    openSession,
    report: safeReport,
    onPlatform: safePlatform
  });

  /**
   * 投递一条提醒并回报结果。
   *
   * `notice` 是「要投的提醒」本身：`{ key, kind, sessionId?, title, message }`。`key` 只用于
   * 诊断与平台反馈的关联（去重记账在调用方）。`facts.background` 是调用方的前台判定，
   * 这里只当作记录事实回报，不参与任何决策。
   */
  function deliver(notice, facts = {}) {
    const background = facts.background === true;
    // 本轮只派生一次：可用性判定、结果与上报体用同一个值（记录不可能与决策分叉）。
    const observed = capability();
    const chain = runDeliveryChain(adapters, { notice, capability: observed, onError });

    // 桥被证明不可用 / 被证伪后又被接住：只改「能力怎么报告」，不改投递顺序。
    if (chain.adapter !== null && chain.adapter.kind === "bridge") bridgeFailed = false;
    else if (chain.errors.length > 0) bridgeFailed = true;

    const result = {
      outcome: chain.outcome,
      channel: chain.channel,
      delivered: chain.delivered,
      // 有渠道抛错后改走后续渠道——与「本来就没有渠道」是两件事。
      fellBack: chain.errors.length > 0,
      errors: chain.errors,
      // 只有走到了浏览器那一步才读得到浏览器权限；原生桥接住时留给调用方自己刷新。
      browserPermission: chain.consulted.includes(CHANNEL_IDS.BROWSER) ? observed.browserPermission : undefined,
      at: now().toLocaleTimeString(),
      activation: observed.userActivation,
      // 本次投递用的那个能力值：调用方（诊断记录）据此对齐，不再各算一次。
      capability: observed
    };

    safeReport(DIAGNOSTIC_EVENTS.DELIVER, {
      key: notice.key,
      kind: notice.kind,
      // 停止原因（`completed` / `error` / …）随投递一起落盘：文案是否对得上因此可被
      // 事后审计，而不是只能靠人盯着通知看。
      reason: notice.reason ?? null,
      sessionId: notice.sessionId ?? null,
      channel: result.channel,
      delivered: result.delivered,
      background,
      browserPermission: observed.browserPermission,
      nativeBridge: observed.nativeBridge,
      userActivation: observed.userActivation
    });
    return result;
  }

  /**
   * 请求浏览器通知权限（原生桥可用时不必请求）。回报 `{ permission, resync }`：
   * `resync` 表示调用方拿到这个权限后应当重新同步会话状态（与既有的
   * 「native 短路」与「granted 之后重同步」两条路径一致）。
   */
  async function requestPermission() {
    const observed = capability();
    if (observed.permission === "native") return { permission: "native", resync: true };
    if (!observed.browserApi) return { permission: "unsupported", resync: false };
    try {
      const granted = await readNotification().requestPermission();
      return { permission: granted, resync: granted === "granted" };
    } catch (error) {
      onError("notification permission failed", error);
      return { permission: permission(), resync: false };
    }
  }

  return {
    deliver,
    permission,
    browserPermission,
    nativeBridge,
    capability,
    requestPermission
  };
}
