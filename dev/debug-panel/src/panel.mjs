/**
 * 调试面板本体：设置页里的一个 section 内容（React 组件 + 样式表 + 纯格式化函数）。
 *
 * 它是**开发件**（标题里写明 DEV），存在的理由只有一个：**双向**验证主插件那条承重规则
 * 「只有页面隐藏或失焦时才投递提醒」——
 *   - `强制前台` + 探针 → 预期不弹，但诊断里应留下「被前台抑制」的记录；
 *   - `强制失焦` + 探针 → 应该弹；
 *   - `跟随真实`（默认）→ 等于没有覆盖。
 * 而旧 `testMode` 只能单向证明「能弹」，证明不了「前台时确实不弹」。
 *
 * 它**不自己读宿主事实、不自己投递、不自己判定**：唯一的对外依赖是主插件经
 * `ctx.provide("sessionStatusTest", …)` 注册的那个服务（四个方法见
 * `@cningan/dsh-session-status/lib/client/test-service.mjs` 的文件头）。
 * 因此本 module 是「服务 → 界面」的纯映射：给一份快照就能渲染，给一个按钮点击就只调用
 * 服务，测试用替身注入假服务即可覆盖（见 `tests/panel.spec.mjs`）。
 *
 * 「快照 → 诊断 4 行」与「探针结果 → 提示」都抽成纯函数（`describeSnapshot` /
 * `describeResult`）：面板只负责把它们放进元素树，映射本身可以脱离 React 直测。
 */

/** 前台覆盖三态（与主插件 `test-service` 的词表逐项一致）。 */
export const FOREGROUND_MODES = Object.freeze(["auto", "foreground", "background"]);

/**
 * 可模拟的停止原因：与主插件 `core/classify` 的 `TERMINAL_REASONS` **逐项、同序**一致
 * （`tests/panel.spec.mjs` 断言这一点）。`label` 是本面板字典里的键，只用于按钮文字；
 * 真正的通知文案由主插件按 `reason` 生成——面板不复制那句文案，避免两边各写一遍。
 */
export const SAMPLE_REASONS = Object.freeze([
  { reason: "completed", label: "sampleCompleted" },
  { reason: "interrupted", label: "sampleInterrupted" },
  { reason: "process-interrupted", label: "sampleProcessInterrupted" },
  { reason: "blocked", label: "sampleBlocked" },
  { reason: "max-tokens", label: "sampleMaxTokens" },
  { reason: "error", label: "sampleError" },
  { reason: "agent-error", label: "sampleAgentError" },
  { reason: "prompt-error", label: "samplePromptError" },
  { reason: "session-open-error", label: "sampleOpenError" },
  { reason: "aborted-parent", label: "sampleAbortedParent" },
  { reason: "aborted-hook", label: "sampleAbortedHook" }
]);

/** reason → 按钮文案。词表外的原因（不该发生）按「中断（原因未知）」显示。 */
export function sampleLabel(t, reason) {
  const found = SAMPLE_REASONS.find((item) => item.reason === reason);
  return t(found === undefined ? "sampleInterrupted" : found.label);
}

/** 样式表标记：安装与替换时的身份，只按它查找/替换，不误伤主插件或别的插件样式。 */
export const PANEL_STYLE_TAG = "@cningan/dsh-session-status-debug/dev-panel.css";

