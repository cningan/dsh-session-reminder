/**
 * 文案：字典与「语义 → 文案」映射。
 *
 * 纯 module：接受注入的 `t`（locale 绑定），不自行读取 locale、不碰 DOM。
 * 字典由装配层注册给官方 locale 服务；映射在这里，所以「提醒写什么字」只有一处。
 * 本插件不含任何设置 UI，因此字典里只有**通知文案**（含测试服务投递的那条固定载荷）；
 * 设置区标签与权限状态文案已随设置界面一并删除。
 */

import { classifyInteraction } from "./classify.mjs";

export const dictionaries = {
  zh: {
    unknownStopped: "会话已停止，但无法确定原因",
    separator: "：",
    waitTitle: "会话等待你的{kind}",
    approval: "审批",
    planReview: "计划审查",
    question: "回答",
    completed: "本轮会话已完成",
    interrupted: "会话已中断或停止",
    processInterruptedTitle: "本轮未完成（DSH 已退出）",
    blockedTitle: "本轮被阻止",
    maxTokensTitle: "本轮达到输出上限",
    turnErrorTitle: "本轮发生错误",
    agentErrorTitle: "会话运行出错",
    promptErrorTitle: "操作失败",
    openErrorTitle: "会话窗口加载失败",
    abortedByParentTitle: "本轮因父任务停止而中止",
    abortedByHookTitle: "本轮被扩展逻辑中止",
    testNotificationTitle: "DSH 提醒测试",
    testNotificationMessage: "这是一条真实提醒，用于验证当前投递渠道。",
    sampleSessionTitle: "示例会话"
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
    processInterruptedTitle: "This run did not finish (DSH exited)",
    blockedTitle: "This run was blocked",
    maxTokensTitle: "This run reached the output limit",
    turnErrorTitle: "This run failed",
    agentErrorTitle: "Session runtime error",
    promptErrorTitle: "Operation failed",
    openErrorTitle: "The session window failed to load",
    abortedByParentTitle: "The parent task stopped this run",
    abortedByHookTitle: "An extension stopped this run",
    testNotificationTitle: "DSH reminder test",
    testNotificationMessage: "This is a real reminder to verify the available delivery channel.",
    sampleSessionTitle: "Sample session"
  }
};

/**
 * reason → 通知**标题**（一句话说清「为什么停」）。正文由 `terminalText` 给。
 *
 * 标题与正文分开是因为通知的标题才是用户先看到的那一行：把原因塞进正文、标题永远写
 * 「已中断或停止」，用户就分不出「跑完了」「出错了」「进程退了」。没有专属标题的
 * reason 回落到通用 `interrupted`，不猜。
 */
const HEADLINE_KEYS = Object.freeze({
  completed: "completed",
  interrupted: "interrupted",
  "process-interrupted": "processInterruptedTitle",
  blocked: "blockedTitle",
  "max-tokens": "maxTokensTitle",
  error: "turnErrorTitle",
  "agent-error": "agentErrorTitle",
  "prompt-error": "promptErrorTitle",
  "session-open-error": "openErrorTitle",
  "aborted-parent": "abortedByParentTitle",
  "aborted-hook": "abortedByHookTitle"
});

export function terminalHeadline(reason, t) {
  const key = Object.prototype.hasOwnProperty.call(HEADLINE_KEYS, reason) ? HEADLINE_KEYS[reason] : "interrupted";
  return t(key);
}

/**
 * reason + detail → 通知**正文**里跟在会话标题之后的那一句。
 *
 * 只写标题没说的那一点：具体错误码/消息、被哪个扩展中止。标题已经说完的
 * （completed / blocked / max-tokens / aborted-parent / process-interrupted）返回 ""，
 * 调用方因此不再拼分隔符——通知里不会出现「本轮发生错误：本轮发生错误：…」这种复读。
 *
 * `interrupted`（通用停止）唯一能说的是「原因不可知」；带 detail 的原因若 detail 是空串
 * （上游只给了 kind），同样退回这一句，而不是编一个细节。
 */
export function terminalBody(classified, t) {
  const detail = typeof classified.detail === "string" ? classified.detail.trim() : "";
  switch (classified.reason) {
    case "error":
    case "agent-error":
    case "prompt-error":
    case "aborted-hook":
    case "session-open-error":
      return detail === "" ? t("unknownStopped") : detail;
    case "interrupted":
      return t("unknownStopped");
    default:
      return "";
  }
}

export function pendingKind(t, kind) {
  const classified = classifyInteraction(kind);
  if (classified === "approval") return t("approval");
  if (classified === "plan-review") return t("planReview");
  return t("question");
}
