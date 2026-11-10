/**
 * 测试服务（主插件里**唯一**的测试能力）：一条可注入的 Hook。
 *
 * 调试面板、探针与「模拟失焦」这类测试手段都不属于主插件（见
 * [ADR-0003](../docs/adr/0003-test-capability-lives-outside-the-plugin.md)）；发布包里
 * 只留这个服务：它把「页面当前是否在前台」这个**承重判定**做成可被外部覆盖的一位数，
 * 并把只读诊断事实与一条**与自动提醒共用投递路径**的临时投递交出去。
 *
 * 服务名 `sessionStatusTest`，注册方式 `ctx.provide("sessionStatusTest", service)`
 * （与官方 `@deepseek-ai/dsh-client-locale` 的 `ctx.provide("locale", locale)` 同一机制）。
 * 消费方（仓库内 `dev/` 下的独立调试插件）用 `inject: ["sessionStatusTest"]` 或
 * `ctx.inject(["sessionStatusTest"], (child) => child.sessionStatusTest)` 取到它。
 *
 * 接口形状（下文 `model` 是持有状态与投递路径的装配层模型；本 module 只做契约收敛与
 * 参数闸门，不自己读宿主页面、不自己投递）：
 *
 *   - `setForegroundOverride(mode)`  `"auto" | "foreground" | "background"`。
 *     只覆盖**前台判定这一个事实**（快照里的 `background`）；`visibility` / `focused`
 *     仍是宿主原值，等待/停止边沿、去重、抑制之外的静默判断一律不受影响。
 *     `"auto"`（默认）时行为与没有本服务时逐字节一致。返回归一化后的模式。
 *   - `getSnapshot()`   只读诊断事实：`{ notificationPermission, diagnostics:
 *     { status, edge, deliver }, foregroundOverride, page: { visibility, focused,
 *     background } }`；`page.background` 已反映覆盖。**投递时刻的**覆盖模式另在
 *     `diagnostics.deliver.foregroundOverride` 里可读（上报请求体带的是覆盖之后的
 *     `background`，线格式不变）。
 *   - `subscribe(listener)`  状态变化（边沿、投递、状态源摘要、页面事实、覆盖本身）
 *     时通知一次，返回取消订阅函数。与装配层的其它通知共用同一份通知源。
 *   - `deliverAdHoc(kind)`   投递一条临时提醒，`kind` 取 `"test"`（缺省）或
 *     `"interrupted"`；走**同一个投递实例**（tag 序号、桥状态、权限、诊断上报都共用），
 *     因此同样服从前台抑制（要用它在前台验证投递，先 `setForegroundOverride("background")`）。
 *     返回本次是否真的投出去（被抑制时为 `false`，但抑制记录照旧上报）。
 *   - `deliverSample(reason)`  按**某一条停止原因**离线投递一条样例提醒：标题与正文走
 *     `core/text` 的 `terminalHeadline` / `terminalBody`（与真实停止逐字符相同），会话标题
 *     用「示例会话」，技术细节取 `SAMPLE_DETAIL` 里的样例值。`reason` 只认
 *     `TERMINAL_REASONS`（`core/classify` 的完整词表），其余按 `interrupted` 处理。
 *     它存在的理由：11 条停止原因里有几条（模型报错、达到上限、被扩展中止……）在真实
 *     会话里很难按需复现，调试面板需要能在不制造真实故障的前提下把每一条文案都看一遍。
 *     返回是否真的投出去（同样服从前台抑制）。
 */

import { TERMINAL_REASONS } from "../core/classify.mjs";

/**
 * 服务名：`dev/` 调试插件 `inject` 的就是这个名字。
 * （Cordis 的服务名就是 `ctx.provide(name, value)` 的 `name`，也是 `ctx[name]` 的键。）
 */
export const TEST_SERVICE_NAME = "sessionStatusTest";

/**
 * 可被 `deliverSample` 模拟的停止原因：直接用 `core/classify` 的完整词表。
 *
 * 刻意从 `core/classify` 派生而不是在这里另抄一份——词表只有一处定义，将来新增原因时
 * 文案、分类、面板三边不会各说各话。
 */
export const SAMPLE_REASONS = TERMINAL_REASONS;

/**
 * 各原因的**样例技术细节**（真实停止时这部分来自 `turn/end` 的 `reason.error`、
 * `lastAgentError`、被中止的 hook 名等，离线模拟没有那些现场，只能给样例值）。
 * 没有条目的原因（`completed` / `blocked` / 达到上限 ……）本来就没有细节，正文只剩会话标题。
 */
export const SAMPLE_DETAIL = Object.freeze({
  error: "E_MODEL: upstream 502",
  "agent-error": "runtime crashed",
  "prompt-error": "E_NET: offline",
  "aborted-hook": "policy-check"
});

/** `deliverSample` 的入口闸门：词表外一律按 `interrupted`（与 `terminalHeadline` 同一口径）。 */
export function sampleReasonOf(value) {
  return typeof value === "string" && SAMPLE_REASONS.includes(value) ? value : "interrupted";
}

/**
 * 临时提醒的键前缀：沿用既有 JSONL 里探针的 `test-probe`，历史记录因此仍读得通
 * （键形如 `test-probe:test:3`）。
 */
export const ADHOC_KEY_PREFIX = "test-probe";

/** 前台覆盖的三种取值：`auto` 让判定回到宿主事实。 */
export const FOREGROUND_MODES = Object.freeze(["auto", "foreground", "background"]);

/**
 * 前台覆盖的闸门：只认三态，其余（`undefined` / 别的字符串 / 非字符串）一律按 `"auto"`。
 * 与既有 `setTestMode`「只有严格 true 才算打开」同一口径：取值口径只有这一处。
 */
export function foregroundModeOf(value) {
  return typeof value === "string" && FOREGROUND_MODES.includes(value) ? value : "auto";
}

/**
 * 把覆盖落到前台事实上：**只改 `background` 这一位**，`visibility` / `focused` 原样带走。
 *
 * 为什么不改写可见性/焦点：那两位是宿主证据（诊断行显示它们），覆盖只是测试通道对
 * 「结论」的替换。分开保留，面板才能同时显示「宿主说前台」与「测试通道强制失焦」，
 * 而投递判定消费的仍然只有 `background` 这一个值。
 */
export function withForegroundMode(page, mode) {
  const resolved = foregroundModeOf(mode);
  if (resolved === "auto") return page;
  return { ...page, background: resolved === "background" };
}

/**
 * 造测试服务：把装配层模型收敛成上面那四个方法。
 *
 * 收敛本身就是契约的一部分——`dev/` 插件拿到的是这四个键，不是装配层的内部协作者
 * （权限请求 `requestPermission` 属装配层内部路径，不在 Hook 面上）。
 *
 * @param model 装配层模型，需提供 `setForegroundOverride` / `getSnapshot` /
 *              `subscribe` / `deliverAdHoc`（状态与投递路径都在它那一侧）。
 */
export function createTestStatusService(model) {
  return {
    setForegroundOverride(mode) {
      return model.setForegroundOverride(foregroundModeOf(mode));
    },
    getSnapshot() {
      return model.getSnapshot();
    },
    subscribe(listener) {
      return model.subscribe(listener);
    },
    deliverAdHoc(kind) {
      return model.deliverAdHoc(kind === "interrupted" ? "interrupted" : "test");
    },
    deliverSample(reason) {
      return model.deliverSample(sampleReasonOf(reason));
    },
    setDevToolsEnabled(enabled) {
      return model.setDevToolsEnabled(enabled === true);
    }
  };
}
