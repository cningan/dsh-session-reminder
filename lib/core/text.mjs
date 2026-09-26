/**
 * 文案：字典与「语义 → 文案」映射。
 *
 * 纯 module：接受注入的 `t`（locale 绑定），不自行读取 locale、不碰 DOM。
 * 字典由装配层注册给官方 locale 服务；映射在这里，所以「提醒写什么字」只有一处。
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
