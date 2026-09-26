/**
 * 调试工具（**仅调试构建**）：诊断文本块、探针与测试模式开关。
 *
 * 这些能力**不挂在 model 上**——model 的公开面在两种构建里一致（不含调试键，见
 * `test/model-surface.test.mjs`）。装配层只在 `__DEBUG__` 为真时构造本 module，并把
 * model 的投递出口通过 `link` 显式注入：
 *
 *   - `link.testMode`     本 module 拥有（`setTestMode` 写、`isTestMode` 读）；
 *                         装配层把它交给 model，model 读它决定要不要跳过前台抑制。
 *   - `link.deliverAdHoc` model 填的出口：按前台规则投递一条临时提醒。探针因此与自动
 *                         提醒共用同一个投递实例（tag 序号、桥状态、权限）与同一份内存
 *                         诊断，键的序号也与自检（`test:N`）共用同一个计数器——调试构建
 *                         下的诊断记录与既有实现逐字节一致。
 *   - `link.notify`       model 填的出口：触发一次设置区重渲染（测试模式开关的即时反馈）。
 *
 * 依赖注入的另两件：`t`（官方 locale 绑定，探针按钮文案由它给）与 `h`（React
 * `createElement`）。设置区只管把 `renderExtras(...)` 交出的两个子元素插进自己的纵向
 * 布局；正式构建下没有注入方，设置区那里就只是两个空位（元素树形状不变）。
 */

/** 探针专用键前缀：与自检的 `test:` 区分开，读方据此分辨「探针」与「设置页自检」。 */
export const PROBE_KEY_PREFIX = "test-probe";

/**
 * 创建调试工具。
 *
 * 选项：
 *   - `link`      装配层建的调试连接口（见文件头；**只有调试构建**会给非 null 值）
 *   - `t`         官方 locale 绑定
 *   - `h`         React `createElement`
 *   - `setTimeout` 定时器（缺省用全局；直测可注入替身，连发探针与延迟探针都经它）
 */
