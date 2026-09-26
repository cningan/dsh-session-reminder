import { createDecider } from "../core/decide.mjs";
import { dictionaries, pendingKind, terminalText } from "../core/text.mjs";
import {
  createDelivery,
  DELIVERY_OUTCOMES,
  hasNativeBridge,
  readBrowserPermission,
  readUserActivation
} from "./delivery.mjs";

export function createPlugin(loadModule) {
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

    // 诊断上报：把运行时的关键判定交给 Host 半边落盘（profile 下的 diagnostics.jsonl），
    // 用于事后审计"边沿是否被观察到 / 当时是否失焦 / 投递结果如何"。
    // 上报失败绝不影响提醒行为本身。
    function reportDiagnostic(event, payload) {
      if (typeof fetch !== "function") return;
      try {
        const body = JSON.stringify({ at: new Date().toISOString(), event, payload });
        void fetch(DIAGNOSTICS_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: true
        }).catch(() => {});
      } catch {}
    }

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

    // 渠道选择、平台事件、通知 tag 与权限读取都在 client/delivery；这里只剩
    // 「页面是否在前台」这条**投递前的否决**——它是装配层的决定，不是渠道的事实。
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

    // 语义判定在 core/decide（纯 module、可直测）；投递层只做两件事：
    // 把 notice 映射成本地化文案，以及把 notice 交给渠道。这里处理 terminal 那一类。
    function terminalNoticeText(notice, t) {
      // reason/detail 正是 core/text 的输入；`completed` 没有正文，`interrupted` 退回通用说明。
      const text = terminalText({ reason: notice.reason, detail: notice.detail, silent: false }, t);
      const completed = notice.reason === "completed";
      const unknown = text === "" && !completed;
      const separator = t("separator");
      const title = text !== "" || unknown ? t("interrupted") : t("completed");
      const message = text !== ""
        ? `${notice.title}${separator}${text}`
        : unknown ? `${notice.title}${separator}${t("unknownStopped")}` : notice.title;
      return { title, message, kind: text !== "" || unknown ? "interrupted" : "completed" };
    }

    function createStatusModel(ctx, sessions, uiSession, t) {
      const listeners = new Set();
      const deliveredKeys = new Set();
      // 判定核心自己持有判定状态（上一轮快照、每会话 run 序号、等待/停止是否已提醒）；
      // 装配层只按时间顺序喂归一化后的领域快照，拿回这一轮该产出的提醒。
      const decider = createDecider();
      // 投递去重键：等待按「会话 + 交互对象身份」唯一——同一个等待请求在多次快照之间保持同一
      // 对象身份，所以同一等待只投一次，等待结束即释放键；停止键逐条唯一。
      // 这是**投递层**自己的去重（notice 不带键），与 core/decide 的 per-run 去重是两件事。
      const pendingIdentities = new WeakMap();
      let pendingSequence = 0;
      /** sessionId → 本轮那个等待的投递键；等待结束就删掉（同时释放已投递键）。 */
      const pendingKeys = new Map();
      // 每会话上一轮观察到的 running：只用来给「事件窗口缓存」定界——上一轮的 turn/end 原因
      // 与详情不能留给下一轮（见 syncSessions）。它不参与任何提醒判定。
      const previousRunning = new Map();
      // 诊断用：这些会话「本 run 已经产出过提醒」（判定状态在 core/decide 里，这里只为了让
      // 「观察到停止边沿但没有提醒」那条诊断记录与判定同形，见 syncSessions）。不参与判定。
      const handledRuns = new Set();
      // 停止提醒的投递键序号（逐条唯一即可，判定层不关心它是第几个 run）。
      let terminalNoticeSequence = 0;
      let currentSessionId;
      let currentDetail;
      let currentDetailUnsubscribe = () => {};
      let currentEventUnsubscribe = () => {};
      let currentEventSequence = -1;
      let currentTurnEndReason;
      let notificationPermission;
      let connectedOnce = false;
      let connectionLost = false;
      let testSequence = 0;
      let lastStatusSignature = "";
      // 测试模式：忽略前台抑制，便于在窗口仍在前台时直接验证投递通道与参数。
      // 仅用于诊断对照，默认关闭，并在诊断记录里标记。
      let testMode = false;
      // 最近一次诊断（内存态，供设置区显示）：不开 DevTools 也能看出链路卡在哪一环。
      let diagnostics = { status: null, edge: null, deliver: null, page: null };
      let disposed = false;
      const now = () => new Date();

      const notify = () => {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            console.error(`[${PLUGIN_ID}] settings listener failed`, error);
          }
        }
      };

      // 投递层（`client/delivery`）：渠道顺序、平台事件、通知 tag 与权限读取都在那里。
      // 它只投递与回报，不含判定语义；前台否决（见 `systemNotify`）与 `deliveredKeys`
      // 记账留在这一层。诊断上报走注入的 sink（下一票把它整体抽成 client/diagnostics-sink）。
      const delivery = createDelivery({
        pluginId: PLUGIN_ID,
        report: reportDiagnostic,
        // 平台事件回灌：只更新内存诊断并触发一次重渲染，判断仍由读方（settings 区/diagnose）做。
        onPlatform: (feedback) => {
          diagnostics = {
            ...diagnostics,
            deliver: {
              ...(diagnostics.deliver ?? { key: feedback.key, kind: feedback.kind }),
              platform: feedback.error === void 0 || feedback.error === null
                ? feedback.event
                : `${feedback.event}: ${feedback.error}`
            }
          };
          notify();
        },
        now,
        openSession: (sessionId) => sessions.open(sessionId),
        onError: (label, error) => console.error(`[${PLUGIN_ID}] ${label}`, error)
      });
      notificationPermission = delivery.permission();

      const getSnapshot = () => ({ notificationPermission, diagnostics, testMode });

      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };

      // 详情快照的领域形状：只抽出 classifyDetail 消费的字段，core 不依赖官方快照的其余字段。
      const detailShapeOf = (snapshot) => {
        if (snapshot === null || typeof snapshot !== "object") return void 0;
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
      };

      // 等待交互的对象身份 → 投递键序号：同一对象复用序号，新对象必得新序号。
      const identityOf = (interaction) => {
        const known = pendingIdentities.get(interaction);
        if (known !== void 0) return known;
        const assigned = ++pendingSequence;
        pendingIdentities.set(interaction, assigned);
        return assigned;
      };

      // notice 是 core/decide 的产出（不含文案）：投递层负责文案映射、键与渠道。
      const deliverNotice = (notice) => {
        if (notice.kind === "pending") {
          pushSystemNotice({
            key: pendingKeys.get(notice.sessionId) ?? `pending:${notice.sessionId}:${++pendingSequence}`,
            kind: "pending",
            sessionId: notice.sessionId,
            title: t("waitTitle", { kind: pendingKind(t, notice.reason) }),
            message: notice.title
          });
          return;
        }
        const terminal = terminalNoticeText(notice, t);
        pushSystemNotice({
          key: `terminal:${notice.sessionId}:${++terminalNoticeSequence}`,
          kind: terminal.kind,
          sessionId: notice.sessionId,
          title: terminal.title,
          message: terminal.message
        });
      };

      // 前台否决留在装配层：页面在前台（且不在测试模式时）不投递，但仍然记账、
      // 仍然上报一条可区分的投递记录（读方据此区分「按设计静默」与「投递故障」）。
      // 真正投递一条提醒交给 delivery，它回报渠道与结果；这里只把结果并进内存诊断。
      const systemNotify = (notice, allowForeground = false) => {
        const background = pageIsBackground();
        const record = (channel, delivered) => ({
          key: notice.key,
          kind: notice.kind,
          channel,
          delivered,
          background,
          at: now().toLocaleTimeString(),
          activation: readUserActivation(),
          testMode
        });
        const report = (channel, delivered) => reportDiagnostic("deliver", {
          key: notice.key,
          kind: notice.kind,
          sessionId: notice.sessionId ?? null,
          channel,
          delivered,
          background,
          browserPermission: delivery.browserPermission(),
          nativeBridge: delivery.nativeBridge(),
          userActivation: readUserActivation()
        });
        if (!allowForeground && !testMode && !background) {
          diagnostics = { ...diagnostics, deliver: record("suppressed-foreground", false) };
          notify();
          report("suppressed-foreground", false);
          return false;
        }
        const result = delivery.deliver(notice, { background });
        diagnostics = { ...diagnostics, deliver: record(result.channel, result.delivered) };
        notify();
        // 原生桥没接住时本次投递走到了浏览器那一步，模型上的权限状态跟着刷新
        // （与旧实现同一时机：只有原生路径失败才会重新读浏览器权限）。
        if (result.outcome !== DELIVERY_OUTCOMES.NATIVE_BRIDGE
          && notificationPermission !== result.browserPermission) {
          notificationPermission = result.browserPermission;
          notify();
        }
        return result.delivered;
      };

      const sendTestNotification = () => systemNotify({
        key: `test:${++testSequence}`,
        kind: "test",
        title: t("testNotificationTitle"),
        message: t("testNotificationMessage")
      }, true);

      // 调试探针（**仅调试构建**）：与自检同参数的载荷，但遵守前台规则（除非处于测试模式）。
      // `kind` 可参数化：`test` 对比自动提醒的 `interrupted`，用于逐个变量对照。
      // 整个块由构建期常量包裹，正式产物里不存在这些能力。
      let sendProbe = null;
      let sendProbeBurst = null;
      let sendDelayedProbe = null;
      if (__DEBUG__) {
        sendProbe = (kind = "test") => systemNotify({
          key: `test-probe:${kind}:${++testSequence}`,
          kind,
          title: kind === "test" ? t("testNotificationTitle") : t("interrupted"),
          message: t("testNotificationMessage")
        }, false);

        // 连发探针：同一参数连投 count 条（tag 逐条唯一），用于检测"间歇性不显示"。
        sendProbeBurst = (kind = "test", count = 3, gapMs = 2000) => {
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

        sendDelayedProbe = (delayMs = 10000, kind = "test") => {
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

      // 会话消失（归档/移除）时释放它留下的投递键，避免下次同名会话被旧键挡住。
      const removeDeliveredForSession = (sessionId) => {
        const prefixes = [`pending:${sessionId}:`, `terminal:${sessionId}:`];
        for (const key of [...deliveredKeys]) {
          if (prefixes.some((prefix) => key.startsWith(prefix))) deliveredKeys.delete(key);
        }
      };

      const observeCurrentEventWindow = (snapshot, seed = false) => {
        if (disposed || currentSessionId === void 0) return;
        // Host SessionEventWindow exposes events/target; a mismatched Client snapshot degrades to unknown cause.
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
        // 详情只贡献「原因 / 移除」数据，停止边沿由全会话状态映射负责。
        // 归一化（官方快照 → 领域形状）在 syncSessions 里做，这里先原样留住这一轮的快照。
        currentDetail = nextSnapshot;
      };

      const rebaseCurrentDetailForRun = () => {
        if (currentDetail === void 0) return;
        // 新的 run 不带上一轮的原因；原始快照整体丢弃即可，分类器对空对象无话可说。
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
        currentDetailUnsubscribe = () => {};
        currentEventUnsubscribe = () => {};
        currentDetail = void 0;
        currentEventSequence = -1;
        currentTurnEndReason = void 0;
      };

      const bindCurrentSession = (sessionId) => {
        disposeCurrentDetail();
        currentSessionId = sessionId;
        if (sessionId === void 0 || typeof sessions?.binding !== "function") return;
        let binding;
        try {
          binding = sessions.binding(sessionId);
        } catch (error) {
          console.error(`[${PLUGIN_ID}] current session binding failed`, error);
          return;
        }
        const eventSource = binding?.eventSource;
        if (eventSource !== void 0 && typeof eventSource.getSnapshot === "function"
          && typeof eventSource.subscribe === "function") {
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
            currentEventUnsubscribe = () => {};
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
          currentDetailUnsubscribe = () => {};
        }
      };

      // dsh 0.1.7：运行/等待状态由官方 `ctx.uiSession.sessionStatus` 提供，
      // 是覆盖会话列表的 ReadonlyMap<SessionId, SessionStatus>，含 running、
      // pendingInteraction 与 completionUnread。只有已观察到的运行边沿用于确认停止；
      // completionUnread 仅表示结果未读，不单独触发通知，也不证明停止原因或成功。
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
        if (rows === null || typeof rows !== "object") {
          reportDiagnostic("source-shape", {
            stage: "list",
            byIdType: typeof rows,
            snapshotKeys: snapshot !== null && typeof snapshot === "object" ? Object.keys(snapshot) : null
          });
          return;
        }
        // 标题与归属仍来自官方列表快照（byId 行），运行/等待状态来自 sessionStatus。
        const statuses = readSessionStatus();
        if (statuses === void 0) {
          reportDiagnostic("source-shape", { stage: "status", reason: "sessionStatus is not a Map snapshot" });
          return;
        }
        const nextCurrentId = readCurrentSessionId();
        if (nextCurrentId !== currentSessionId) bindCurrentSession(nextCurrentId);

        // 事件窗口缓存只在本轮 run 内有效：当前会话进入新一轮（上一轮没在跑、这一轮在跑）时，
        // 上一轮的 turn/end 原因与详情不能留给这一轮——否则新的一轮可能被谎报成上一轮的结果。
        // 「哪一轮」由 core/decide 持有；这里只为自己的缓存定界，不产出任何提醒。
        const currentRunning = nextCurrentId === void 0 ? false : statuses.get(nextCurrentId)?.running === true;
        if (previousRunning.get(nextCurrentId) === false && currentRunning) {
          currentTurnEndReason = void 0;
          rebaseCurrentDetailForRun();
        }

        // 装配层只做归一化：官方两条来源（列表行 + 会话状态）→ 领域快照。
        // 判定「这一轮该产出哪些提醒」交给 core/decide；等待去重按 pending 对象的同一性。
        const domainSessions = [];
        const domainById = new Map();
        const nextPendingKeys = new Map();
        for (const [sessionId, status] of statuses) {
          const interaction = status?.pendingInteraction ?? null;
          const session = {
            id: sessionId,
            title: titleOf(rows[sessionId], sessionId),
            running: status?.running === true,
            pending: interaction,
            unread: status?.completionUnread === true,
            inList: rows[sessionId] !== void 0
          };
          domainSessions.push(session);
          domainById.set(sessionId, session);
          if (interaction !== null) nextPendingKeys.set(sessionId, `pending:${sessionId}:${identityOf(interaction)}`);
          // 新的 run：本 run 的「已提醒」位跟着重置（与 core/decide 的 run 序号同步推进）。
          if (session.running && previousRunning.get(sessionId) === false) handledRuns.delete(sessionId);
        }
        // 等待结束就释放它的投递键，这样下一次等待（哪怕是同一个对象）能重新投递。
        for (const [sessionId, staleKey] of [...pendingKeys]) {
          if (nextPendingKeys.has(sessionId)) continue;
          deliveredKeys.delete(staleKey);
          pendingKeys.delete(sessionId);
        }
        for (const [sessionId, key] of nextPendingKeys) pendingKeys.set(sessionId, key);

        const notices = decider.observe({
          sessions: domainSessions,
          currentId: nextCurrentId,
          current: currentSessionId === void 0 ? void 0 : {
            removed: currentDetail?.removed === true,
            turnEnd: currentTurnEndReason,
            detail: detailShapeOf(currentDetail)
          }
        });
        const hasTurnEndReason = currentTurnEndReason !== void 0;
        for (const notice of notices) {
          // 边沿诊断与既有契约同形：pending 带上游交互 kind，terminal 带是否选中会话/有无 turn/end 原因。
          const reported = notice.kind === "pending"
            ? {
              sessionId: notice.sessionId,
              kind: "pending",
              interactionKind: domainById.get(notice.sessionId)?.pending?.kind ?? null
            }
            : {
              sessionId: notice.sessionId,
              kind: "terminal",
              suppressed: null,
              isCurrent: notice.sessionId === nextCurrentId,
              hasTurnEndReason
            };
          diagnostics = {
            ...diagnostics,
            edge: notice.kind === "pending" ? { ...reported, suppressed: null } : reported
          };
          reportDiagnostic("edge", reported);
          deliverNotice(notice);
          handledRuns.add(notice.sessionId);
        }
        // core/decide 只产出「该提醒」的边沿：被抑制（列表行不在，可能是归档/移除）与静默
        // （用户取消、已显式移除）的停止边沿没有 notice。诊断回路需要「边沿被观察到、只是没有
        // 投递」这条证据——读方据此区分『边沿被抑制』与『还没观察到边沿』——所以这里按同一份
        // running 记账补一条同形的记录。它只写诊断，不参与任何提醒判定。
        const notified = new Set(notices.map((notice) => notice.sessionId));
        for (const session of domainSessions) {
          if (notified.has(session.id) || handledRuns.has(session.id)) continue;
          if (previousRunning.get(session.id) !== true || session.running) continue;
          handledRuns.add(session.id);
          const isCurrent = session.id === nextCurrentId;
          const record = session.inList === false
            ? { sessionId: session.id, kind: "terminal", suppressed: "missing-list-row", isCurrent }
            : { sessionId: session.id, kind: "terminal", suppressed: null, isCurrent, hasTurnEndReason };
          diagnostics = { ...diagnostics, edge: record };
          reportDiagnostic("edge", record);
          notify();
        }

        // 记账本轮的 running，供下一轮判定「新一轮」；消失的会话连同它的投递键一并清掉。
        for (const session of domainSessions) previousRunning.set(session.id, session.running);
        for (const sessionId of [...previousRunning.keys()]) {
          if (statuses.has(sessionId)) continue;
          previousRunning.delete(sessionId);
          handledRuns.delete(sessionId);
          pendingKeys.delete(sessionId);
          removeDeliveredForSession(sessionId);
        }

        // 状态源摘要（内容变化才上报）：确认 running 边沿到底有没有出现在官方
        // `uiSession.sessionStatus` 里、当前会话是否在状态/列表快照内。
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

      // dsh 0.1.7：连接源为 `'connected' | 'disconnected' | 'connecting'`。
      // 非 connected 只用于标记传输暂时不可用，不代表某个会话已停止，因此不发送会话提醒；
      // 恢复连接后重新同步会话状态。
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
        // 权限读取与请求都在 delivery：这里只把结果并回模型状态并决定要不要重同步。
        const outcome = await delivery.requestPermission();
        notificationPermission = outcome.permission;
        notify();
        if (outcome.resync) syncSessions();
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
        notificationPermission = delivery.permission();
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

      // 测试模式开关（**仅调试构建**）：忽略前台抑制，便于在窗口前台验证投递参数。
      let setTestMode = null;
      if (__DEBUG__) {
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
        ...(__DEBUG__ ? { sendProbe, sendProbeBurst, sendDelayedProbe, setTestMode } : {})
      };
    }

    // 插件配置页（setting section）的内容区；标题由 slot 注册的 label 提供。
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
      }, testResult === "sent"
        ? t("testNotificationSent")
        : testResult === "failed" ? t("testNotificationFailed") : t("testNotification")) : null;
      // 诊断工具与诊断区都属于**调试模式专属**：整块由构建期常量 `__DEBUG__` 包裹，
      // 正式构建会在打包时移除这段代码（诊断上报本身保留，供 Host 侧落盘审计）。
      let probeButton = null;
      let probeInterruptedButton = null;
      let burstButton = null;
      let testModeButton = null;
      if (__DEBUG__) {
        // 探针：点击**立即**投递——配合测试模式即可在前台验证；未开测试模式且页面在
        // 前台时按设计被抑制，并在诊断里显示原因。
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
        // 连发探针：同参数连投 3 条（间隔 2 秒），一次点击即可看出是否"间歇性丢失"。
        burstButton = canTest ? h("button", {
          className: "dshss-settings-button",
          type: "button",
          onClick: () => {
            model.sendProbeBurst("test", 3);
            setTestResult("probe-fired");
          }
        }, testResult === "probe-fired" ? t("probeFired") : t("probeBurst")) : null;
        // 测试模式开关：打开后即使页面在前台也投递，便于在窗口前直接验证参数组合。
        testModeButton = canTest ? h("button", {
          className: "dshss-settings-button",
          type: "button",
          onClick: () => model.setTestMode(!snapshot.testMode)
        }, snapshot.testMode ? t("testModeOn") : t("testMode")) : null;
      }
      let control;
      if (snapshot.notificationPermission === "native") {
        control = h("div", { className: "dshss-settings-actions" },
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
            Promise.resolve(model.requestPermission()).then(() => {}, () => {}).then(() => setRequesting(false));
          }
        }, t("enableNotifications"));
      } else if (snapshot.notificationPermission === "granted") {
        control = h("div", { className: "dshss-settings-actions" },
          h("span", { className: "dshss-settings-status" }, t("enabledNotifications")),
          testButton
        );
      } else if (snapshot.notificationPermission === "denied") {
        control = h("span", { className: "dshss-settings-status" }, t("notificationDenied"));
      } else {
        control = h("span", { className: "dshss-settings-status" }, t("notificationUnavailable"));
      }
      // 诊断块：整段包在 `if (__DEBUG__)` 里，正式构建下由打包器移除（含其中所有文案）。
      let diagnosticLines = [];
      if (__DEBUG__) {
        const d = snapshot.diagnostics ?? {};
        const pageBackground = typeof document === "undefined"
          ? false
          : document.visibilityState === "hidden"
            || (typeof document.hasFocus === "function" && document.hasFocus() === false);
        diagnosticLines = [
          `诊断·状态源 ${d.status?.statusEntries ?? "?"} 条；当前会话在状态 ${d.status ? (d.status.currentInStatuses ? "是" : "否") : "?"}；列表含当前 ${d.status ? (d.status.listHandlesCurrent ? "是" : "否") : "?"}；运行中 ${d.status ? d.status.runs.filter((run) => run.running).length : "?"}`,
          d.edge === null || d.edge === undefined
            ? "诊断·边沿 尚未观察到"
            : `诊断·最近边沿 ${d.edge.kind}${d.edge.suppressed === null || d.edge.suppressed === undefined ? "" : `（抑制：${d.edge.suppressed}）`}`,
          d.deliver === null || d.deliver === undefined
            ? "诊断·投递 尚无尝试"
            : `诊断·最近投递 ${d.deliver.at ?? ""} ${d.deliver.kind ?? "?"}/${d.deliver.channel}；已投递 ${d.deliver.delivered ? "是" : "否"}；失焦判定 ${d.deliver.background ? "是" : "否"}；用户激活 ${d.deliver.activation ? (d.deliver.activation.everActive ? "曾有" : "无") : "?"}；平台反馈 ${d.deliver.platform ?? "（无事件）"}`,
          `诊断·当前页面 ${typeof document === "undefined" ? "?" : document.visibilityState}；失焦判定 ${pageBackground ? "是" : "否"}`
        ];
      }
      // 纵向布局：① 主行（描述 + 状态/自检）② 诊断块（全宽可换行）③ 诊断工具行。
      // 诊断文本必须独占整行——放进被按钮挤压的窄列会被压成"每行一个字"。
      return h("div", { className: "dshss-settings" },
        h("div", { className: "dshss-settings-row" },
          h("div", { className: "dshss-settings-copy" },
            h("div", { className: "dshss-settings-description" }, t("notificationsDescription"))
          ),
          control
        ),
        diagnosticLines.length > 0 ? h("div", { className: "dshss-settings-diagnostics" },
          diagnosticLines.map((line, index) => h("div", { key: `dshss-diag-${index}` }, line))
        ) : null,
        __DEBUG__ && canTest ? h("div", { className: "dshss-settings-tools" },
          testModeButton,
          probeButton,
          probeInterruptedButton,
          burstButton
        ) : null
      );
    }

    const inject = ["slots", "locale", "sessions", "connection", "uiSession"];

    function apply(ctx) {
      // 语言跟随 DSH 界面设置：注册官方 locale 字典并把 `t` 交给通知与设置区。
      ctx.effect(() => ctx.locale.register(LOCALE_NS, dictionaries), `${PLUGIN_ID}: dictionaries`);
      const t = ctx.locale.bind(LOCALE_NS);
      // 装载快照：确认 Client 侧确实加载、拿到了哪些官方源，以及当前页面/权限/桥状态。
      reportDiagnostic("attach", {
        hasSessionsList: ctx.sessions?.list !== void 0,
        hasSessionStatus: ctx.uiSession?.sessionStatus !== void 0,
        hasCurrentScope: ctx.uiSession?.adapter?.current !== void 0,
        visibility: typeof document !== "undefined" ? document.visibilityState : null,
        focused: typeof document !== "undefined" && typeof document.hasFocus === "function" ? document.hasFocus() : null,
        browserPermission: readBrowserPermission(),
        nativeBridge: hasNativeBridge(),
        userActivation: readUserActivation()
      });
      const model = createStatusModel(ctx, ctx.sessions, ctx.uiSession, t);
      ctx.effect(installStyle, `${PLUGIN_ID}: stylesheet`);
      // 插件配置页的 section（`settings.section`），不是常规设置页的一行（`settings.general.item`）。
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