export const PANEL_CSS = `
      .dshss-dev-panel {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 10px 0;
        color: var(--dsw-alias-label-primary, #202124);
        font-family: var(--dsw-font-family, inherit);
      }
      .dshss-dev-title {
        font-size: 13px;
        line-height: 18px;
        font-weight: 600;
      }
      .dshss-dev-description {
        max-width: 620px;
        color: var(--dsw-alias-label-secondary, #5f6368);
        font-size: 12px;
        line-height: 17px;
      }
      .dshss-dev-section {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .dshss-dev-section-label {
        color: var(--dsw-alias-label-secondary, #5f6368);
        font-size: 12px;
        line-height: 17px;
      }
      .dshss-dev-modes,
      .dshss-dev-probes {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .dshss-dev-mode,
      .dshss-dev-probe {
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
      .dshss-dev-mode:hover,
      .dshss-dev-probe:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .08));
      }
      .dshss-dev-mode.is-active {
        border-color: var(--dsw-alias-border-focus, rgba(0, 0, 0, .38));
        background: var(--dsw-alias-interactive-bg-active, rgba(0, 0, 0, .12));
        font-weight: 600;
      }
      .dshss-dev-mode-status {
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        font-size: 12px;
        line-height: 17px;
      }
      .dshss-dev-result {
        border-radius: 7px;
        padding: 6px 8px;
        font-size: 12px;
        line-height: 17px;
      }
      .dshss-dev-result.is-delivered {
        background: var(--dsw-alias-bg-positive, rgba(0, 128, 0, .08));
      }
      .dshss-dev-result.is-suppressed {
        background: var(--dsw-alias-bg-warning, rgba(200, 120, 0, .12));
      }
      .dshss-dev-result.is-partial {
        background: var(--dsw-alias-bg-warning, rgba(200, 120, 0, .12));
      }
      .dshss-dev-diagnostics {
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding-top: 4px;
        border-top: 1px dashed var(--dsw-alias-border-primary, rgba(0, 0, 0, .14));
      }
      .dshss-dev-diagnostic {
        display: flex;
        gap: 6px;
        font-size: 12px;
        line-height: 17px;
      }
      .dshss-dev-diagnostic-label {
        flex: none;
        min-width: 132px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
      }
      .dshss-dev-diagnostic-value {
        min-width: 0;
        word-break: break-word;
      }
      @media (max-width: 620px) {
        .dshss-dev-diagnostic {
          flex-direction: column;
          gap: 0;
        }
      }
    `;

/**
 * 安装样式表，返回卸载函数。同一个标记的旧样式先移除（重复 `apply` 不留孤儿）；
 * 没有 `document` 或没有 `head`（Node 直测/非浏览器环境）时是 no-op。
 */
export function installPanelStyle(pluginId) {
  if (typeof document === "undefined" || document.head === null) return () => {};
  const old = document.querySelector(`style[data-plugin-css=${JSON.stringify(PANEL_STYLE_TAG)}]`);
  if (old !== null) old.remove();
  const style = document.createElement("style");
  style.dataset.plugin = pluginId;
  style.dataset.pluginCss = PANEL_STYLE_TAG;
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
  return () => {
    if (style.parentNode !== null) style.remove();
  };
}

const MODE_KEYS = Object.freeze({
  auto: "modeAuto",
  foreground: "modeForeground",
  background: "modeBackground"
});

/** 覆盖模式 → 文案。三态之外（不该发生）按「跟随真实」处理，界面不显示空按钮。 */
export function modeLabel(t, mode) {
  return t(MODE_KEYS[mode] ?? MODE_KEYS.auto);
}

function yesNo(t, value) {
  if (value === true) return t("yes");
  if (value === false) return t("no");
  return t("unknown");
}

