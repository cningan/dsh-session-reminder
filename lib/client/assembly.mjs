/**
 * 装配层（Client 半边唯一的装配处）。
 *
 * 职责边界：**官方源只在本文读取**——`sessions.list`（列表行与打开会话）、
 * `uiSession.sessionStatus`（运行/等待状态）、`uiSession.adapter.current`（当前会话绑定）、
 * `connection.state`（传输状态）与 `locale`（文案字典）。读到的官方**快照片段**在这里交给
 * 归一化层（`client/normalize`，纯函数、可直测）变成领域快照，再喂给判定核心；判定核心、
 * 投递层、诊断上报层都不读官方源。订阅与释放（`ctx.effect`）、前台否决、投递键记账、
 * 内存诊断、**权限请求**与测试服务注册也在这里。
 *
 * **本插件不含任何设置 UI**：它不注册任何 slot（`settings.section` 也不例外），也不取
 * React——locale 字典只为通知文案（`core/text` 的 `t`）服务。因此「请求通知权限」不出现在
 * 任何界面上，而是由**需要投递的那一刻**就地触发（浏览器权限仍为 `default` 时的首次投递，
 * 见 `requestPermissionIfUndecided`）。
 *
 * 文案映射在 `core/text`，渠道序列与平台事件在 `client/delivery`（能力/权限的派生也只有
 * 那一处），归一化与「页面是否在前台」的唯一判定在 `client/normalize`（前台事实与能力事实
 * 都作为**值**流入投递判定、诊断记录与上报）。测试能力只有一条 Hook——`client/test-service`
 * 收敛的服务面，装配层把它注册成 Cordis 服务 `sessionStatusTest`（前台覆盖与临时投递都在
 * 它那一侧，见 apply）。
 *
 * `CLIENT_DEPENDENCIES` 是本插件 Client 依赖清单的**单一来源**：本地服务名与提供它的
 * 官方包名一起声明，`inject`（本地服务名，供运行时注入）与 `package.json` 的
 * `dsh.client.inject`（包名，仅用于排序激活）都由它派生；直测断言两处名单一致
 * （见 test/client-assembly.test.mjs），避免两处名单各自漂移。
 */
import { createDecider } from "../core/decide.mjs";
import { dictionaries, pendingKind, terminalBody, terminalHeadline } from "../core/text.mjs";
import { DIAGNOSTIC_EVENTS } from "../diagnostics-contract.mjs";
import { createDiagnosticsSink } from "./diagnostics-sink.mjs";
import {
  createDelivery,
  DELIVERY_OUTCOMES,
  readCapabilities
} from "./delivery.mjs";
import {
  isSubagentSession,
  normalizeCurrent,
  normalizeSessions,
  readEventWindow,
  readPageState
} from "./normalize.mjs";
import {
  ADHOC_KEY_PREFIX,
  TEST_SERVICE_NAME,
  createTestStatusService,
  foregroundModeOf,
  withForegroundMode
} from "./test-service.mjs";

/**
 * 官方 locale 命名空间：字典注册与绑定的键。本插件只在这一处用官方 locale——它服务的是
 * **通知文案**（投递层拼标题/正文），不是任何设置 UI。
 */
const LOCALE_NAMESPACE = "dsh-session-status-notifications";

/**
 * locale 接线：把 `core/text` 的字典注册给官方 locale 服务并绑定 `t`。语言跟随 DSH 界面
 * 设置——不读 `document.documentElement.lang` 或 `navigator.language` 猜语言；注册经
 * `ctx.effect` 释放。
 */
function registerLocale(ctx, label) {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, dictionaries), label);
  return ctx.locale.bind(LOCALE_NAMESPACE);
}