export function createDebugTools(options = {}) {
  const link = options.link;
  const t = options.t;
  const h = options.h;
  const schedule = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;

  /**
   * 诊断文本块（4 行）：状态源摘要、最近边沿、最近投递、当前页面。不开 DevTools 也能
   * 看出链路卡在哪一环。
   *
   * 页面那一行**只渲染注入值**：前台事实来自 model 快照的 `page`（判定与读取的唯一
   * 来源在 `client/normalize` 的 `readPageState`）。这里绝不自己去读宿主页面——诊断行
   * 显示的那一位与真正决定投递的那一位因此不可能分叉；没有页面事实（缺键）时给 `?`。
   */
  function renderDiagnostics(snapshot) {
    const d = snapshot?.diagnostics ?? {};
    const page = snapshot?.page ?? null;
    const pageVisibility = typeof page?.visibility === "string" ? page.visibility : "?";
    const pageBackground = page?.background === true;
    const lines = [
      `诊断·状态源 ${d.status?.statusEntries ?? "?"} 条；当前会话在状态 ${d.status ? (d.status.currentInStatuses ? "是" : "否") : "?"}；列表含当前 ${d.status ? (d.status.listHandlesCurrent ? "是" : "否") : "?"}；运行中 ${d.status ? d.status.runs.filter((run) => run.running).length : "?"}`,
      d.edge === null || d.edge === undefined
        ? "诊断·边沿 尚未观察到"
        : `诊断·最近边沿 ${d.edge.kind}${d.edge.suppressed === null || d.edge.suppressed === undefined ? "" : `（抑制：${d.edge.suppressed}）`}`,
      d.deliver === null || d.deliver === undefined
        ? "诊断·投递 尚无尝试"
        : `诊断·最近投递 ${d.deliver.at ?? ""} ${d.deliver.kind ?? "?"}/${d.deliver.channel}；已投递 ${d.deliver.delivered ? "是" : "否"}；失焦判定 ${d.deliver.background ? "是" : "否"}；用户激活 ${d.deliver.activation ? (d.deliver.activation.everActive ? "曾有" : "无") : "?"}；平台反馈 ${d.deliver.platform ?? "（无事件）"}`,
      `诊断·当前页面 ${pageVisibility}；失焦判定 ${pageBackground ? "是" : "否"}`
    ];
    // 纵向布局：诊断文本必须独占整行——放进被按钮挤压的窄列会被压成"每行一个字"。
    return lines.length > 0
      ? h("div", { className: "dshss-settings-diagnostics" },
        lines.map((line, index) => h("div", { key: `dshss-diag-${index}` }, line)))
      : null;
  }

  /**
   * 设置区的调试部分：`[诊断文本块, 诊断工具行]` 两个子元素（都可为 null）。
   *
   * 工具行只在「已经能投递」(`canTest`) 时出现；四个按钮与后端能力一一对应：
   * 测试模式开关、`test` 探针、`interrupted` 探针（对照自动提醒的参数）、连发探针 ×3。
   * `testResult` / `setTestResult` 是设置区自己的状态机（探针反馈与自检共用一处提示）。
   */
  function renderExtras({ snapshot, canTest, testResult, setTestResult }) {
    // 探针：点击**立即**投递——配合测试模式即可在前台验证；未开测试模式且页面在
    // 前台时按设计被抑制，并在诊断里显示原因。
    const probeButton = canTest ? h("button", {
      className: "dshss-settings-button",
      type: "button",
      onClick: () => {
        tools.sendProbe("test");
        setTestResult("probe-fired");
      }
    }, testResult === "probe-fired" ? t("probeFired") : t("probeNotification")) : null;
    const probeInterruptedButton = canTest ? h("button", {
      className: "dshss-settings-button",
      type: "button",
      onClick: () => {
        tools.sendProbe("interrupted");
        setTestResult("probe-fired");
      }
    }, testResult === "probe-fired" ? t("probeFired") : t("probeInterrupted")) : null;
    // 连发探针：同参数连投 3 条（间隔 2 秒），一次点击即可看出是否"间歇性丢失"。
    const burstButton = canTest ? h("button", {
      className: "dshss-settings-button",
      type: "button",
      onClick: () => {
        tools.sendProbeBurst("test", 3);
        setTestResult("probe-fired");
      }
    }, testResult === "probe-fired" ? t("probeFired") : t("probeBurst")) : null;
    // 测试模式开关：打开后即使页面在前台也投递，便于在窗口前直接验证参数组合。
    const testModeButton = canTest ? h("button", {
      className: "dshss-settings-button",
      type: "button",
      onClick: () => tools.setTestMode(!snapshot.testMode)
    }, snapshot.testMode ? t("testModeOn") : t("testMode")) : null;
    return [
      renderDiagnostics(snapshot),
      canTest ? h("div", { className: "dshss-settings-tools" },
        testModeButton,
        probeButton,
        probeInterruptedButton,
        burstButton
      ) : null
    ];
  }

  const tools = {
    /** 测试模式当前是否开着（前台抑制是否被覆盖）。 */
    isTestMode() {
      return link !== null && link !== undefined && link.testMode === true;
    },

    /** 开关测试模式：写进连接口（model 读它跳过前台抑制）并触发一次重渲染。 */
    setTestMode(value) {
      if (link !== null && link !== undefined) link.testMode = value === true;
      if (link !== null && link !== undefined && typeof link.notify === "function") link.notify();
      return tools.isTestMode();
    },

    /**
     * 探针：与自检同参数的载荷，但遵守前台规则（除非处于测试模式）。`kind` 可参数化：
     * `test` 对比自动提醒的 `interrupted`，用于逐个变量对照。
     */
    sendProbe(kind = "test") {
      return link.deliverAdHoc({
        keyPrefix: PROBE_KEY_PREFIX,
        kind,
        title: kind === "test" ? t("testNotificationTitle") : t("interrupted"),
        message: t("testNotificationMessage")
      });
    },

    /** 连发探针：同一参数连投 `count` 条（tag 逐条唯一），用于检测"间歇性不显示"。 */
    sendProbeBurst(kind = "test", count = 3, gapMs = 2000) {
      let fired = 0;
      const fire = () => {
        if (fired >= count) return;
        fired += 1;
        tools.sendProbe(kind);
        if (fired < count) schedule(fire, gapMs);
      };
      fire();
      return count;
    },

    /** 延迟探针：`delayMs` 之后投一条（用于腾出时间切走窗口再看是否到达）。 */
    sendDelayedProbe(delayMs = 10000, kind = "test") {
      schedule(() => tools.sendProbe(kind), delayMs);
    },

    renderExtras
  };
  return tools;
}
