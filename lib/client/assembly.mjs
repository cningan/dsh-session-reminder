/**
 * 装配层（Client 半边唯一的装配处）。
 *
 * 职责边界：**官方源只在本文读取**——`sessions.list`（列表行与打开会话）、
 * `uiSession.sessionStatus`（运行/等待状态）、`uiSession.adapter.current`（当前会话绑定）、
 * `connection.state`（传输状态）。读到的官方**快照片段**在这里交给归一化层
 * （`client/normalize`，纯函数、可直测）变成领域快照，再喂给判定核心；判定核心、投递层、
 * 设置区、诊断上报层都不读官方源。订阅与释放（`ctx.effect`）、前台否决、投递键记账、
 * 内存诊断、调试连接口与 slot 注册也在这里。文案映射在 `core/text`，渠道与平台事件在
 * `client/delivery`，归一化与「页面是否在前台」的唯一判定在 `client/normalize`
 * （前台事实作为**值**流入投递判定、诊断记录、上报与设置区展示），调试能力在
 * `client/debug-tools`。
 *
 * `CLIENT_DEPENDENCIES` 是本插件 Client 依赖清单的**单一来源**：本地服务名与提供它的
 * 官方包名一起声明，`inject`（本地服务名，供运行时注入）与 `package.json` 的
 * `dsh.client.inject`（包名，仅用于排序激活）都由它派生；直测断言两处名单一致
 * （见 test/client-assembly.test.mjs），避免两处名单各自漂移。
 */
import { createDecider } from "../core/decide.mjs";
import { pendingKind, terminalText } from "../core/text.mjs";
import { DIAGNOSTIC_EVENTS } from "../diagnostics-contract.mjs";
import { createDebugTools } from "./debug-tools.mjs";
import { createDiagnosticsSink } from "./diagnostics-sink.mjs";
import {
  createDelivery,
  DELIVERY_OUTCOMES,
  hasNativeBridge,
  readBrowserPermission,
  readUserActivation
} from "./delivery.mjs";
import { normalizeCurrent, normalizeSessions, readPageState } from "./normalize.mjs";
import { createSettingsRow, installSettingsStyle, registerSettingsLocale } from "./settings.mjs";

/** 本地服务名 → 提供它的官方 Harness Client 包名（包名只用于排序激活，不 import）。 */
export const CLIENT_DEPENDENCIES = [
  // 已用 Harness 的 app.asar 清单核实：slots 由 dsh-client-ui-slots 提供
  // （不存在名为 dsh-client-runtime 的包）。见 issue #13。
  { service: "slots", provider: "@deepseek-ai/dsh-client-ui-slots" },
  { service: "locale", provider: "@deepseek-ai/dsh-client-locale" },
  // sessions 的提供方**未经运行时确认**：asar 里同样没有 dsh-client-runtime，
  // 候选是 dsh-client-ui-session 或 dsh-client-store。该字段只用于排序激活，
  // Harness 语义允许未知条目（无害），因此保留待确认。见 issue #13。
  { service: "sessions", provider: "@deepseek-ai/dsh-client-runtime" },
  { service: "connection", provider: "@deepseek-ai/dsh-client-connection" },
  { service: "uiSession", provider: "@deepseek-ai/dsh-client-ui-session" }
];

/** 插件注入清单（本地服务名），由上面那张依赖表派生——它是这份名单的唯一定义处。 */
export const inject = CLIENT_DEPENDENCIES.map(({ service }) => service);

