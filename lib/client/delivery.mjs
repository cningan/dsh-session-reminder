/**
 * 投递层：渠道选择、平台事件与通知参数（tag / 权限读取）集中在这个 module。
 *
 * 它**不含判定语义**：既不知道「该不该提醒」（判定在 `core/decide`），也不知道
 * 「页面是否在前台」（前台否决留在装配层）。调用者把一条已经决定要投的提醒交给它，
 * 它按渠道顺序投递并回报：
 *
 *   1. `window.dshShell.notify`             workbench 原生桥
 *   2. `window.chrome.webview.postMessage`  WebView 桥
 *   3. 浏览器 `Notification`（按权限）
 *
 * 投递结果**显式区分**渠道状况，调用者不必靠字符串猜（见 `DELIVERY_OUTCOMES`）：
 *   - `native-bridge`  已交给原生桥
 *   - `browser`        已交给浏览器 Notification API
 *   - `no-channel`     无可用渠道（桥不可用/抛错，且浏览器权限未授予或 API 不存在）
 *   - `browser-error`  浏览器 API 在，但构造抛错
 * 另有 `fellBack`（有渠道抛错后改走后续渠道）与 `errors`（逐个抛错渠道）作为补充。
 *
 * 副作用出口只有两个，都是注入的（缺省 no-op，投递照常工作、绝不因上报失败而中断）：
 *   - `report(event, payload)`  诊断 sink：`deliver`（每次投递尝试）与 `platform`（平台反馈）
 *                              事件名取自 `client/diagnostics-sink` 的常量表，不在这里散写字面量
 *   - `onPlatform(feedback)`    平台事件回灌给调用方（onshow / onerror / onclose）
 *
 * ADR-0001：通知参数**绝不设置** `requireInteraction`，`tag` 逐条唯一且短（`dshss-N`）。
 */

import { DIAGNOSTIC_EVENTS } from "./diagnostics-sink.mjs";

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

/**
 * 通知 tag 前缀。tag 必须短：Windows toast 对 tag 长度敏感，把会话 id 拼进去
 * （曾达 94 字符）会导致通知被平台丢弃（ADR-0001）。
 */
export const TAG_PREFIX = "dshss";

const DEFAULT_PLUGIN_ID = "@cningan/dsh-session-status";

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