/** 本地服务名 → 提供它的官方 Harness Client 包名（包名只用于排序激活，不 import）。 */
export const CLIENT_DEPENDENCIES = [
  // 本插件没有任何设置 UI，因此不需要 slots：依赖表里不再有这一项
  // （`slots` 原先只服务于设置行注册）。见 commit「移除主插件设置界面」。
  { service: "locale", provider: "@deepseek-ai/dsh-client-locale" },
  // `sessions` 的提供方已在 DSH 0.2.2-rc.1 的 app.asar 里核实：`ClientSessions` 由
  // `@deepseek-ai/dsh-api-session-controller/lib/client.js` 用
  // `rootCtx.reflect.provide("sessions", this)` 注册（仓库里曾有 `dsh-client-runtime`，
  // 那个包在 331 个官方包里根本不存在）。见 .scratch/session-status/issues/14。
  { service: "sessions", provider: "@deepseek-ai/dsh-api-session-controller" },
  { service: "connection", provider: "@deepseek-ai/dsh-client-connection" },
  { service: "uiSession", provider: "@deepseek-ai/dsh-client-ui-session" }
];

/** 插件注入清单（本地服务名），由上面那张依赖表派生——它是这份名单的唯一定义处。 */
export const inject = CLIENT_DEPENDENCIES.map(({ service }) => service);

/**
 * 打开一个会话（点击通知时的动作）。
 *
 * DSH 0.2 把「切到某个会话」搬到了官方 ui-workspace：`uiWorkspace.openSession(id)` →
 * `replaceMain(..., "reveal")`；而 `sessions` 服务只剩列表/绑定，**没有 `open()`**
 * （0.2.2-rc.1 的 `ClientSessions` 方法表已核实）。旧实现直接调 `sessions.open`，
 * 结果每次点击都抛错、被投递层吞掉，用户看到的是「点了没反应」。
 *
 * `uiWorkspace` 用 `ctx.get` 取而不是写进 `inject`：它只影响「点通知能不能跳转」这一个
 * 可选行为，不该让本插件因为没装 ui-workspace 而拒绝加载。
 *
 * @returns 是否找到可用的打开方式（false = 两种官方入口都不在）。
 */
function openSessionTarget(ctx, sessions, sessionId) {
  const workspace = workspaceOf(ctx);
  if (workspace !== null && workspace !== undefined && typeof workspace.openSession === "function") {
    workspace.openSession(sessionId);
    return true;
  }
  if (typeof sessions?.open === "function") {
    sessions.open(sessionId);
    return true;
  }
  return false;
}

/**
 * 官方 ui-workspace 客户端服务（`uiWorkspace`）：用 `ctx.get` 做**可选**解析。
 *
 * Cordis 4 的 `ctx.get(name, strict = true)` 是「不依赖 inject 读服务」的唯一入口；`strict`
 * 为真时只返回**提供方 fiber 当前已激活**的服务，为假时连尚未激活的也算。两处调用刻意用
 * 不同的严格度：
 *   - 点击通知那一次用 strict（默认）：要真的能用，否则不如回退；
 *   - 装载快照的 `hasWorkspaceOpen` 用 non-strict：它描述**这套组合里有没有这个服务**，
 *     不是「此刻是否已激活」——本插件的 apply 可能早于 ui-workspace 激活，用 strict 会
 *     把「装着呢」误报成 false，反而把排障带偏。
 *
 * 解析失败（服务不存在、上下文没有 `get`、`get` 抛错）返回 undefined。
 */
function workspaceOf(ctx, strict = true) {
  try {
    return typeof ctx?.get === "function" ? ctx.get("uiWorkspace", strict) : ctx?.uiWorkspace;
  } catch {
    return void 0;
  }
}

/**
 * DSH 自身版本（官方 boot 清单 `window.__DSH_BOOT__.release.version`，见
 * `@deepseek-ai/dsh-client-modules`）。只进诊断：判断「插件版本 vs DSH 版本」时先看事实。
 * 读不到就是 null——没有这条事实时不许猜一个版本号。
 */
