/* Built by scripts/build-client.mjs from lib/client/ — do not edit lib/client.js directly. */
(() => {
  // lib/core/classify.mjs
  var TERMINAL_REASONS = Object.freeze([
    "completed",
    "interrupted",
    "blocked",
    "max-tokens",
    "error",
    "agent-error",
    "prompt-error",
    "session-open-error",
    "aborted-parent",
    "aborted-hook"
  ]);
  var INTERACTION_KINDS = Object.freeze(["approval", "plan-review", "question"]);
  var DETAIL_LIMIT = 220;
  function compact(value) {
    if (typeof value !== "string") return "";
    const text = value.replace(/\s+/g, " ").trim();
    return text === "" ? "" : text.slice(0, DETAIL_LIMIT);
  }
  function result(reason, detail = "", silent = false) {
    return { reason, detail, silent };
  }
  function classifyTurnEnd(reason) {
    if (reason === null || typeof reason !== "object" || typeof reason.kind !== "string") return void 0;
    if (reason.kind === "completed") return result("completed");
    if (reason.kind === "aborted") {
      const cause = reason.reason;
      if (cause !== null && typeof cause === "object" && cause.kind === "user") return result("interrupted", "", true);
      if (cause !== null && typeof cause === "object" && cause.kind === "parent") return result("aborted-parent");
      if (cause !== null && typeof cause === "object" && cause.kind === "hook") {
        return result("aborted-hook", compact(cause.reason));
      }
      return result("interrupted");
    }
    if (reason.kind === "blocked") return result("blocked");
    if (reason.kind === "error") {
      const failure = reason.error;
      const detail = [compact(failure?.code), compact(failure?.message)].filter(Boolean).join(": ");
      return result("error", detail);
    }
    if (reason.kind === "max-tokens") return result("max-tokens");
    return result("interrupted");
  }
  function classifyDetail(detail) {
    if (detail === null || typeof detail !== "object") return void 0;
    const agentError = compact(detail.lastAgentError);
    if (agentError !== "") return result("agent-error", agentError);
    const promptError = detail.promptError?.error;
    const promptMessage = compact(promptError?.message);
    if (promptMessage !== "") {
      const code = compact(promptError?.code);
      return result("prompt-error", code === "" ? promptMessage : `${code}: ${promptMessage}`);
    }
    if (detail.openState === "error") {
      const openError = detail.openError;
      const code = compact(openError?.code);
      const message = compact(openError?.message);
      const suffix = code === "" ? message : message === "" ? code : `${code}: ${message}`;
      return result("session-open-error", suffix);
    }
    return void 0;
  }
  function classifyInteraction(kind) {
    if (kind === "approval") return "approval";
    if (kind === "plan-review") return "plan-review";
    return "question";
  }

  // lib/client/source.mjs
  function createPlugin(loadModule) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = loadModule("react");
    const h = React.createElement;
    const { useEffect, useState } = React;
    const PLUGIN_ID = "@cningan/dsh-session-status";
    const STYLE_TAG = "@cningan/dsh-session-status/system-notifications.css";
    const LOCALE_NS = "dsh-session-status-notifications";
    const DIAGNOSTICS_PATH = "/plugins/dsh-session-status/diagnostics";
    function reportDiagnostic(event, payload) {
      if (typeof fetch !== "function") return;
      try {
        const body = JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), event, payload });
        void fetch(DIAGNOSTICS_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: true
        }).catch(() => {
        });
      } catch {
      }
    }
    const dictionaries = {
      zh: {
        unknownStopped: "会话已停止，但无法确定原因",
        separator: "：",
        waitTitle: "会话等待你的{kind}",
        approval: "审批",
        planReview: "计划审查",
        question: "回答",
        completed: "本轮会话已完成",
        interrupted: "会话已中断或停止",
        agentError: "运行错误：{reason}",
        promptError: "操作失败：{reason}",
        turnError: "本轮发生错误：{reason}",
        maxTokens: "本轮达到输出上限",
        blocked: "本轮被阻止",
        abortedByParent: "本轮因父任务停止而中止",
        abortedByHook: "本轮被扩展逻辑中止：{reason}",
        openError: "会话窗口加载失败：{reason}",
        openErrorGeneric: "会话窗口加载失败",
        notifications: "会话提醒",
        notificationsDescription: "运行中的会话等待或停止时提醒；仅页面隐藏或失焦时触发。",
        enableNotifications: "启用提醒",
        enabledNotifications: "提醒已启用",
        nativeBridgeDetected: "已检测到原生提醒桥",
        testNotification: "发送测试提醒",
        probeNotification: "探针 · test（立即投递）",
        probeInterrupted: "探针 · interrupted（立即投递）",
        probeBurst: "连发探针 ×3（立即投递）",
        probeFired: "探针已投递",
        testMode: "测试模式（忽略前台抑制）",
        testModeOn: "测试模式已开启",
        testNotificationSent: "测试提醒已发送",
        testNotificationFailed: "测试提醒发送失败",
        testNotificationTitle: "DSH 提醒测试",
        testNotificationMessage: "这是一条真实提醒，用于验证当前投递渠道。",
        notificationDenied: "浏览器已阻止通知，请在站点设置中允许",
        notificationUnavailable: "当前环境没有可用的提醒渠道"
      },
      en: {
        unknownStopped: "The session stopped, but the reason is unavailable",
        separator: ": ",
        waitTitle: "Session is waiting for your {kind}",
        approval: "approval",
        planReview: "plan review",
        question: "answer",
        completed: "Session run completed",
        interrupted: "Session interrupted or stopped",
        agentError: "Runtime error: {reason}",
        promptError: "Operation failed: {reason}",
        turnError: "This run failed: {reason}",
        maxTokens: "This run reached the output limit",
        blocked: "This run was blocked",
        abortedByParent: "The parent task stopped this run",
        abortedByHook: "An extension stopped this run: {reason}",
        openError: "The session window failed to load: {reason}",
        openErrorGeneric: "The session window failed to load",
        notifications: "Session reminders",
        notificationsDescription: "Alerts for every running session that waits or stops, only while the page is hidden or unfocused.",
        enableNotifications: "Enable reminders",
        enabledNotifications: "Session reminders are enabled",
        nativeBridgeDetected: "Native reminder bridge detected",
        testNotification: "Send test reminder",
        probeNotification: "Probe: test (now)",
        probeInterrupted: "Probe: interrupted (now)",
        probeBurst: "Burst probe x3 (now)",
        probeFired: "Probe delivered",
        testMode: "Test mode (ignore foreground)",
        testModeOn: "Test mode is on",
        testNotificationSent: "Test reminder sent",
        testNotificationFailed: "Test reminder failed",
        testNotificationTitle: "DSH reminder test",
        testNotificationMessage: "This is a real reminder to verify the available delivery channel.",
        notificationDenied: "Browser notifications are blocked; allow them in site settings",
        notificationUnavailable: "No reminder delivery channel is available"
      }
    };
    const CSS = `
      .dshss-settings {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 0;
        color: var(--dsw-alias-label-primary, #202124);
        font-family: var(--dsw-font-family, inherit);
      }
      .dshss-settings-row {
        box-sizing: border-box;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      .dshss-settings-copy {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .dshss-settings-title {
        font-size: 13px;
        line-height: 18px;
        font-weight: 600;
      }
      .dshss-settings-description {
        max-width: 560px;
        color: var(--dsw-alias-label-secondary, #5f6368);
        font-size: 12px;
        line-height: 17px;
      }
      .dshss-settings-diagnostics {
        margin-top: 4px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        font-size: 11px;
        line-height: 16px;
        font-variant-numeric: tabular-nums;
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .dshss-settings-tools {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .dshss-settings-status {
        flex: none;
        max-width: 300px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        font-size: 12px;
        line-height: 17px;
        text-align: right;
      }
      .dshss-settings-button {
        flex: none;
        min-height: 30px;
        padding: 5px 10px;
        border: 1px solid var(--dsw-alias-border-primary, rgba(0, 0, 0, .14));
        border-radius: 7px;
        background: var(--dsw-alias-bg-secondary, rgba(0, 0, 0, .04));
        color: inherit;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
      }
      .dshss-settings-button:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .08));
      }
      .dshss-settings-button:disabled {
        cursor: default;
        opacity: .6;
      }
      .dshss-settings-actions {
        flex: none;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        flex-wrap: wrap;
      }
      @media (max-width: 620px) {
        .dshss-settings-row {
          align-items: flex-start;
          flex-direction: column;
          gap: 8px;
        }
        .dshss-settings-status {
          max-width: none;
          text-align: left;
        }
        .dshss-settings-actions {
          justify-content: flex-start;
        }
      }
    `;
    function readUserActivation() {
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
    function hasNativeShellNotify() {
      try {
        const shell = typeof window !== "undefined" ? window.dshShell : void 0;
        const webview = typeof window !== "undefined" ? window.chrome?.webview : void 0;
        return shell !== void 0 && typeof shell.notify === "function" || webview !== void 0 && typeof webview.postMessage === "function";
      } catch {
        return false;
      }
    }
    function readBrowserNotificationPermission() {
      if (typeof Notification === "undefined") return "unsupported";
      try {
        return Notification.permission || "default";
      } catch {
        return "unsupported";
      }
    }
    function readNotificationPermission(preferNative = true) {
      if (preferNative && hasNativeShellNotify()) return "native";
      return readBrowserNotificationPermission();
    }
    function pageIsBackground() {
      if (typeof document === "undefined") return false;
      if (document.visibilityState === "hidden") return true;
      if (typeof document.hasFocus === "function") return document.hasFocus() === false;
      return false;
    }
    function compactMessage(value, fallback = "") {
      if (typeof value !== "string") return fallback;
      const text = value.replace(/\s+/g, " ").trim();
      return text === "" ? fallback : text.slice(0, 220);
    }
    function titleOf(row, sessionId) {
      if (typeof row?.displayTitle === "string" && row.displayTitle !== "") return row.displayTitle;
      if (typeof row?.title === "string" && row.title !== "") return row.title;
      return sessionId;
    }
    function pendingKind(t, kind) {
      const classified = classifyInteraction(kind);
      if (classified === "approval") return t("approval");
      if (classified === "plan-review") return t("planReview");
      return t("question");
    }
    function pendingKey(sessionId, identity) {
      return `pending:${sessionId}:${identity}`;
    }
    function installStyle() {
      if (typeof document === "undefined" || document.head === null) return () => {
      };
      const old = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG)}]`);
      if (old !== null) old.remove();
      const style = document.createElement("style");
      style.dataset.plugin = PLUGIN_ID;
      style.dataset.pluginCss = STYLE_TAG;
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => {
        if (style.parentNode !== null) style.remove();
      };
    }
    function terminalText(classified, t) {
      const detail = classified.detail === "" ? t("unknownStopped") : classified.detail;
      switch (classified.reason) {
        case "completed":
          return "";
        case "blocked":
          return t("blocked");
        case "max-tokens":
          return t("maxTokens");
        case "aborted-parent":
          return t("abortedByParent");
        case "aborted-hook":
          return t("abortedByHook", { reason: detail });
        case "error":
          return t("turnError", { reason: detail });
        case "agent-error":
          return t("agentError", { reason: detail });
        case "prompt-error":
          return t("promptError", { reason: classified.detail });
        case "session-open-error":
          return classified.detail === "" ? t("openErrorGeneric") : t("openError", { reason: classified.detail });
        default:
          return "";
      }
    }
    function classifyDetail2(detail, t) {
      const classified = classifyDetail(detail);
      return classified === void 0 ? "" : terminalText(classified, t);
    }
    function classifyTurnEnd2(reason, t) {
      const classified = classifyTurnEnd(reason);
      if (classified === void 0) return void 0;
      if (classified.silent) return { outcome: "silent" };
      if (classified.reason === "completed") return { outcome: "completed" };
      const message = terminalText(classified, t);
      return message === "" ? { outcome: "unknown" } : { outcome: "stopped", message };
    }
    function createStatusModel(ctx, sessions, uiSession, t) {
      const listeners = /* @__PURE__ */ new Set();
      const previous = /* @__PURE__ */ new Map();
      const sessionRuns = /* @__PURE__ */ new Map();
      const deliveredKeys = /* @__PURE__ */ new Set();
      const pendingIdentities = /* @__PURE__ */ new WeakMap();
      let pendingSequence = 0;
      let currentSessionId;
      let currentTitle = "";
      let currentDetail;
      let currentDetailUnsubscribe = () => {
      };
      let currentEventUnsubscribe = () => {
      };
      let currentEventSequence = -1;
      let currentTurnEndReason;
      let nativeBridgeFailed = false;
      let notificationPermission = readNotificationPermission();
      let connectedOnce = false;
      let connectionLost = false;
      let testSequence = 0;
      let lastStatusSignature = "";
      let notificationTagSequence = 0;
      let testMode = false;
      let diagnostics = { status: null, edge: null, deliver: null, page: null };
      let disposed = false;
      const notify = () => {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            console.error(`[${PLUGIN_ID}] settings listener failed`, error);
          }
        }
      };
      const getSnapshot = () => ({ notificationPermission, diagnostics, testMode });
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      const observeRunState = (sessionId, running) => {
        let run = sessionRuns.get(sessionId);
        if (run === void 0) {
          run = {
            sequence: running ? 1 : 0,
            running,
            waitingNotified: false,
            terminalNotified: false
          };
          sessionRuns.set(sessionId, run);
          return { run, wasRunning: false, initial: true };
        }
        const wasRunning = run.running;
        if (running && !wasRunning) {
          run.sequence += 1;
          run.waitingNotified = false;
          run.terminalNotified = false;
        }
        run.running = running;
        return { run, wasRunning, initial: false };
      };
      const nativeShellNotify = (notice) => {
        const payload = {
          type: `${PLUGIN_ID}/notify`,
          kind: notice.kind,
          title: notice.title,
          message: notice.message
        };
        let attempted = false;
        const shell = typeof window !== "undefined" ? window.dshShell : void 0;
        if (shell !== void 0 && typeof shell.notify === "function") {
          attempted = true;
          try {
            shell.notify(payload);
            nativeBridgeFailed = false;
            return true;
          } catch (error) {
            console.error(`[${PLUGIN_ID}] shell notification failed`, error);
          }
        }
        const webview = typeof window !== "undefined" ? window.chrome?.webview : void 0;
        if (webview !== void 0 && typeof webview.postMessage === "function") {
          attempted = true;
          try {
            webview.postMessage(payload);
            nativeBridgeFailed = false;
            return true;
          } catch (error) {
            console.error(`[${PLUGIN_ID}] WebView notification failed`, error);
          }
        }
        if (attempted) nativeBridgeFailed = true;
        return false;
      };
      const systemNotify = (notice, allowForeground = false) => {
        const background = pageIsBackground();
        const finish = (channel, delivered) => {
          diagnostics = {
            ...diagnostics,
            deliver: {
              key: notice.key,
              kind: notice.kind,
              channel,
              delivered,
              background,
              at: (/* @__PURE__ */ new Date()).toLocaleTimeString(),
              activation: readUserActivation(),
              testMode
            }
          };
          notify();
          reportDiagnostic("deliver", {
            key: notice.key,
            kind: notice.kind,
            sessionId: notice.sessionId ?? null,
            channel,
            delivered,
            background,
            browserPermission: readBrowserNotificationPermission(),
            nativeBridge: hasNativeShellNotify(),
            userActivation: readUserActivation()
          });
          return delivered;
        };
        if (!allowForeground && !testMode && !background) return finish("suppressed-foreground", false);
        if (nativeShellNotify(notice)) return finish("native-bridge", true);
        const browserPermission = readBrowserNotificationPermission();
        if (notificationPermission !== browserPermission) {
          notificationPermission = browserPermission;
          notify();
        }
        if (browserPermission !== "granted") return finish(`browser-${browserPermission}`, false);
        if (typeof Notification === "undefined") return finish("browser-unsupported", false);
        try {
          const system = new Notification(notice.title, {
            body: notice.message,
            // tag 必须短：Windows toast 对 tag 长度敏感，过长的 tag（例如把会话 id
            // 拼进去）可能导致通知被平台丢弃。
            tag: `dshss-${++notificationTagSequence}`,
            renotify: true,
            silent: false
          });
          system.onclick = () => {
            try {
              if (notice.sessionId !== void 0) sessions.open(notice.sessionId);
            } catch (error) {
              console.error(`[${PLUGIN_ID}] could not open session`, error);
            }
            try {
              if (typeof window !== "undefined") window.focus();
            } catch {
            }
            try {
              system.close();
            } catch {
            }
          };
          const markPlatform = (event, error) => {
            diagnostics = {
              ...diagnostics,
              deliver: {
                ...diagnostics.deliver ?? { key: notice.key, kind: notice.kind },
                platform: error === void 0 || error === null ? event : `${event}: ${error}`
              }
            };
            reportDiagnostic("platform", { key: notice.key, event, error: error ?? null });
            notify();
          };
          system.onshow = () => markPlatform("onshow");
          system.onerror = (event) => markPlatform("onerror", String(event?.error ?? "unknown"));
          system.onclose = () => markPlatform("onclose");
          return finish("browser", true);
        } catch (error) {
          console.error(`[${PLUGIN_ID}] system notification failed`, error);
          return finish("browser-error", false);
        }
      };
      const sendTestNotification = () => systemNotify({
        key: `test:${++testSequence}`,
        kind: "test",
        title: t("testNotificationTitle"),
        message: t("testNotificationMessage")
      }, true);
      let sendProbe = null;
      let sendProbeBurst = null;
      let sendDelayedProbe = null;
      if (true) {
        sendProbe = (kind = "test") => systemNotify({
          key: `test-probe:${kind}:${++testSequence}`,
          kind,
          title: kind === "test" ? t("testNotificationTitle") : t("interrupted"),
          message: t("testNotificationMessage")
        }, false);
        sendProbeBurst = (kind = "test", count = 3, gapMs = 2e3) => {
          let fired = 0;
          const fire = () => {
            if (fired >= count) return;
            fired += 1;
            sendProbe(kind);
            if (fired < count) setTimeout(fire, gapMs);
          };
          fire();
          return count;
        };
        sendDelayedProbe = (delayMs = 1e4, kind = "test") => {
          setTimeout(() => sendProbe(kind), delayMs);
        };
      }
      const pushSystemNotice = (input) => {
        const notice = {
          key: input.key,
          kind: input.kind,
          sessionId: input.sessionId,
          title: input.title,
          message: input.message
        };
        if (deliveredKeys.has(notice.key)) return false;
        const delivered = systemNotify(notice);
        if (delivered) deliveredKeys.add(notice.key);
        console.log(`[${PLUGIN_ID}] system reminder`, {
          kind: notice.kind,
          sessionId: notice.sessionId,
          delivered,
          permission: notificationPermission,
          background: pageIsBackground()
        });
        return delivered;
      };
      const removeDeliveredForSession = (sessionId) => {
        const prefixes = [`pending:${sessionId}:`, `terminal:${sessionId}:`];
        for (const key of [...deliveredKeys]) {
          if (prefixes.some((prefix) => key.startsWith(prefix))) deliveredKeys.delete(key);
        }
      };
      const notifySessionTerminal = (sessionId, detail, fallbackTitle, turnEndReason) => {
        const run = sessionRuns.get(sessionId);
        if (run === void 0 || run.sequence === 0 || run.terminalNotified || run.waitingNotified) return false;
        run.terminalNotified = true;
        const terminal = classifyTurnEnd2(turnEndReason, t);
        if (terminal?.outcome === "silent" || detail?.removed === true) return false;
        const detailReason = detail === void 0 ? "" : classifyDetail2(detail, t);
        const reason = terminal?.outcome === "stopped" ? terminal.message : terminal?.outcome === "completed" ? "" : detailReason;
        const completed = terminal?.outcome === "completed";
        const unknown = reason === "" && !completed;
        const title = reason !== "" ? t("interrupted") : completed ? t("completed") : t("interrupted");
        const sessionTitle = fallbackTitle || currentTitle || sessionId;
        const separator = t("separator");
        const message = reason !== "" ? `${sessionTitle}${separator}${reason}` : unknown ? `${sessionTitle}${separator}${t("unknownStopped")}` : sessionTitle;
        pushSystemNotice({
          key: `terminal:${sessionId}:${run.sequence}`,
          kind: reason !== "" || unknown ? "interrupted" : "completed",
          sessionId,
          title,
          message
        });
        return true;
      };
      const observeCurrentEventWindow = (snapshot, seed = false) => {
        if (disposed || currentSessionId === void 0) return;
        const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
        const target = snapshot?.target;
        const candidates = target !== null && typeof target === "object" ? [...events, target] : events;
        for (const event of candidates) {
          if (event === null || typeof event !== "object") continue;
          const sequence = typeof event.seq === "number" ? event.seq : void 0;
          if (sequence === void 0) continue;
          if (seed) {
            currentEventSequence = Math.max(currentEventSequence, sequence);
            continue;
          }
          if (sequence <= currentEventSequence) continue;
          currentEventSequence = sequence;
          if (event.type === "turn/end") currentTurnEndReason = event.data?.reason;
        }
      };
      const observeCurrentDetail = (nextSnapshot) => {
        if (disposed || currentSessionId === void 0) return;
        currentDetail = nextSnapshot;
      };
      const rebaseCurrentDetailForRun = () => {
        if (currentDetail === void 0) return;
        currentDetail = {};
      };
      const disposeCurrentDetail = () => {
        try {
          currentDetailUnsubscribe();
        } catch (error) {
          console.error(`[${PLUGIN_ID}] current session unsubscribe failed`, error);
        }
        try {
          currentEventUnsubscribe();
        } catch (error) {
          console.error(`[${PLUGIN_ID}] current session event unsubscribe failed`, error);
        }
        currentDetailUnsubscribe = () => {
        };
        currentEventUnsubscribe = () => {
        };
        currentDetail = void 0;
        currentEventSequence = -1;
        currentTurnEndReason = void 0;
      };
      const bindCurrentSession = (sessionId) => {
        disposeCurrentDetail();
        currentSessionId = sessionId;
        currentTitle = sessionId || "";
        if (sessionId === void 0 || typeof sessions?.binding !== "function") return;
        let binding;
        try {
          binding = sessions.binding(sessionId);
        } catch (error) {
          console.error(`[${PLUGIN_ID}] current session binding failed`, error);
          return;
        }
        const eventSource = binding?.eventSource;
        if (eventSource !== void 0 && typeof eventSource.getSnapshot === "function" && typeof eventSource.subscribe === "function") {
          const observeEvents = () => {
            try {
              observeCurrentEventWindow(eventSource.getSnapshot());
            } catch (error) {
              console.error(`[${PLUGIN_ID}] current session event snapshot failed`, error);
            }
          };
          try {
            observeCurrentEventWindow(eventSource.getSnapshot(), true);
            currentEventUnsubscribe = eventSource.subscribe(observeEvents);
            observeEvents();
          } catch (error) {
            console.error(`[${PLUGIN_ID}] current session event subscription failed`, error);
            currentEventUnsubscribe = () => {
            };
          }
        }
        const face = binding?.session;
        if (face === void 0 || typeof face.getSnapshot !== "function" || typeof face.subscribe !== "function") return;
        const observe = () => {
          try {
            observeCurrentDetail(face.getSnapshot());
          } catch (error) {
            console.error(`[${PLUGIN_ID}] current session snapshot failed`, error);
          }
        };
        try {
          currentDetailUnsubscribe = face.subscribe(observe);
          observe();
        } catch (error) {
          console.error(`[${PLUGIN_ID}] current session subscription failed`, error);
          currentDetailUnsubscribe = () => {
          };
        }
      };
      const identityOf = (interaction) => {
        const known = pendingIdentities.get(interaction);
        if (known !== void 0) return known;
        const assigned = ++pendingSequence;
        pendingIdentities.set(interaction, assigned);
        return assigned;
      };
      const readSessionStatus = () => {
        const source = uiSession?.sessionStatus;
        if (source === void 0 || typeof source.getSnapshot !== "function") return void 0;
        try {
          const snapshot = source.getSnapshot();
          return snapshot instanceof Map ? snapshot : void 0;
        } catch (error) {
          console.error(`[${PLUGIN_ID}] session status snapshot failed`, error);
          return void 0;
        }
      };
      const readCurrentSessionId = () => {
        const source = uiSession?.adapter?.current;
        if (source === void 0 || typeof source.getSnapshot !== "function") return void 0;
        try {
          const key = source.getSnapshot()?.key;
          return typeof key === "string" ? key : void 0;
        } catch (error) {
          console.error(`[${PLUGIN_ID}] current session snapshot failed`, error);
          return void 0;
        }
      };
      function syncSessions() {
        if (disposed || sessions?.list === void 0) return;
        let snapshot;
        try {
          snapshot = sessions.list.getSnapshot();
        } catch (error) {
          console.error(`[${PLUGIN_ID}] session snapshot failed`, error);
          return;
        }
        const rows = snapshot?.byId;
        if (rows === null || typeof rows !== "object") {
          reportDiagnostic("source-shape", {
            stage: "list",
            byIdType: typeof rows,
            snapshotKeys: snapshot !== null && typeof snapshot === "object" ? Object.keys(snapshot) : null
          });
          return;
        }
        const statuses = readSessionStatus();
        if (statuses === void 0) {
          reportDiagnostic("source-shape", { stage: "status", reason: "sessionStatus is not a Map snapshot" });
          return;
        }
        const nextCurrentId = readCurrentSessionId();
        if (nextCurrentId !== currentSessionId) bindCurrentSession(nextCurrentId);
        const seen = /* @__PURE__ */ new Set();
        for (const [sessionId, status] of statuses) {
          seen.add(sessionId);
          const row = rows[sessionId];
          const old = previous.get(sessionId);
          const running = status?.running === true;
          const interaction = status?.pendingInteraction;
          const pending = interaction === void 0 ? void 0 : pendingKey(sessionId, identityOf(interaction));
          const oldPending = old?.pending;
          const isCurrent = sessionId === nextCurrentId;
          const sessionTitle = titleOf(row, sessionId);
          const { run, wasRunning, initial } = observeRunState(sessionId, running);
          if (isCurrent && !initial && !wasRunning && running) {
            currentTurnEndReason = void 0;
            rebaseCurrentDetailForRun();
          }
          const waitBecameRelevant = pending !== void 0 && run.sequence > 0 && !run.waitingNotified && !run.terminalNotified && (old !== void 0 && oldPending !== pending || !initial && wasRunning && !running);
          if (pending === void 0) {
            if (oldPending !== void 0) deliveredKeys.delete(oldPending);
          } else if (waitBecameRelevant) {
            diagnostics = { ...diagnostics, edge: { kind: "pending", sessionId, interactionKind: interaction.kind ?? null, suppressed: null } };
            reportDiagnostic("edge", { sessionId, kind: "pending", interactionKind: interaction.kind ?? null });
            pushSystemNotice({
              key: pending,
              kind: "pending",
              sessionId,
              title: t("waitTitle", { kind: pendingKind(t, interaction.kind) }),
              message: sessionTitle
            });
            run.waitingNotified = true;
            run.terminalNotified = true;
          }
          if (isCurrent) currentTitle = sessionTitle;
          const terminalEdge = !initial && wasRunning && !running && !run.waitingNotified && !run.terminalNotified;
          if (terminalEdge && row === void 0) {
            diagnostics = { ...diagnostics, edge: { kind: "terminal", sessionId, suppressed: "missing-list-row", isCurrent } };
            reportDiagnostic("edge", { sessionId, kind: "terminal", suppressed: "missing-list-row", isCurrent });
            notify();
            run.terminalNotified = true;
          } else if (terminalEdge) {
            const edgeRecord = {
              sessionId,
              kind: "terminal",
              suppressed: null,
              isCurrent,
              hasTurnEndReason: currentTurnEndReason !== void 0
            };
            diagnostics = { ...diagnostics, edge: edgeRecord };
            reportDiagnostic("edge", edgeRecord);
            notifySessionTerminal(
              sessionId,
              isCurrent ? currentDetail : void 0,
              sessionTitle,
              isCurrent ? currentTurnEndReason : void 0
            );
          }
          previous.set(sessionId, { pending, running });
        }
        for (const sessionId of [...previous.keys()]) {
          if (seen.has(sessionId)) continue;
          previous.delete(sessionId);
          sessionRuns.delete(sessionId);
          removeDeliveredForSession(sessionId);
        }
        const summary = {
          statusEntries: statuses.size,
          currentId: nextCurrentId ?? null,
          currentInStatuses: nextCurrentId !== void 0 && statuses.has(nextCurrentId),
          listHandlesCurrent: nextCurrentId !== void 0 && Object.prototype.hasOwnProperty.call(rows, nextCurrentId),
          runs: [...statuses].slice(0, 24).map(([id, status]) => ({
            id,
            running: status?.running === true,
            pending: status?.pendingInteraction !== void 0,
            unread: status?.completionUnread === true,
            inList: Object.prototype.hasOwnProperty.call(rows, id)
          }))
        };
        const signature = JSON.stringify(summary);
        if (signature !== lastStatusSignature) {
          lastStatusSignature = signature;
          diagnostics = { ...diagnostics, status: summary };
          reportDiagnostic("status", summary);
          notify();
        }
      }
      const markDisconnected = () => {
        if (!connectedOnce || connectionLost) return;
        connectionLost = true;
        console.info(`[${PLUGIN_ID}] connection lost; waiting for official reconnect loop`);
      };
      const markConnected = () => {
        const wasLost = connectionLost;
        connectedOnce = true;
        connectionLost = false;
        if (wasLost) {
          console.log(`[${PLUGIN_ID}] connection restored`);
          syncSessions();
        }
      };
      const connectionIsUp = (state) => state === "connected";
      const observeConnection = () => {
        const source = ctx.connection?.state;
        if (source === void 0 || typeof source.getSnapshot !== "function") return;
        let state;
        try {
          state = source.getSnapshot();
        } catch (error) {
          console.error(`[${PLUGIN_ID}] connection state snapshot failed`, error);
          return;
        }
        if (connectionIsUp(state)) markConnected();
        else markDisconnected();
      };
      const requestPermission = async () => {
        if (hasNativeShellNotify() && !nativeBridgeFailed) {
          notificationPermission = "native";
          notify();
          syncSessions();
          return notificationPermission;
        }
        if (typeof Notification === "undefined") {
          notificationPermission = "unsupported";
          notify();
          return notificationPermission;
        }
        try {
          notificationPermission = await Notification.requestPermission();
        } catch (error) {
          console.error(`[${PLUGIN_ID}] notification permission failed`, error);
          notificationPermission = readNotificationPermission(!nativeBridgeFailed);
        }
        notify();
        if (notificationPermission === "granted") syncSessions();
        return notificationPermission;
      };
      const connectionHandle = ctx.connection;
      if (connectionHandle?.state !== void 0) {
        const unsubscribe = connectionHandle.state.subscribe(observeConnection);
        ctx.effect(() => unsubscribe, `${PLUGIN_ID}: connection state`);
        observeConnection();
      }
      if (sessions?.list?.subscribe === void 0) {
        console.error(`[${PLUGIN_ID}] sessions.list is unavailable`);
      } else {
        const disposeList = sessions.list.subscribe(syncSessions);
        ctx.effect(() => disposeList, `${PLUGIN_ID}: session list`);
      }
      if (uiSession?.sessionStatus?.subscribe === void 0) {
        console.error(`[${PLUGIN_ID}] uiSession.sessionStatus is unavailable`);
      } else {
        const disposeStatus = uiSession.sessionStatus.subscribe(syncSessions);
        ctx.effect(() => disposeStatus, `${PLUGIN_ID}: session status`);
      }
      const currentScope = uiSession?.adapter?.current;
      if (currentScope?.subscribe === void 0) {
        console.error(`[${PLUGIN_ID}] uiSession.adapter.current is unavailable`);
      } else {
        const disposeCurrent = currentScope.subscribe(syncSessions);
        ctx.effect(() => disposeCurrent, `${PLUGIN_ID}: current session`);
      }
      const onPageState = () => {
        notificationPermission = readNotificationPermission(!nativeBridgeFailed);
        diagnostics = {
          ...diagnostics,
          page: {
            visibility: typeof document !== "undefined" ? document.visibilityState : null,
            focused: typeof document !== "undefined" && typeof document.hasFocus === "function" ? document.hasFocus() : null
          }
        };
        syncSessions();
        notify();
      };
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onPageState);
        window.addEventListener("focus", onPageState);
        window.addEventListener("blur", onPageState);
        ctx.effect(() => () => {
          document.removeEventListener("visibilitychange", onPageState);
          window.removeEventListener("focus", onPageState);
          window.removeEventListener("blur", onPageState);
        }, `${PLUGIN_ID}: page visibility`);
      }
      ctx.effect(() => () => {
        disposed = true;
        disposeCurrentDetail();
      }, `${PLUGIN_ID}: current session detail`);
      syncSessions();
      let setTestMode = null;
      if (true) {
        setTestMode = (value) => {
          testMode = value === true;
          notify();
          return testMode;
        };
      }
      return {
        getSnapshot,
        subscribe,
        requestPermission,
        sendTestNotification,
        // 调试能力只在调试构建里暴露；正式产物不含这些键。
        ...true ? { sendProbe, sendProbeBurst, sendDelayedProbe, setTestMode } : {}
      };
    }
    function NotificationSettingsRow({ model, t }) {
      const [, rerender] = useState(0);
      const [requesting, setRequesting] = useState(false);
      const [testResult, setTestResult] = useState("");
      useEffect(() => model.subscribe(() => rerender((value) => value + 1)), [model]);
      useEffect(() => {
        if (testResult === "") return;
        const timer = setTimeout(() => setTestResult(""), 2600);
        return () => clearTimeout(timer);
      }, [testResult]);
      const snapshot = model.getSnapshot();
      const canTest = snapshot.notificationPermission === "native" || snapshot.notificationPermission === "granted";
      const testButton = canTest ? h("button", {
        className: "dshss-settings-button",
        type: "button",
        onClick: () => setTestResult(model.sendTestNotification() ? "sent" : "failed")
      }, testResult === "sent" ? t("testNotificationSent") : testResult === "failed" ? t("testNotificationFailed") : t("testNotification")) : null;
      let probeButton = null;
      let probeInterruptedButton = null;
      let burstButton = null;
      let testModeButton = null;
      if (true) {
        probeButton = canTest ? h("button", {
          className: "dshss-settings-button",
          type: "button",
          onClick: () => {
            model.sendProbe("test");
            setTestResult("probe-fired");
          }
        }, testResult === "probe-fired" ? t("probeFired") : t("probeNotification")) : null;
        probeInterruptedButton = canTest ? h("button", {
          className: "dshss-settings-button",
          type: "button",
          onClick: () => {
            model.sendProbe("interrupted");
            setTestResult("probe-fired");
          }
        }, testResult === "probe-fired" ? t("probeFired") : t("probeInterrupted")) : null;
        burstButton = canTest ? h("button", {
          className: "dshss-settings-button",
          type: "button",
          onClick: () => {
            model.sendProbeBurst("test", 3);
            setTestResult("probe-fired");
          }
        }, testResult === "probe-fired" ? t("probeFired") : t("probeBurst")) : null;
        testModeButton = canTest ? h("button", {
          className: "dshss-settings-button",
          type: "button",
          onClick: () => model.setTestMode(!snapshot.testMode)
        }, snapshot.testMode ? t("testModeOn") : t("testMode")) : null;
      }
      let control;
      if (snapshot.notificationPermission === "native") {
        control = h(
          "div",
          { className: "dshss-settings-actions" },
          h("span", { className: "dshss-settings-status" }, t("nativeBridgeDetected")),
          testButton
        );
      } else if (snapshot.notificationPermission === "default") {
        control = h("button", {
          className: "dshss-settings-button",
          type: "button",
          disabled: requesting,
          onClick: () => {
            setRequesting(true);
            Promise.resolve(model.requestPermission()).then(() => {
            }, () => {
            }).then(() => setRequesting(false));
          }
        }, t("enableNotifications"));
      } else if (snapshot.notificationPermission === "granted") {
        control = h(
          "div",
          { className: "dshss-settings-actions" },
          h("span", { className: "dshss-settings-status" }, t("enabledNotifications")),
          testButton
        );
      } else if (snapshot.notificationPermission === "denied") {
        control = h("span", { className: "dshss-settings-status" }, t("notificationDenied"));
      } else {
        control = h("span", { className: "dshss-settings-status" }, t("notificationUnavailable"));
      }
      let diagnosticLines = [];
      if (true) {
        const d = snapshot.diagnostics ?? {};
        const pageBackground = typeof document === "undefined" ? false : document.visibilityState === "hidden" || typeof document.hasFocus === "function" && document.hasFocus() === false;
        diagnosticLines = [
          `诊断·状态源 ${d.status?.statusEntries ?? "?"} 条；当前会话在状态 ${d.status ? d.status.currentInStatuses ? "是" : "否" : "?"}；列表含当前 ${d.status ? d.status.listHandlesCurrent ? "是" : "否" : "?"}；运行中 ${d.status ? d.status.runs.filter((run) => run.running).length : "?"}`,
          d.edge === null || d.edge === void 0 ? "诊断·边沿 尚未观察到" : `诊断·最近边沿 ${d.edge.kind}${d.edge.suppressed === null || d.edge.suppressed === void 0 ? "" : `（抑制：${d.edge.suppressed}）`}`,
          d.deliver === null || d.deliver === void 0 ? "诊断·投递 尚无尝试" : `诊断·最近投递 ${d.deliver.at ?? ""} ${d.deliver.kind ?? "?"}/${d.deliver.channel}；已投递 ${d.deliver.delivered ? "是" : "否"}；失焦判定 ${d.deliver.background ? "是" : "否"}；用户激活 ${d.deliver.activation ? d.deliver.activation.everActive ? "曾有" : "无" : "?"}；平台反馈 ${d.deliver.platform ?? "（无事件）"}`,
          `诊断·当前页面 ${typeof document === "undefined" ? "?" : document.visibilityState}；失焦判定 ${pageBackground ? "是" : "否"}`
        ];
      }
      return h(
        "div",
        { className: "dshss-settings" },
        h(
          "div",
          { className: "dshss-settings-row" },
          h(
            "div",
            { className: "dshss-settings-copy" },
            h("div", { className: "dshss-settings-description" }, t("notificationsDescription"))
          ),
          control
        ),
        diagnosticLines.length > 0 ? h(
          "div",
          { className: "dshss-settings-diagnostics" },
          diagnosticLines.map((line, index) => h("div", { key: `dshss-diag-${index}` }, line))
        ) : null,
        canTest ? h(
          "div",
          { className: "dshss-settings-tools" },
          testModeButton,
          probeButton,
          probeInterruptedButton,
          burstButton
        ) : null
      );
    }
    const inject = ["slots", "locale", "sessions", "connection", "uiSession"];
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, dictionaries), `${PLUGIN_ID}: dictionaries`);
      const t = ctx.locale.bind(LOCALE_NS);
      reportDiagnostic("attach", {
        hasSessionsList: ctx.sessions?.list !== void 0,
        hasSessionStatus: ctx.uiSession?.sessionStatus !== void 0,
        hasCurrentScope: ctx.uiSession?.adapter?.current !== void 0,
        visibility: typeof document !== "undefined" ? document.visibilityState : null,
        focused: typeof document !== "undefined" && typeof document.hasFocus === "function" ? document.hasFocus() : null,
        browserPermission: readBrowserNotificationPermission(),
        nativeBridge: hasNativeShellNotify(),
        userActivation: readUserActivation()
      });
      const model = createStatusModel(ctx, ctx.sessions, ctx.uiSession, t);
      ctx.effect(installStyle, `${PLUGIN_ID}: stylesheet`);
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: PLUGIN_ID,
        order: 30,
        label: () => t("notifications"),
        inject: () => ({ t, model })
      }, NotificationSettingsRow));
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }

  // lib/client/entry.mjs
  window.__ModuleLoader__.load({
    id: "@cningan/dsh-session-status",
    factory: (loadModule) => createPlugin(loadModule)
  });
})();