/** 原生桥是否存在（只看能力，不看上次是否抛错）。 */
export function hasNativeBridge(windowLike = defaultWindow()) {
  try {
    const shell = windowLike !== null && windowLike !== undefined ? windowLike.dshShell : void 0;
    const webview = windowLike !== null && windowLike !== undefined ? windowLike.chrome?.webview : void 0;
    return (shell !== void 0 && typeof shell.notify === "function")
      || (webview !== void 0 && typeof webview.postMessage === "function");
  } catch {
    return false;
  }
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

  const browserPermission = () => readBrowserPermission(readNotification());
  const nativeBridge = () => hasNativeBridge(readWindow());
  /** 面向设置的「当前投递能力」：有可用原生桥就是 native，否则是浏览器权限。 */
  const permission = () => (nativeBridge() && !bridgeFailed ? "native" : browserPermission());

  const nativePayload = (notice) => ({
    type: `${pluginId}/notify`,
    kind: notice.kind,
    title: notice.title,
    message: notice.message
  });

  /** 依次尝试两个原生桥，回报是否接住与逐个抛错。 */
  const attemptNative = (notice) => {
    const win = readWindow();
    const errors = [];
    const shell = win !== null && win !== void 0 ? win.dshShell : void 0;
    if (shell !== void 0 && typeof shell.notify === "function") {
      try {
        shell.notify(nativePayload(notice));
        bridgeFailed = false;
        return { delivered: true, errors };
      } catch (error) {
        errors.push({ channel: "shell", error });
        onError("shell notification failed", error);
      }
    }
    const webview = win !== null && win !== void 0 ? win.chrome?.webview : void 0;
    if (webview !== void 0 && typeof webview.postMessage === "function") {
      try {
        webview.postMessage(nativePayload(notice));
        bridgeFailed = false;
        return { delivered: true, errors };
      } catch (error) {
        errors.push({ channel: "webview", error });
        onError("WebView notification failed", error);
      }
    }
    if (errors.length > 0) bridgeFailed = true;
    return { delivered: false, errors };
  };

  /** 平台反馈：既上报 sink，也回灌调用方（调用方据此更新自己的诊断显示）。 */
  const markPlatform = (notice, event, error) => {
    safeReport(DIAGNOSTIC_EVENTS.PLATFORM, { key: notice.key, event, error: error === void 0 ? null : error });
    safePlatform({ key: notice.key, kind: notice.kind, event, error });
  };

  /** 交给浏览器 Notification API；返回 `delivered=false` 时由调用方判定渠道状况。 */
  const attemptBrowser = (notice) => {
    let system;
    try {
      system = new (readNotification())(notice.title, {
        body: notice.message,
        // tag 必须短且唯一：见 TAG_PREFIX 与 ADR-0001。
        tag: `${TAG_PREFIX}-${++tagSequence}`,
        renotify: true,
        silent: false
      });
    } catch (error) {
      onError("system notification failed", error);
      return { delivered: false };
    }
    system.onclick = () => {
      try {
        if (notice.sessionId !== void 0) openSession(notice.sessionId);
      } catch (error) {
        onError("could not open session", error);
      }
      try {
        const win = readWindow();
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
    return { delivered: true };
  };

  /**
   * 投递一条提醒并回报结果。
   *
   * `notice` 是「要投的提醒」本身：`{ key, kind, sessionId?, title, message }`。`key` 只用于
   * 诊断与平台反馈的关联（去重记账在调用方）。`facts.background` 是调用方的前台判定，
   * 这里只当作记录事实回报，不参与任何决策。
   */
  function deliver(notice, facts = {}) {
    const background = facts.background === true;
    const native = attemptNative(notice);

    let outcome = DELIVERY_OUTCOMES.NATIVE_BRIDGE;
    let channel = "native-bridge";
    let delivered = native.delivered;
    let observedBrowserPermission;
    let errors = native.errors.slice();

    if (!delivered) {
      observedBrowserPermission = browserPermission();
      if (observedBrowserPermission !== "granted") {
        // 无可用渠道：桥不可用/抛错，浏览器权限也没给。
        outcome = DELIVERY_OUTCOMES.NO_CHANNEL;
        channel = `browser-${observedBrowserPermission}`;
      } else if (readNotification() === void 0 || readNotification() === null) {
        outcome = DELIVERY_OUTCOMES.NO_CHANNEL;
        channel = "browser-unsupported";
      } else {
        const browser = attemptBrowser(notice);
        delivered = browser.delivered;
        outcome = browser.delivered ? DELIVERY_OUTCOMES.BROWSER : DELIVERY_OUTCOMES.BROWSER_ERROR;
        channel = browser.delivered ? "browser" : "browser-error";
      }
    }

    const result = {
      outcome,
      channel,
      delivered,
      // 有渠道抛错后改走后续渠道——与「本来就没有渠道」是两件事。
      fellBack: errors.length > 0,
      errors,
      // 只有走到了浏览器那一步才读得到浏览器权限；原生桥接住时留给调用方自己刷新。
      browserPermission: observedBrowserPermission,
      at: now().toLocaleTimeString(),
      activation: readUserActivation()
    };

    safeReport(DIAGNOSTIC_EVENTS.DELIVER, {
      key: notice.key,
      kind: notice.kind,
      sessionId: notice.sessionId ?? null,
      channel: result.channel,
      delivered: result.delivered,
      background,
      browserPermission: browserPermission(),
      nativeBridge: nativeBridge(),
      userActivation: readUserActivation()
    });
    return result;
  }

  /**
   * 请求浏览器通知权限（原生桥可用时不必请求）。回报 `{ permission, resync }`：
   * `resync` 表示调用方拿到这个权限后应当重新同步会话状态（与既有的
   * 「native 短路」与「granted 之后重同步」两条路径一致）。
   */
  async function requestPermission() {
    if (nativeBridge() && !bridgeFailed) return { permission: "native", resync: true };
    const ctor = readNotification();
    if (ctor === void 0 || ctor === null) return { permission: "unsupported", resync: false };
    try {
      const granted = await ctor.requestPermission();
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
    requestPermission
  };
}