function readDshVersion() {
  try {
    const boot = typeof window === "undefined" ? void 0 : window.__DSH_BOOT__;
    const release = boot !== null && boot !== undefined ? boot.release : void 0;
    const version = release !== null && release !== undefined ? release.version : void 0;
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}

export function createPlugin() {
    // 本插件没有任何 UI，因此不向 loader 取任何模块（不再 `loadModule("react")`）。
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
    //
    // 标题说「为什么停」，正文说「停在哪一轮、具体是什么」。过去标题恒为「已中断或停止」、
    // 原因塞在正文里，用户看到的每条提醒都一样——原因被读到时也还是一样（见 commit
    // 「停止原因分类」）。现在每个 reason 有自己的标题，读不到原因才回落到通用那一条。
    function terminalNoticeText(notice, t) {
      // 标题 = 为什么停（每个 reason 一句）；正文 = 标题没说到的那点细节（core/text 的
      // terminalBody），中间是会话标题。三段互不重复。
      const body = terminalBody({ reason: notice.reason, detail: notice.detail }, t);
      const separator = t("separator");
      return {
        title: terminalHeadline(notice.reason, t),
        message: body === "" ? notice.title : `${notice.title}${separator}${body}`,
        kind: notice.reason === "completed" ? "completed" : "interrupted"
      };
    }

    function createStatusModel(ctx, sessions, uiSession, t) {
      // 前台覆盖是测试服务的写入口（见 client/test-service）：它是一个**值**，只在
      // 「读一次前台事实」的那一处参与运算——替换结论（`background`），不改写证据
      // （`visibility` / `focused`），也不参与等待/停止边沿、去重与静默的任何判定。
      // 缺省 `"auto"`：与没有本服务时逐字节一致。
      let foregroundOverride = "auto";
      /** 这一轮该消费的前台事实：宿主读取 + 覆盖，覆盖只动 `background` 这一位。 */
      const effectivePage = () => withForegroundMode(readPageState(), foregroundOverride);
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
      // 事件窗口形状不符只上报一次（每 session 重新绑定时不重置也无妨：形状是运行时的
      // 属性，不是会话的属性）。见 observeCurrentEventWindow。
      let eventWindowShapeReported = false;
      let notificationPermission;
      let connectedOnce = false;
      let connectionLost = false;
      let testSequence = 0;
      let lastStatusSignature = "";
      // 最近一次诊断（内存态，测试服务的只读快照从这里读）：不开 DevTools 也能看出链路
      // 卡在哪一环。当前页面事实不在里面——它有唯一的家（快照的 `page`）。
      let diagnostics = { status: null, edge: null, deliver: null };
      let disposed = false;
      const now = () => new Date();

      const notify = () => {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            console.error(`[${PLUGIN_ID}] status listener failed`, error);
          }
        }
      };

      // 投递层（`client/delivery`）：**有序的渠道 adapter 序列**（shell → webview → 浏览器）、
      // 平台事件、通知 tag 与能力/权限的**单一来源**（`readCapabilities`）都在那里。
      // 它只投递与回报，不含判定语义；前台否决（见 `systemNotify`）与 `deliveredKeys`
      // 记账留在这一层——本文因此不需要知道有哪些渠道，只消费它回报的结果与能力值。
      // 诊断上报统一走上面那个 sink。
      const delivery = createDelivery({
        pluginId: PLUGIN_ID,
        report: sink.report,
        // 平台事件回灌：只更新内存诊断并触发一次重渲染，判断仍由读方（`diagnose`）做。
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
        // 点击通知打开会话（见 openSessionTarget）：两种官方入口都试，都不在就只记一条日志。
        openSession: (sessionId) => {
          if (!openSessionTarget(ctx, sessions, sessionId)) {
            console.warn(`[${PLUGIN_ID}] no session-opening service (uiWorkspace.openSession / sessions.open)`);
          }
        },
        onError: (label, error) => console.error(`[${PLUGIN_ID}] ${label}`, error)
      });
      notificationPermission = delivery.permission();

      // ── 权限请求的非 UI 路径 ──────────────────────────────────────────────────
      // 本插件没有设置入口，所以「请求通知权限」只在一个时刻发生：**真要投递**、而浏览器
      // 权限还没决定（`default`：没有可用原生桥、用户也没答过）的那一次。请求是异步的，
      // 这一条提醒仍按原样走渠道序列（记录与既有 JSONL 逐字节一致，结果是 `browser-default`
      // 的那一类）；拿到结果后模型状态刷新、需要时重新同步会话，后续提醒因此能走浏览器渠道。
      // 只问一次：问过之后（无论答应与否）权限都不再是未决定态，闸门自然关闭。
      let permissionRequested = false;
      const requestPermission = async () => {
        // 权限读取与请求都在 delivery：这里只把结果并回模型状态并决定要不要重同步。
        const outcome = await delivery.requestPermission();
        notificationPermission = outcome.permission;
        notify();
        if (outcome.resync) syncSessions();
        return notificationPermission;
      };
      const requestPermissionIfUndecided = () => {
        if (permissionRequested || disposed) return;
        if (delivery.permission() !== "default") return;
        permissionRequested = true;
        try {
          Promise.resolve(requestPermission()).catch(() => {});
        } catch {}
      };

      // 只读快照（测试服务的 `getSnapshot()` 就是它）：状态源摘要 / 最近边沿 / 最近投递
      // 三件来自内存诊断，当前页面来自归一化的唯一判定——`background` 已反映前台覆盖，
      // 而 `visibility` / `focused` 仍是宿主原值（覆盖只替换结论，不改写证据）。
      const getSnapshot = () => ({
        notificationPermission,
        diagnostics,
        foregroundOverride,
        page: effectivePage()
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
            reason: notice.reason,
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
          reason: notice.reason,
          sessionId: notice.sessionId,
          title: terminal.title,
          message: terminal.message
        });
      };

      // 前台否决留在装配层：页面在前台时不投递，但仍然记账、仍然上报一条可区分的投递
      // 记录（读方据此区分「按设计静默」与「投递故障」）。
      // 真正投递一条提醒交给 delivery，它回报渠道与结果；这里只把结果并进内存诊断。
      //
      // 设置界面移除后**没有任何前台例外**：所有提醒（自动的与测试服务的临时投递）都走
      // 同一条否决——页面在前台就不投。要在前台验证投递，只能用测试服务把前台判定覆盖成
      // `background`（覆盖的是前台事实本身，不是这里的策略，见 client/test-service）。
      //
      // `page` 是「宿主事实 + 前台覆盖」的**一个值**（归一化判定在 client/normalize，
      // 覆盖策略在 client/test-service）：本轮这一条提醒的一个值同时喂给否决策略、
      // 内存诊断记录、上报请求体与投递层的事实参数——三者不可能各算一次而分叉。
      // 缺省时就地读一次（测试服务的临时投递经这里）。
      //
      // 能力/权限同理走**一个值**：记录与上报取的是本次决策那个能力快照
      // （`result.capability`，前台静默那一次就地派生一个），不再各自读一次宿主对象。
      const systemNotify = (notice, page = effectivePage()) => {
        const background = page.background;
        const record = (channel, delivered, capability) => ({
          key: notice.key,
          kind: notice.kind,
          channel,
          delivered,
          background,
          at: now().toLocaleTimeString(),
          activation: capability.userActivation,
          foregroundOverride
        });
        const report = (channel, delivered, capability) => sink.report(DIAGNOSTIC_EVENTS.DELIVER, {
          key: notice.key,
          kind: notice.kind,
          // 停止原因也落盘：否则「文案对没对」只能靠人看通知，E2E 无从证明。
          reason: notice.reason ?? null,
          sessionId: notice.sessionId ?? null,
          channel,
          delivered,
          background,
          browserPermission: capability.browserPermission,
          nativeBridge: capability.nativeBridge,
          userActivation: capability.userActivation
        });
        // 前台抑制只看 `background` 这一个值：覆盖已经落在它身上（`"foreground"` 会
        // 强制抑制、`"background"` 会强制放行），这里不再有第二处开关。
        if (!background) {
          const capability = delivery.capability();
          diagnostics = { ...diagnostics, deliver: record("suppressed-foreground", false, capability) };
          notify();
          report("suppressed-foreground", false, capability);
          return false;
        }
        // 真要投递而浏览器权限还没决定时，就地请求一次（唯一的权限请求路径，见上文）。
        requestPermissionIfUndecided();
        const result = delivery.deliver(notice, { background });
        diagnostics = { ...diagnostics, deliver: record(result.channel, result.delivered, result.capability) };
        notify();
        // 原生桥没接住时本次投递走到了浏览器那一步，模型上的权限状态跟着刷新
        // （与旧实现同一时机：只有原生路径失败才会重新读浏览器权限）。展示的这一问
        // 与投递决策同一个派生函数，只是取投递之后的当前答案——桥刚被证明不可用，
        // 这一问的答案确实变了。
        if (result.outcome !== DELIVERY_OUTCOMES.NATIVE_BRIDGE) {
          const current = delivery.permission();
          if (notificationPermission !== current) {
            notificationPermission = current;
            notify();
          }
        }
        return result.delivered;
      };

      // ── 测试服务的两个出口 ────────────────────────────────────────────────────
      // 覆盖开关：写**一个值**（前台判定）并通知一次（面板要实时更新）。它不重放任何
      // 已经过去的边沿——覆盖只影响此后的投递决策，等待/停止边沿、去重、静默都不受影响。
      const setForegroundOverride = (mode) => {
        const resolved = foregroundModeOf(mode);
        if (resolved !== foregroundOverride) {
          foregroundOverride = resolved;
          notify();
        }
        return foregroundOverride;
      };

      // 临时提醒：与自动提醒共用同一个投递实例（tag 序号、桥状态、权限、诊断上报），
      // 因此同样服从前台抑制——要在前台验证投递，先 setForegroundOverride("background")。
      // 键形与既有 JSONL 逐字节一致（`test-probe:<kind>:<序号>`）。
      const deliverAdHoc = (kind) => {
        const resolved = kind === "interrupted" ? "interrupted" : "test";
        return systemNotify({
          key: `${ADHOC_KEY_PREFIX}:${resolved}:${++testSequence}`,
          kind: resolved,
          title: resolved === "interrupted" ? t("interrupted") : t("testNotificationTitle"),
          message: t("testNotificationMessage")
        });
      };

      const pushSystemNotice = (input) => {
        const notice = {
          key: input.key,
          kind: input.kind,
          reason: input.reason,
          sessionId: input.sessionId,
          title: input.title,
          message: input.message
        };
        if (deliveredKeys.has(notice.key)) return false;
        // 一条提醒的前台事实只读一次（宿主事实 + 覆盖的那一个值），既进判定也进日志。
        const page = effectivePage();
        const delivered = systemNotify(notice, page);
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

      // 当前会话的事件窗口：**停止原因的唯一来源**。
      //
      // 这里过去直接读 `snapshot.events` / `snapshot.target`（DSH 0.1 的形状）。DSH 0.2 改成
      // `{ entries: [{ type, event }], hasMore, revision, change }` 之后，那两个字段恒为
      // undefined，于是 `turn/end` 永远读不到、所有停止都被归成通用「原因未知」——这正是
      // 「所有中断提示都一样」的根因。形状识别收在归一化层（`readEventWindow`），本文只消费
      // `{ shape, maxSeq, turnEnd }`。
      //
      // `seed` 只在绑定会话时用一次：只把水位抬到窗口末尾，**不采纳**窗口里的旧 `turn/end`
      // ——否则一绑定就把上一轮的结果当成这一轮的。
      const observeCurrentEventWindow = (snapshot, seed = false) => {
        if (disposed || currentSessionId === void 0) return;
        const window = readEventWindow(snapshot, seed ? -1 : currentEventSequence);
        if (window.shape === "unknown") {
          if (!eventWindowShapeReported) {
            eventWindowShapeReported = true;
            sink.report(DIAGNOSTIC_EVENTS.SOURCE_SHAPE, { stage: "event-window", reason: "neither entries nor events is an array" });
            console.warn(`[${PLUGIN_ID}] current session event window shape is unknown; stop reasons stay unavailable`);
          }
          return;
        }
        // 水位只升不降：重复发布同一批条目不会重复消费。
        if (window.maxSeq > currentEventSequence) currentEventSequence = window.maxSeq;
        if (seed || window.turnEnd === void 0) return;
        currentTurnEndReason = window.turnEnd;
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
        // client/normalize（纯函数、有直测）。归一化里还包含**归属过滤**：子代理会话不产出
        // 领域会话，因此不进入判定、没有等待/停止提醒，也没有任何边沿记录（诊断态度见下面
        // 状态源摘要里的 `origin` 标注）。判定「这一轮该产出哪些提醒」交给 core/decide；
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
          // 内存诊断（测试服务的只读快照从这里读）沿用既有形状：pending 边沿额外带上
          // `suppressed`；落盘记录就是 sink 返回的那一条。
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
        //
        // 这一份摘要报的是**官方状态源本身**（不过归属过滤），因此子代理会话照样出现在
        // 这里；它们的行额外带一个 `origin: "subagent"` 标注——读方据此把「这一行没有边沿
        // 记录」解释成「按归属过滤、不参与提醒」，而不是「还没观察到边沿」。标注**只**加在
        // 子代理行上：父/普通行的记录与既有 JSONL 逐字节一致。
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
            inList: Object.prototype.hasOwnProperty.call(rows, id),
            ...(isSubagentSession(rows[id]) ? { origin: "subagent" } : {})
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
        // 前台事实没有内存副本：它唯一的家是快照的 `page`（每次 `getSnapshot()` 现读
        // 一次「宿主事实 + 覆盖」）。这里只重新同步判定与通知订阅方。
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

      // 模型面：只此四项，正好是测试服务经 `client/test-service` 收敛出的契约（见 apply）。
      // 权限请求（`requestPermission`）与投递路径留在本函数内部：它没有消费者，也不属于
      // Hook 面；调试 UI（诊断文本块、探针、测试模式开关）不在本插件里。
      return {
        getSnapshot,
        subscribe,
        setForegroundOverride,
        deliverAdHoc
      };
    }

    function apply(ctx) {
      // 语言跟随 DSH 界面设置：注册与绑定都在装配层（官方源只在本文读取），`t` 只供
      // 通知文案使用——本插件不含任何设置 UI。
      const t = registerLocale(ctx, `${PLUGIN_ID}: dictionaries`);
      // 装载快照：确认 Client 侧确实加载、拿到了哪些官方源，以及当前页面/权限/桥状态。
      // 页面那两行来自归一化的唯一判定；权限/桥/激活那三行来自**能力派生的唯一来源**
      // （`readCapabilities`）——与投递决策、权限请求消费的是同一个函数，不是各写一遍。
      const page = readPageState();
      const capability = readCapabilities();
      sink.report(DIAGNOSTIC_EVENTS.ATTACH, {
        hasSessionsList: ctx.sessions?.list !== void 0,
        hasSessionStatus: ctx.uiSession?.sessionStatus !== void 0,
        hasCurrentScope: ctx.uiSession?.adapter?.current !== void 0,
        // 官方 ui-workspace 是否在：决定「点通知能不能跳转」，不影响任何判定。
        // 用 non-strict 解析（见 workspaceOf）：报的是「有没有」，不是「此刻激活没激活」。
        hasWorkspaceOpen: typeof workspaceOf(ctx, false)?.openSession === "function",
        dshVersion: readDshVersion(),
        visibility: page.visibility,
        focused: page.focused,
        browserPermission: capability.browserPermission,
        nativeBridge: capability.nativeBridge,
        userActivation: capability.userActivation
      });
      // 测试服务：主插件里唯一的测试 Hook（形状与语义在 client/test-service 的文件头）。
      // 注册机制是 Cordis 的 `ctx.provide(name, value)`——与官方
      // `@deepseek-ai/dsh-client-locale` 注册 `locale` 服务同一处用法
      // （后者见 asar 里 `@deepseek-ai/dsh-client-locale/lib/client.js`：
      // `async function apply(ctx) { ... ctx.provide("locale", locale) }`）。
      // 服务随插件 fiber 卸载而注销，所以这里不需要额外的 `ctx.effect` 释放。
      // `inject`（本插件依赖的服务）不含它：提供方不需要注入自己提供的服务。
      const model = createStatusModel(ctx, ctx.sessions, ctx.uiSession, t);
      ctx.provide(TEST_SERVICE_NAME, createTestStatusService(model));
      // 到此为止：本插件不注册任何 slot、不安装任何样式表、不渲染任何 UI——设置界面已
      // 彻底移除（请求通知权限由 `requestPermissionIfUndecided` 在需要投递时就地触发）。
    }

    // 真正的 ESM 模块导出插件表面：装配是 module 内的一次闭包构造，不再拟态 CommonJS
    // （没有消费者，就不再留那份假形状）。loader 只消费 `factory()` 的返回值；插件没有 UI，
    // 因此也不向 loader 取任何模块。
    return { apply, inject };
}
