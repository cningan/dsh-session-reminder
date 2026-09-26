/**
 * 上游原因 → 提醒语义。纯函数：无 locale、无浏览器依赖、无状态。
 *
 * 契约（见 SPEC 的「停止判定」与 grilling 共识）：
 * - `reason`  决定用哪条文案模板（`core/text` 负责 reason → 文案）
 * - `detail`  可选的人类可读补充（错误码/消息），填充模板里的占位符
 * - `silent`  真 = 不产生提醒（用户主动取消、已显式移除）
 *
 * 这个 module 是判定核心的一部分：它只回答「这是什么结果」，不回答「要不要提醒」
 * （那是 `core/decide` 的事），也不回答「提醒写什么字」（那是 `core/text` 的事）。
 */

/** terminal 类结果的完整词表；`decide` 与 `text` 都以它为准。 */
export const TERMINAL_REASONS = Object.freeze([
  "completed",
  "interrupted",
  "blocked",
  "max-tokens",
  "error",
  "agent-error",
  "prompt-error",
  "session-open-error",
  "aborted-parent",
  "aborted-hook"
]);

/** 等待交互的子类；`question` 是兜底。 */
export const INTERACTION_KINDS = Object.freeze(["approval", "plan-review", "question"]);

const DETAIL_LIMIT = 220;

function compact(value) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? "" : text.slice(0, DETAIL_LIMIT);
}

function result(reason, detail = "", silent = false) {
  return { reason, detail, silent };
}

/**
 * `turn/end` 的原因（Host `SessionEventWindow` 的 `data.reason`）→ 语义。
 * 形状不符时返回 `undefined`，调用方回落到详情或通用停止。
 */
export function classifyTurnEnd(reason) {
  if (reason === null || typeof reason !== "object" || typeof reason.kind !== "string") return undefined;
  if (reason.kind === "completed") return result("completed");
  if (reason.kind === "aborted") {
    const cause = reason.reason;
    if (cause !== null && typeof cause === "object" && cause.kind === "user") return result("interrupted", "", true);
    if (cause !== null && typeof cause === "object" && cause.kind === "parent") return result("aborted-parent");
    if (cause !== null && typeof cause === "object" && cause.kind === "hook") {
      return result("aborted-hook", compact(cause.reason));
    }
    // 归因不明的中止：保持通用，不猜成完成。
    return result("interrupted");
  }
  if (reason.kind === "blocked") return result("blocked");
  if (reason.kind === "error") {
    const failure = reason.error;
    const detail = [compact(failure?.code), compact(failure?.message)].filter(Boolean).join(": ");
    return result("error", detail);
  }
  if (reason.kind === "max-tokens") return result("max-tokens");
  // interrupted / forked / 以及未来新增的未知 kind：通用停止。
  return result("interrupted");
}

/**
 * 选中会话的详情快照（`SessionSnapshot`）→ 语义。
 * 仅在 `turn/end` 无原因时用于补充；没有可用信息时返回 `undefined`。
 */
export function classifyDetail(detail) {
  if (detail === null || typeof detail !== "object") return undefined;

  const agentError = compact(detail.lastAgentError);
  if (agentError !== "") return result("agent-error", agentError);

  const promptError = detail.promptError?.error;
  const promptMessage = compact(promptError?.message);
  if (promptMessage !== "") {
    const code = compact(promptError?.code);
    return result("prompt-error", code === "" ? promptMessage : `${code}: ${promptMessage}`);
  }

  if (detail.openState === "error") {
    const openError = detail.openError;
    const code = compact(openError?.code);
    const message = compact(openError?.message);
    const suffix = code === "" ? message : message === "" ? code : `${code}: ${message}`;
    return result("session-open-error", suffix);
  }

  return undefined;
}

/** 等待交互的 kind → 提醒子类（未知 kind 一律当作提问）。 */
export function classifyInteraction(kind) {
  if (kind === "approval") return "approval";
  if (kind === "plan-review") return "plan-review";
  return "question";
}

/** 该语义是否需要保持沉默（不产生任何提醒）。 */
export function isSilent(classified) {
  return classified !== undefined && classified.silent === true;
}
