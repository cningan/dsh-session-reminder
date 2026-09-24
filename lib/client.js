/*
 * Browser-only system notification bridge for session status.
 *
 * The current DSH client catalog has no official system-notification or sound
 * Service/Event. The plugin therefore uses the browser Notification API as the
 * smallest reversible bridge. `silent: false` requests the platform sound, but
 * the browser/WebView and Windows notification settings remain authoritative.
 * If DSH later exposes an official notification service, replace this bridge
 * and the settings row while keeping the session edge classification below.
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-session-status",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const { useEffect, useState } = React;

    const PLUGIN_ID = "@local/dsh-session-status";
    const STYLE_TAG = "@local/dsh-session-status/system-notifications.css";

    const COPY = {
      zh: {
        connectionLost: "DSH 连接已断开",
        reconnecting: "当前会话可能已暂停，正在重连",
        waitTitle: "会话等待你的{kind}",
        approval: "审批",
        planReview: "计划审查",
        question: "回答",
        completed: "本轮会话已完成",
        interrupted: "会话已中断或暂停",
        genericInterrupted: "执行没有正常完成",
        agentError: "运行错误：{reason}",
        promptError: "操作失败：{reason}",
        openError: "会话窗口加载失败",
        turnError: "本轮发生错误",
        maxTokens: "本轮达到输出上限",
        interruptedTurn: "本轮被中断",
        removed: "会话已停止或被移除",
        notifications: "系统通知",
        notificationsDescription: "页面隐藏或失焦时提醒当前会话；声音由系统通知设置控制。",
        enableNotifications: "启用系统通知",
        enabledNotifications: "系统通知已启用",
        testNotification: "发送测试通知",
        testNotificationSent: "测试通知已发送",
        testNotificationFailed: "测试通知发送失败",
        testNotificationTitle: "DSH 通知测试",
        testNotificationMessage: "这是一条真实通知，用于验证通知与任务栏链路。",
        notificationDenied: "浏览器已阻止通知，请在站点设置中允许",
        notificationUnavailable: "当前浏览器或 WebView 不支持系统通知"
      },
      en: {
        connectionLost: "DSH connection lost",
        reconnecting: "The current session may be paused; reconnecting",
        waitTitle: "Session is waiting for your {kind}",
        approval: "approval",
        planReview: "plan review",
        question: "answer",
        completed: "Current session completed",
        interrupted: "Session interrupted or paused",
        genericInterrupted: "The run did not finish normally",
        agentError: "Runtime error: {reason}",
        promptError: "Operation failed: {reason}",
        openError: "The session window failed to load",
        turnError: "This turn ended with an error",
        maxTokens: "This turn reached the output limit",
        interruptedTurn: "This turn was interrupted",
        removed: "The session was stopped or removed",
        notifications: "System notifications",
        notificationsDescription: "Alerts the current session while the page is hidden or unfocused; sound follows system notification settings.",
        enableNotifications: "Enable system notifications",
        enabledNotifications: "System notifications are enabled",
        testNotification: "Send test notification",
        testNotificationSent: "Test notification sent",
        testNotificationFailed: "Test notification failed",
        testNotificationTitle: "DSH notification test",
        testNotificationMessage: "This is a real notification to verify the notification and taskbar path.",
        notificationDenied: "Browser notifications are blocked; allow them in site settings",
        notificationUnavailable: "System notifications are unavailable in this browser or WebView"
      }
    };

    const CSS = `
      .dshss-settings-row {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        min-height: 58px;
        padding: 10px 0;
        color: var(--dsw-alias-label-primary, #202124);
        font-family: var(--dsw-font-family, inherit);
      }
      .dshss-settings-copy {
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

    function isEnglish() {
      if (typeof document !== "undefined" && /^en(?:-|$)/i.test(document.documentElement?.lang || "")) return true;
      if (typeof navigator !== "undefined" && /^en(?:-|$)/i.test(navigator.language || "")) return true;
      return false;
    }

    function hasNativeShellNotify() {
      try {
        const shell = typeof window !== "undefined" ? window.dshShell : void 0;
        return shell !== void 0 && typeof shell.notify === "function";
      } catch {
        return false;
      }
    }

    function readNotificationPermission() {
      if (hasNativeShellNotify()) return "native";
      if (typeof Notification === "undefined") return "unsupported";
      try {
        return Notification.permission || "default";
      } catch {
        return "unsupported";
      }
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

    function pendingKind(text, kind) {
      if (kind === "approval") return text.approval;
      if (kind === "plan-review") return text.planReview;
      return text.question;
    }

    // `identity` 是等待交互的对象身份序号（见 createStatusModel 里的 pendingIdentities），
    // 不是它自己的 kind：同 kind 的先后两次等待必须是两个不同的键。
    function pendingKey(sessionId, identity) {
      return `pending:${sessionId}:${identity}`;
    }

    function installStyle() {
      if (typeof document === "undefined" || document.head === null) return () => {};
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

    function detailOf(snapshot) {
      const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
      const last = nodes.length > 0 ? nodes[nodes.length - 1] : void 0;
      const promptError = snapshot?.promptError;
      const promptErrorData = promptError?.error;
      return {
        running: snapshot?.running === true,
        lastAgentError: compactMessage(snapshot?.lastAgentError),
        promptErrorMessage: compactMessage(promptErrorData?.message),
        promptErrorCode: compactMessage(promptErrorData?.code),
        promptErrorOp: typeof promptError?.op === "string" ? promptError.op : "",
        openState: typeof snapshot?.openState === "string" ? snapshot.openState : "",
        removed: snapshot?.removed === true,
        lastNodeSeq: typeof last?.seq === "number" ? last.seq : void 0,
        lastNodeKind: typeof last?.kind === "string" ? last.kind : "",
        lastNodeInterrupted: last?.interrupted === true
      };
    }

    function changedToNonEmpty(before, after) {
      return before === "" && after !== "";
    }

    function isTerminalErrorNode(detail) {
      return detail.lastNodeKind === "turn-error"
        || detail.lastNodeKind === "turn-max-tokens"
        || detail.lastNodeInterrupted === true;
    }

    function classifyDetail(detail, text) {
      if (detail.removed) return text.removed;
      if (detail.lastAgentError !== "") return text.agentError.replace("{reason}", detail.lastAgentError);
      if (detail.promptErrorMessage !== "") {
        const suffix = detail.promptErrorCode === ""
          ? detail.promptErrorMessage
          : `${detail.promptErrorCode}: ${detail.promptErrorMessage}`;
        return text.promptError.replace("{reason}", suffix);
      }
      if (detail.openState === "error") return text.openError;
      if (detail.lastNodeKind === "turn-error") return text.turnError;
      if (detail.lastNodeKind === "turn-max-tokens") return text.maxTokens;
      if (detail.lastNodeInterrupted) return text.interruptedTurn;
      return "";
    }

    function createStatusModel(ctx, sessions, uiSession) {
      const text = isEnglish() ? COPY.en : COPY.zh;
      const listeners = new Set();
      const previous = new Map();
      const deliveredKeys = new Set();
      // dsh 0.1.7：等待交互不再是列表行上的字符串，而是域拥有的对象
      // （PendingApproval / PendingQuestion，带 key、kind、sessionId）。
      // 同一个等待请求在多次状态快照之间保持同一对象身份（官方 `sameSessionStatus` 也按
      // `pendingInteraction` 的 `!==` 判断变化），所以这里按对象身份去重：
      // WeakMap 记对象 → 单调序号，同对象复用序号，新对象必得新序号。
      const pendingIdentities = new WeakMap();
      let pendingSequence = 0;
      let currentSessionId;
      let currentTitle = "";
      let currentDetail;
      let currentDetailUnsubscribe = () => {};
      let terminalNoticeSent = false;
      let terminalSequence = 0;
      let notificationPermission = readNotificationPermission();
      let connectedOnce = false;
      let connectionLost = false;
      let connectionSequence = 0;
      let testSequence = 0;
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

      const getSnapshot = () => ({ notificationPermission });

      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };

      const nativeShellNotify = (notice) => {
        try {
          const payload = {
            type: `${PLUGIN_ID}/notify`,
            kind: notice.kind,
            title: notice.title,
            message: notice.message
          };
          const shell = typeof window !== "undefined" ? window.dshShell : void 0;
          if (shell !== void 0 && typeof shell.notify === "function") {
            shell.notify(payload);
            return true;
          }
          const webview = typeof window !== "undefined" ? window.chrome?.webview : void 0;
          if (webview !== void 0 && typeof webview.postMessage === "function") {
            webview.postMessage(payload);
            return true;
          }
          return false;
        } catch (error) {
          console.error(`[${PLUGIN_ID}] native shell notification failed`, error);
          return false;
        }
      };

      const systemNotify = (notice, allowForeground = false) => {
        if (!allowForeground && !pageIsBackground()) return false;
        if (nativeShellNotify(notice)) return true;
        if (notificationPermission !== "granted") return false;
        if (typeof Notification === "undefined") return false;
        try {
          const system = new Notification(notice.title, {
            body: notice.message,
            tag: `${PLUGIN_ID}:${notice.key}`,
            renotify: true,
            silent: false,
            requireInteraction: notice.kind === "pending" || notice.kind === "interrupted" || notice.kind === "connection"
          });
          system.onclick = () => {
            try {
              if (notice.sessionId !== void 0) sessions.open(notice.sessionId);
            } catch (error) {
              console.error(`[${PLUGIN_ID}] could not open session`, error);
            }
            try {
              if (typeof window !== "undefined") window.focus();
            } catch {}
            try {
              system.close();
            } catch {}
          };
          return true;
        } catch (error) {
          console.error(`[${PLUGIN_ID}] system notification failed`, error);
          return false;
        }
      };

      const sendTestNotification = () => systemNotify({
        key: `test:${++testSequence}`,
        kind: "test",
        title: text.testNotificationTitle,
        message: text.testNotificationMessage
      }, true);

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
        const prefix = `pending:${sessionId}:`;
        for (const key of [...deliveredKeys]) {
          if (key.startsWith(prefix)) deliveredKeys.delete(key);
        }
      };

      const notifyCurrentTerminal = (detail, fallbackTitle) => {
        if (currentSessionId === void 0 || terminalNoticeSent) return;
        terminalNoticeSent = true;
        const reason = classifyDetail(detail, text);
        const abnormal = reason !== "";
        const title = abnormal ? text.interrupted : text.completed;
        const message = abnormal
          ? `${fallbackTitle || currentTitle || currentSessionId}：${reason || text.genericInterrupted}`
          : (fallbackTitle || currentTitle || currentSessionId);
        pushSystemNotice({
          key: `terminal:${currentSessionId}:${++terminalSequence}`,
          kind: abnormal ? "interrupted" : "completed",
          sessionId: currentSessionId,
          title,
          message
        });
      };

      const observeCurrentDetail = (nextSnapshot) => {
        if (disposed || currentSessionId === void 0) return;
        const next = detailOf(nextSnapshot);
        const before = currentDetail;
        if (before === void 0) {
          currentDetail = next;
          return;
        }
        if (!before.running && next.running) terminalNoticeSent = false;
        const errorAppeared = changedToNonEmpty(before.lastAgentError, next.lastAgentError)
          || changedToNonEmpty(before.promptErrorMessage, next.promptErrorMessage)
          || (before.openState !== "error" && next.openState === "error")
          || (!before.removed && next.removed)
          || (next.lastNodeSeq !== before.lastNodeSeq && isTerminalErrorNode(next));
        if (errorAppeared) {
          notifyCurrentTerminal(next, currentTitle);
        } else if (before.running && !next.running) {
          notifyCurrentTerminal(next, currentTitle);
        }
        currentDetail = next;
      };

      const disposeCurrentDetail = () => {
        try {
          currentDetailUnsubscribe();
        } catch (error) {
          console.error(`[${PLUGIN_ID}] current session unsubscribe failed`, error);
        }
        currentDetailUnsubscribe = () => {};
        currentDetail = void 0;
      };

      const bindCurrentSession = (sessionId) => {
        disposeCurrentDetail();
        currentSessionId = sessionId;
        currentTitle = sessionId || "";
        terminalNoticeSent = false;
        if (sessionId === void 0 || typeof sessions?.binding !== "function") return;
        let binding;
        try {
          binding = sessions.binding(sessionId);
        } catch (error) {
          console.error(`[${PLUGIN_ID}] current session binding failed`, error);
          return;
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
          currentDetailUnsubscribe = () => {};
        }
      };

      // 等待交互的对象身份 → 去重序号。
      const identityOf = (interaction) => {
        const known = pendingIdentities.get(interaction);
        if (known !== void 0) return known;
        const assigned = ++pendingSequence;
        pendingIdentities.set(interaction, assigned);
        return assigned;
      };

      // dsh 0.1.7：运行/等待状态改由官方 `ctx.uiSession.sessionStatus` 提供，
      // 快照是 ReadonlyMap<SessionId, SessionStatus>（含 running / pendingInteraction /
      // completionUnread），不再是列表行字段。它是列表行的超集（byId 的键一定在内）。
      // 技术债：SessionStatus 还带 `completionUnread`（后台会话"完成未读"标记），
      // 但本插件按"只关心当前会话"的要求不通知后台会话，所以本次适配不消费它；
      // 将来若要补后台完成提醒，直接从这里的快照字段读，不必再换来源。
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

      // dsh 0.1.7：列表快照不再带 `current`，"当前会话"改由官方 session 作用域绑定的
      // 身份给出（`ctx.uiSession.adapter.current`，标准源 `key` 就是 SessionId；
      // 无选中会话时 key 为 undefined）。这里只是读取方，不复制它的选择语义。
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
        if (rows === null || typeof rows !== "object") return;
        // 标题与归属仍来自官方列表快照（byId 行），运行/等待状态来自 sessionStatus。
        const statuses = readSessionStatus();
        if (statuses === void 0) return;
        const nextCurrentId = readCurrentSessionId();
        const selectionChanged = nextCurrentId !== currentSessionId;
        if (selectionChanged) bindCurrentSession(nextCurrentId);
        const seen = new Set();

        for (const [sessionId, status] of statuses) {
          seen.add(sessionId);
          const row = rows[sessionId];
          const old = previous.get(sessionId);
          // `running === true` 才是运行中；undefined（尚未有基线）按未运行处理。
          const running = status?.running === true;
          const interaction = status?.pendingInteraction;
          const pending = interaction === void 0 ? void 0 : pendingKey(sessionId, identityOf(interaction));
          const oldPending = old?.pending;
          const isCurrent = sessionId === nextCurrentId;
          if (pending === void 0) {
            if (oldPending !== void 0) deliveredKeys.delete(oldPending);
          } else if (isCurrent && oldPending !== pending) {
            const sessionTitle = titleOf(row, sessionId);
            currentTitle = sessionTitle;
            pushSystemNotice({
              key: pending,
              kind: "pending",
              sessionId,
              title: text.waitTitle.replace("{kind}", pendingKind(text, interaction.kind)),
              message: sessionTitle
            });
          }

          if (isCurrent) {
            currentTitle = titleOf(row, sessionId);
            if (!selectionChanged && old?.running === true && !running) {
              notifyCurrentTerminal(currentDetail || { running: false }, currentTitle);
            }
            if (running && old?.running !== true) terminalNoticeSent = false;
          }
          previous.set(sessionId, { pending, running });
        }

        for (const sessionId of [...previous.keys()]) {
          if (seen.has(sessionId)) continue;
          previous.delete(sessionId);
          removeDeliveredForSession(sessionId);
        }
      }

      const markConnectionLost = () => {
        if (!connectedOnce || connectionLost) return;
        connectionLost = true;
        connectionSequence += 1;
        pushSystemNotice({
          key: `connection-lost:${connectionSequence}`,
          kind: "connection",
          title: text.connectionLost,
          message: text.reconnecting
        });
        console.warn(`[${PLUGIN_ID}] connection lost; waiting for official reconnect loop`);
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

      // dsh 0.1.7：连接源从 `hostDescription`（字符串描述）改为 `state` 三态字符串
      // `'connected' | 'disconnected' | 'connecting'`，首次尝试有结果之前为 undefined。
      // 只有 `'connected'` 代表可用连接；其余情况（含 `'connecting'`）都走掉线判定——
      // 官方在浏览器在线时的 socket 断开只经过 `'connecting'`（重连循环），仅浏览器离线才给
      // `'disconnected'`，若只认 `'disconnected'` 会漏掉最常见的掉线告警。
      // 重复的 `'connecting'` 不会重复告警：markConnectionLost 自带 connectedOnce/connectionLost 幂等保护。
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
        else markConnectionLost();
      };

      const requestPermission = async () => {
        if (hasNativeShellNotify()) {
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
          notificationPermission = readNotificationPermission();
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
      // 0.1.7 里运行/等待状态与"当前会话"是 uiSession 的两条独立来源，各自推送变化：
      // 状态快照（running / pendingInteraction）与当前会话作用域绑定（adapter.current）。
      // 两条都触发同一个 syncSessions()，让它把"列表标题 + 状态"合成一次判断。
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
        notificationPermission = readNotificationPermission();
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

      return {
        getSnapshot,
        subscribe,
        requestPermission,
        sendTestNotification,
        text
      };
    }

    function NotificationSettingsRow({ model }) {
      const [, rerender] = useState(0);
      const [requesting, setRequesting] = useState(false);
      const [testResult, setTestResult] = useState("");
      useEffect(() => model.subscribe(() => rerender((value) => value + 1)), [model]);
      useEffect(() => {
        if (testResult === "") return;
        const timer = setTimeout(() => setTestResult(""), 2200);
        return () => clearTimeout(timer);
      }, [testResult]);
      const snapshot = model.getSnapshot();
      const text = model.text;
      const canTest = snapshot.notificationPermission === "native" || snapshot.notificationPermission === "granted";
      const testButton = canTest ? h("button", {
        className: "dshss-settings-button",
        type: "button",
        onClick: () => setTestResult(model.sendTestNotification() ? "sent" : "failed")
      }, testResult === "sent"
        ? text.testNotificationSent
        : testResult === "failed" ? text.testNotificationFailed : text.testNotification) : null;
      let control;
      if (snapshot.notificationPermission === "native") {
        control = h("div", { className: "dshss-settings-actions" },
          h("span", { className: "dshss-settings-status" }, text.enabledNotifications),
          testButton
        );
      } else if (snapshot.notificationPermission === "default") {
        control = h("button", {
          className: "dshss-settings-button",
          type: "button",
          disabled: requesting,
          onClick: () => {
            setRequesting(true);
            Promise.resolve(model.requestPermission()).then(() => {}, () => {}).then(() => setRequesting(false));
          }
        }, text.enableNotifications);
      } else if (snapshot.notificationPermission === "granted") {
        control = h("div", { className: "dshss-settings-actions" },
          h("span", { className: "dshss-settings-status" }, text.enabledNotifications),
          testButton
        );
      } else if (snapshot.notificationPermission === "denied") {
        control = h("span", { className: "dshss-settings-status" }, text.notificationDenied);
      } else {
        control = h("span", { className: "dshss-settings-status" }, text.notificationUnavailable);
      }
      return h("div", { className: "dshss-settings-row" },
        h("div", { className: "dshss-settings-copy" },
          h("div", { className: "dshss-settings-title" }, text.notifications),
          h("div", { className: "dshss-settings-description" }, text.notificationsDescription)
        ),
        control
      );
    }

    const inject = ["slots", "sessions", "connection", "uiSession"];

    function apply(ctx) {
      const model = createStatusModel(ctx, ctx.sessions, ctx.uiSession);
      ctx.effect(installStyle, `${PLUGIN_ID}: stylesheet`);
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "session-notifications",
        order: 30
      }, () => h(NotificationSettingsRow, { model })));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