function text(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/**
 * 状态源摘要行：会话数、当前会话、当前会话是否在状态/列表快照里、运行中的会话数，
 * 以及**归属**（.scratch/session-status/issues/16-subagent-sessions-excluded.md：子代理会话不参与提醒）。
 *
 * 归属那两段只在摘要里**确实出现子代理行**时才追加，因此没有子代理时这一行与以前逐字符
 * 相同（既有断言不会被无关改动带偏）。`origin` 标注由主插件的状态源摘要给出——它只加在
 * 子代理行上（见 `lib/client/assembly.mjs` 的 `summary`），所以这里不做二次推断。
 * `当前会话=子代理` 只在选中会话恰好落在这 24 行的摘要窗口内时给得出；窗口外的归属未知，
 * 面板不猜。
 */
export function describeStatus(status, t) {
  if (status === null || status === undefined) return t("empty");
  const runs = Array.isArray(status.runs) ? status.runs : [];
  const base = t("statusValue", {
    entries: status.statusEntries ?? 0,
    current: text(status.currentId, t("none")),
    inStatus: yesNo(t, status.currentInStatuses),
    inList: yesNo(t, status.listHandlesCurrent),
    running: runs.filter((run) => run?.running === true).length
  });
  const subagents = runs.filter((run) => run?.origin === "subagent");
  const markers = [];
  if (subagents.length > 0) markers.push(t("subagentRuns", { count: subagents.length }));
  if (subagents.some((run) => run.id === status.currentId)) markers.push(t("currentSubagent"));
  return markers.length === 0 ? base : `${base} · ${markers.join(" · ")}`;
}

/**
 * 最近边沿行：判定核心的只读边沿事实（`pending` 带交互子类；`terminal` 带是否被抑制、
 * 是否有 turn/end 原因、是不是当前会话）。字段原样报出，面板不做二次解读。
 */
export function describeEdge(edge, t) {
  if (edge === null || edge === undefined) return t("empty");
  const session = text(edge.sessionId, t("none"));
  if (edge.kind === "pending") {
    return t("edgePendingValue", { interaction: text(edge.interactionKind, t("unknown")), session });
  }
  if (edge.suppressed === "missing-list-row") {
    return t("edgeSuppressedValue", { isCurrent: yesNo(t, edge.isCurrent), session });
  }
  return t("edgeTerminalValue", { hasTurnEndReason: yesNo(t, edge.hasTurnEndReason), isCurrent: yesNo(t, edge.isCurrent), session });
}

/** 最近投递行：渠道、是否真投出去（被抑制时渠道是 `suppressed-foreground`）、页面事实与投递时刻的覆盖。 */
export function describeDeliver(deliver, t) {
  if (deliver === null || deliver === undefined) return t("empty");
  const verdict = deliver.delivered === true
    ? t("verdictDelivered")
    : deliver.channel === "suppressed-foreground" ? t("verdictSuppressed") : t("verdictNotDelivered");
  const base = t("deliverValue", {
    channel: text(deliver.channel, t("unknown")),
    verdict,
    page: deliver.background === true ? t("pageBackground") : t("pageForeground"),
    override: modeLabel(t, deliver.foregroundOverride)
  });
  return typeof deliver.platform === "string" && deliver.platform !== ""
    ? `${base}${t("platformValue", { platform: deliver.platform })}`
    : base;
}

/** 当前页面行：宿主证据（可见性/焦点）原样报出 + 覆盖之后的失焦判定。 */
export function describePage(snapshot, t) {
  const page = snapshot?.page ?? {};
  const value = t("pageValue", {
    visibility: text(page.visibility, t("unknown")),
    focused: yesNo(t, page.focused),
    verdict: page.background === true ? t("verdictBackground") : t("verdictForeground")
  });
  return `${value} · ${t("overrideValue", { override: modeLabel(t, snapshot?.foregroundOverride) })}`;
}

/**
 * 快照 → 诊断 4 行（顺序固定：状态源摘要 / 最近边沿 / 最近投递 / 当前页面 + 失焦判定）。
 * 纯函数：面板只把它渲染成行，直测可以直接喂快照断言这四行。
 */
export function describeSnapshot(snapshot, t) {
  const diagnostics = snapshot?.diagnostics ?? {};
  return [
    { key: "status", label: t("diagStatus"), value: describeStatus(diagnostics.status, t) },
    { key: "edge", label: t("diagEdge"), value: describeEdge(diagnostics.edge, t) },
    { key: "deliver", label: t("diagDeliver"), value: describeDeliver(diagnostics.deliver, t) },
    { key: "page", label: t("diagPage"), value: describePage(snapshot, t) }
  ];
}

/**
 * 探针结果 → 文案。`null`（还没点过探针）给空串，界面据此不渲染结果块。
 *
 * `delivered` 是**条数**（连发 ×3 时是 0..3），因此这里按数量判断，不做 `=== true` 的
 * 布尔比较：单发与连发走同一条口径，界面不会出现「提示说没弹、色调却说已弹」这种自相矛盾。
 */
export function describeResult(result, t) {
  if (result === null || result === undefined) return "";
  const delivered = Number(result.delivered) || 0;
  const total = Number(result.total) || 1;
  // 按原因模拟：`kind` 是 `sample`，原因在 `reason` 上；结果只说「投出去没有」，
  // 文案本身应当由用户在系统通知里看到，面板不复制它。
  if (result.kind === "sample") {
    const name = sampleLabel(t, result.reason);
    return delivered > 0 ? t("resultSampleDelivered", { name }) : t("resultSampleSuppressed", { name });
  }
  const probe = result.kind === "interrupted" ? t("probeNameInterrupted") : t("probeNameTest");
  if (total > 1) {
    return delivered === total
      ? t("resultBurstAll", { delivered, total })
      : t("resultBurstPartial", { delivered, total });
  }
  return delivered > 0
    ? t("resultDelivered", { probe })
    : t("resultSuppressed", { probe });
}

/** 结果块的色调（`data-tone` 与 CSS 类都用它）：全投出 / 全被抑制 / 部分投出。 */
export function toneOf(result) {
  if (result === null || result === undefined) return "";
  const delivered = Number(result.delivered) || 0;
  const total = Number(result.total) || 1;
  if (total > 1 && delivered > 0 && delivered < total) return "partial";
  return delivered >= total ? "delivered" : "suppressed";
}

/**
 * 造面板组件。React 三件套由入口注入（入口已经 `loadModule("react")`），因此本 module
 * 不依赖框架加载器，也能在 Node 直测里用最小替身渲染。
 *
 * 组件 props 就是 slot 注册时 `inject()` 交出的那些：`{ service, t }`。
 * 面板对服务的用法只有三处——读 `getSnapshot()`、调 `setForegroundOverride(mode)`、
 * 调 `deliverAdHoc(kind)`——再 `subscribe()` 一次让界面跟随状态变化（返回的退订函数
 * 交给 `useEffect` 的清理，组件卸载即退订）。
 */
export function createDebugPanel({ h, useEffect, useState }) {
  return function SessionStatusDebugPanel({ service, t }) {
    const [, rerender] = useState(0);
    const [result, setResult] = useState(null);
    useEffect(() => service.subscribe(() => rerender((value) => value + 1)), [service]);

    const snapshot = service.getSnapshot();
    const rows = describeSnapshot(snapshot, t);
    const override = snapshot?.foregroundOverride ?? "auto";
    const page = snapshot?.page ?? {};

    const probe = (kind, times = 1) => {
      let delivered = 0;
      for (let index = 0; index < times; index += 1) {
        if (service.deliverAdHoc(kind)) delivered += 1;
      }
      setResult({ kind, delivered, total: times });
    };

    // 按原因模拟：一次一条，结果同样是「投出去没有」。走服务，不自己拼文案。
    const simulate = (reason) => {
      setResult({ kind: "sample", reason, delivered: service.deliverSample(reason) ? 1 : 0, total: 1 });
    };

    const modeButton = (mode) => h("button", {
      className: `dshss-dev-mode${override === mode ? " is-active" : ""}`,
      type: "button",
      "data-mode": mode,
      "aria-pressed": override === mode ? "true" : "false",
      onClick: () => { service.setForegroundOverride(mode); }
    }, modeLabel(t, mode));

    return h("div", { className: "dshss-dev-panel" },
      h("div", { className: "dshss-dev-title" }, t("panelTitle")),
      h("div", { className: "dshss-dev-description" }, t("panelDescription")),
      h("div", { className: "dshss-dev-section" },
        h("div", { className: "dshss-dev-section-label" }, t("modesLabel")),
        h("div", { className: "dshss-dev-modes" },
          modeButton("auto"),
          modeButton("foreground"),
          modeButton("background")
        )
      ),
      h("div", { className: "dshss-dev-mode-status" }, t("modeStatus", {
        mode: modeLabel(t, override),
        evidence: t("evidence", {
          visibility: text(page.visibility, t("unknown")),
          focused: yesNo(t, page.focused)
        })
      })),
      h("div", { className: "dshss-dev-section" },
        h("div", { className: "dshss-dev-section-label" }, t("probesLabel")),
        h("div", { className: "dshss-dev-probes" },
          h("button", {
            className: "dshss-dev-probe",
            type: "button",
            "data-probe": "test",
            onClick: () => probe("test")
          }, t("probeTest")),
          h("button", {
            className: "dshss-dev-probe",
            type: "button",
            "data-probe": "interrupted",
            onClick: () => probe("interrupted")
          }, t("probeInterrupted")),
          h("button", {
            className: "dshss-dev-probe",
            type: "button",
            "data-probe": "burst",
            onClick: () => probe("test", 3)
          }, t("probeBurst"))
        )
      ),
      h("div", { className: "dshss-dev-section" },
        h("div", { className: "dshss-dev-section-label" }, t("samplesLabel")),
        h("div", { className: "dshss-dev-probes" },
          SAMPLE_REASONS.map(({ reason, label }) => h("button", {
            className: "dshss-dev-probe",
            type: "button",
            "data-sample": reason,
            key: reason,
            onClick: () => simulate(reason)
          }, t(label)))
        )
      ),
      result === null ? null : h("div", {
        className: `dshss-dev-result is-${toneOf(result)}`,
        "data-tone": toneOf(result),
        "data-result": result.kind
      }, describeResult(result, t)),
      h("div", { className: "dshss-dev-diagnostics" },
        h("div", { className: "dshss-dev-section-label" }, t("diagnosticsLabel")),
        rows.map((row) => h("div", {
          className: "dshss-dev-diagnostic",
          "data-row": row.key,
          key: row.key
        },
        h("span", { className: "dshss-dev-diagnostic-label" }, `${row.label}${t("labelSeparator")}`),
        h("span", { className: "dshss-dev-diagnostic-value" }, row.value)
        ))
      )
    );
  };
}
