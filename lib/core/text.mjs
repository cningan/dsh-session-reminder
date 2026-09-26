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
    agentError: "运行错误：{reason}",
    promptError: "操作失败：{reason}",
    turnError: "本轮发生错误：{reason}",
    maxTokens: "本轮达到输出上限",
    blocked: "本轮被阻止",
    abortedByParent: "本轮因父任务停止而中止",
    abortedByHook: "本轮被扩展逻辑中止：{reason}",
    openError: "会话窗口加载失败：{reason}",
    openErrorGeneric: "会话窗口加载失败",
    testNotificationTitle: "DSH 提醒测试",
    testNotificationMessage: "这是一条真实提醒，用于验证当前投递渠道。"
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
    testNotificationTitle: "DSH reminder test",
    testNotificationMessage: "This is a real reminder to verify the available delivery channel."
  }
};

export function terminalText(classified, t) {
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

export function pendingKind(t, kind) {
  const classified = classifyInteraction(kind);
  if (classified === "approval") return t("approval");
  if (classified === "plan-review") return t("planReview");
  return t("question");
}