export function createPlugin(loadModule) {
    const React = loadModule("react");
    const h = React.createElement;
    const { useEffect, useState } = React;

    const PLUGIN_ID = "@cningan/dsh-session-status";

    // 诊断上报走单一 sink（`client/diagnostics-sink`）：事件名与落盘记录形状都在那里定义，
    // 装配层与投递层只消费它。上报失败绝不影响提醒行为本身。
    const sink = createDiagnosticsSink({ pluginId: PLUGIN_ID });

    // 渠道选择、平台事件、通知 tag 与权限读取都在 client/delivery；归一化与前台判定都在
    // client/normalize。这里只剩投递前的否决策略：前台事实由归一化给出，装配层把它作为
    // **值**传给投递判定、诊断记录与上报。
    function compactMessage(value, fallback = "") {
      if (typeof value !== "string") return fallback;
      const text = value.replace(/\s+/g, " ").trim();
      return text === "" ? fallback : text.slice(0, 220);
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

    function createStatusModel(ctx, sessions, uiSession, t, options = {}) {
      // 调试连接口（见 apply）：**只有调试构建**会给非 null 值。model 自己不认构建标志，
      // 也不含调试键——它只是把「按前台规则投递一条临时提醒」与「触发一次重渲染」两个出口
      // 填进这个口，并读对方（注入的 debugTools）拥有的测试模式开关；正式构建下恒为
      // null / false，前台抑制照旧。
      const debugLink = options.debugLink ?? null;
      const testModeOn = () => debugLink !== null && debugLink.testMode === true;
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
      // 每会话上一轮观察到的 running：**只**用来给「事件窗口缓存」定界——上一轮的 turn/end
      // 原因与详情不能留给下一轮（见 syncSessions）。它不参与任何提醒判定，也不再参与诊断：
      // 边沿记录改由 core/decide 的只读 edges 提供（见 client/diagnostics-sink）。
      const previousRunning = new Map();
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
      // 记账留在这一层。诊断上报统一走上面那个 sink。
      const delivery = createDelivery({
        pluginId: PLUGIN_ID,
        report: sink.report,
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

      // `testMode` 读的是调试连接口：前台抑制当前是否被覆盖（覆盖开关属于注入的
      // debugTools，正式构建下没有注入方，恒为 false）。`page` 是归一化给出的**当前
      // 前台事实**（唯一判定在 client/normalize）：设置区的诊断行渲染它，而不是自己
      // 去读一次宿主页面——UI 显示的那一位与判定消费的那一位因此同源。
      const getSnapshot = () => ({
        notificationPermission,
        diagnostics,
        testMode: testModeOn(),
        page: readPageState()
      });

      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };

      // 详情快照的领域形状、标题回退与列表/状态归一化都在 client/normalize（纯函数、
      // 可直测）：装配层只把官方快照片段交给它，判定核心只认它产出的领域形状。

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
      //
      // `page` 是归一化给出的前台事实（唯一判定在 client/normalize）：本轮这一条提醒的
      // **一个值**同时喂给否决策略、内存诊断记录、上报请求体与投递层的事实参数——
      // 三者不可能各算一次而分叉。`page` 缺省时就地读一次（自检与探针不经 pushSystemNotice）。
      const systemNotify = (notice, allowForeground = false, page = readPageState()) => {
        const background = page.background;
        const record = (channel, delivered) => ({
          key: notice.key,
          kind: notice.kind,
          channel,
          delivered,
          background,
          at: now().toLocaleTimeString(),
          activation: readUserActivation(),
          testMode: testModeOn()
        });
        const report = (channel, delivered) => sink.report(DIAGNOSTIC_EVENTS.DELIVER, {
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
        if (!allowForeground && !testModeOn() && !background) {
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

      // 调试出口（**只有调试构建**会拿到这个口）：探针经这里投递，所以它与自动提醒共用
      // 同一个投递实例（tag 序号、桥状态、权限）与同一份内存诊断；键前缀由调用方给，
      // 序号与设置页自检（`test:N`）共用同一个计数器——两种构建里键逐字节一致。
      // 探针与测试模式本身在 `client/debug-tools`，不在这里（model 的公开面不含调试键）。
      if (debugLink !== null) {
        debugLink.deliverAdHoc = ({ keyPrefix, kind, title, message }) => systemNotify({
          key: `${keyPrefix}:${kind}:${++testSequence}`,
          kind,
          title,
          message
        });
        debugLink.notify = notify;
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
        // 一条提醒的前台事实只读一次（归一化的唯一判定），同一个值既进判定也进日志。
        const page = readPageState();
        const delivered = systemNotify(notice, false, page);
        if (delivered) deliveredKeys.add(notice.key);
        console.log(`[${PLUGIN_ID}] system reminder`, {
          kind: notice.kind,
          sessionId: notice.sessionId,
          delivered,
          permission: notificationPermission,
          background: page.background
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
          sink.report(DIAGNOSTIC_EVENTS.SOURCE_SHAPE, {
            stage: "list",
            byIdType: typeof rows,
            snapshotKeys: snapshot !== null && typeof snapshot === "object" ? Object.keys(snapshot) : null
          });
          return;
        }
        // 标题与归属仍来自官方列表快照（byId 行），运行/等待状态来自 sessionStatus。
        const statuses = readSessionStatus();
        if (statuses === void 0) {
          sink.report(DIAGNOSTIC_EVENTS.SOURCE_SHAPE, { stage: "status", reason: "sessionStatus is not a Map snapshot" });
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

        // 装配层只做归一化：官方两条来源（列表行 + 会话状态）→ 领域快照，映射本身在
        // client/normalize（纯函数、有直测）。判定「这一轮该产出哪些提醒」交给 core/decide；
        // 等待去重按 pending 对象的同一性。
        const domainSessions = normalizeSessions(rows, statuses);
        const nextPendingKeys = new Map();
        for (const session of domainSessions) {
          const interaction = session.pending;
          if (interaction !== null) nextPendingKeys.set(session.id, `pending:${session.id}:${identityOf(interaction)}`);
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
          current: currentSessionId === void 0
            ? void 0
            : normalizeCurrent(currentDetail, currentTurnEndReason)
        });
        // 边沿诊断与投递走判定核心的**只读边沿事实**（`decider.edges`）：它是唯一知道
        // 「边沿」的地方，被抑制（列表行不在）与静默（用户取消、已显式移除）的停止边沿
        // 也在这里——读方据此区分「边沿被抑制」与「还没观察到边沿」，装配层不再自己
        // 记账 run 边沿。顺序与既有记录一致：边沿先记、提醒后投。
        for (const edge of decider.edges) {
          const record = sink.reportEdge(edge);
          // 内存诊断（设置区显示）沿用既有形状：pending 边沿额外带上 `suppressed`，
          // 设置区据此统一判断「是否被抑制」；落盘记录就是 sink 返回的那一条。
          diagnostics = {
            ...diagnostics,
            edge: edge.kind === "pending" ? { ...record, suppressed: null } : record
          };
          // 只观察到边沿、没有提醒可投的那一类：触发一次重渲染即可。
          if (edge.noticeIndex === null) {
            notify();
            continue;
          }
          deliverNotice(notices[edge.noticeIndex]);
        }

        // 记账本轮的 running，供下一轮给事件窗口缓存定界；消失的会话连同它的投递键一并清掉。
        for (const session of domainSessions) previousRunning.set(session.id, session.running);
        for (const sessionId of [...previousRunning.keys()]) {
          if (statuses.has(sessionId)) continue;
          previousRunning.delete(sessionId);
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
          sink.report(DIAGNOSTIC_EVENTS.STATUS, summary);
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
        // 前台事实同样只有归一化那一处判定：这里只把它的两个观测面并进内存诊断
        // （设置区的诊断行渲染的是 model 快照里的同一个值）。
        const page = readPageState();
        diagnostics = {
          ...diagnostics,
          page: { visibility: page.visibility, focused: page.focused }
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

      // 公开面在两种构建里完全一致（不含调试键）：探针与测试模式开关属于注入的
      // `client/debug-tools`，不是 model 的方法（见 test/model-surface.test.mjs）。
      return {
        getSnapshot,
        subscribe,
        requestPermission,
        sendTestNotification
      };
    }

    function apply(ctx) {
      // 语言跟随 DSH 界面设置：字典注册与绑定接线在 client/settings（`t` 同时供通知文案
      // 与设置区使用）。
      const t = registerSettingsLocale(ctx, `${PLUGIN_ID}: dictionaries`);
      // 装载快照：确认 Client 侧确实加载、拿到了哪些官方源，以及当前页面/权限/桥状态。
      // 页面那两行来自归一化的唯一判定（字段与顺序与既有 JSONL 逐字节一致）。
      const page = readPageState();
      sink.report(DIAGNOSTIC_EVENTS.ATTACH, {
        hasSessionsList: ctx.sessions?.list !== void 0,
        hasSessionStatus: ctx.uiSession?.sessionStatus !== void 0,
        hasCurrentScope: ctx.uiSession?.adapter?.current !== void 0,
        visibility: page.visibility,
        focused: page.focused,
        browserPermission: readBrowserPermission(),
        nativeBridge: hasNativeBridge(),
        userActivation: readUserActivation()
      });
      // 调试能力（`client/debug-tools`）**只在调试构建里存在**：装配层是唯一的构造方。
      // 它要经 model 的投递出口投递（与自动提醒共用同一个投递实例与内存诊断），而 model
      // 的前台否决要读它的测试模式开关——两侧互相需要，所以先建这个连接口：model 填
      // `deliverAdHoc`/`notify`，debugTools 读写 `testMode`。正式构建下它连同 debugTools
      // 一起是 null，model 的公开面不因此改变（见 test/model-surface.test.mjs）。
      const debugLink = __DEBUG__ ? { testMode: false, deliverAdHoc: null, notify: null } : null;
      const model = createStatusModel(ctx, ctx.sessions, ctx.uiSession, t, { debugLink });
      const debugTools = __DEBUG__ ? createDebugTools({ link: debugLink, t, h }) : null;
      ctx.effect(() => installSettingsStyle(PLUGIN_ID), `${PLUGIN_ID}: stylesheet`);
      const SettingsRow = createSettingsRow({ h, useEffect, useState });
      // 插件配置页的 section（`settings.section`），不是常规设置页的一行（`settings.general.item`）。
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: PLUGIN_ID,
        order: 30,
        label: () => t("notifications"),
        // 设置区只认注入进来的协作者：model / t，加可选的 debugTools（正式构建为 null）。
        inject: () => ({ t, model, debugTools })
      }, SettingsRow));
    }

    // 真正的 ESM 模块导出插件表面：装配是 module 内的一次闭包构造，不再拟态 CommonJS
    // （没有消费者，就不再留那份假形状）。loader 只消费 `factory(loadModule)` 的返回值。
    return { apply, inject };
}
