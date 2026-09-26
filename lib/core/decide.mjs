/**
 * 判定核心：领域快照 → 这一轮该产出哪些提醒（notice）。
 *
 * 纯 module：不碰 DOM、不读 locale、不发通知、不 `fetch`、不打印。判定状态（上一轮快照、
 * 每会话 run 序号、等待/停止是否已提醒）由 decider 自己持有，调用者只按时间顺序喂快照。
 * 「是否在前台」不影响产出：产出 notice 与投递 notice 是两件事，前台抑制属于投递层。
 *
 * 领域快照（由装配层把官方来源归一化成这个形状）：
 *   {
 *     sessions: [{ id, title, running, pending: { kind } | null, unread, inList }],
 *     currentId,
 *     current: { removed, turnEnd, detail } | undefined   // 选中会话的详情，可为 undefined
 *   }
 *   - `pending` 必须是同一个等待请求在多次快照之间复用的**同一个对象**：等待边沿的「变了」
 *     按对象同一性判断（同 kind 的先后两次等待是两次不同的等待）。
 *   - `unread`（官方 completionUnread）只描述未读标记：判定不用它——未读既不证明成功，
 *     也不触发提醒，保留字段只是让快照忠实于上游会话行。
 *   - `inList === false` 表示会话列表快照里没有这一行（可能是归档/移除）。
 *   - `current.turnEnd` 是 `turn/end` 的原始原因对象，直接交给 `classifyTurnEnd`。
 *   - `current.detail` 是已抽取字段的领域形状（`lastAgentError` / `promptError` /
 *     `openState` / `openError`），直接交给 `classifyDetail`。
 *
 * notice（输出，不含文案）：`{ sessionId, title, kind: "pending" | "terminal", reason, detail }`
 *   - `kind: "pending"` 时 `reason` 是交互子类（approval / plan-review / question）
 *   - `kind: "terminal"` 时 `reason` 来自 `classifyTurnEnd` / `classifyDetail`，都没有时用 `"interrupted"`
 *   - `title` 是会话标题；文案映射（`core/text`）与投递都是调用者的事。
 *
 * 只读边沿事实（`decider.edges`，**追加**通道，不改 `observe` 的 notices 契约）：
 * notice 只表达「该提醒」；被抑制（列表行不在）与静默（用户取消、已显式移除）的停止
 * 边沿没有 notice，但诊断读方需要「边沿被观察到、只是没有投递」这条证据。判定核心是
 * 唯一知道「边沿」的地方，所以它额外暴露一份只读事实，让装配层不必自己记账 run 边沿：
 *
 *   edge = {
 *     sessionId,
 *     kind: "pending" | "terminal",
 *     noticeIndex: number | null,  // 该边沿在**本次** observe 的 notices 里的下标；null = 只观察到边沿、没有提醒
 *     interactionKind,             // pending：上游交互子类（诊断原文用）
 *     suppressed,                  // terminal："missing-list-row"（列表行不在）| null
 *     isCurrent,                   // terminal：是不是本轮选中的会话
 *     hasTurnEndReason             // terminal：本轮有没有 turn/end 原因
 *   }
 *
 * `edges` 的顺序与既有诊断记录一致：先「本轮产出提醒的边沿」（与 notices 同序），
 * 再「仅观察到的边沿」（按快照顺序）——诊断 sink 按这个顺序上报即与历史 JSONL 逐字节一致。
 * 边沿事实是只读的（数组与每条事实都 frozen），调用者不得修改。
 */

import { classifyDetail, classifyInteraction, classifyTurnEnd } from "./classify.mjs";

/**
 * 停止边沿的语义：要么是「静默」（用户主动取消这类不该打扰的结果），要么给出一组 reason/detail。
 * `current` 只在停止的正是选中会话时才有值。
 */
function classifyStop(current) {
  const turnEnd = current === undefined ? undefined : current.turnEnd;
  const detail = current === undefined ? undefined : current.detail;
  const classified = classifyTurnEnd(turnEnd);
  if (classified !== undefined) {
    if (classified.silent === true) return { silent: true };
    // 通用 `interrupted` 等于「turn/end 没给出可用原因」：继续看详情快照，与既有实现一致。
    if (classified.reason !== "interrupted") return { reason: classified.reason, detail: classified.detail };
  }
  const fromDetail = classifyDetail(detail);
  if (fromDetail !== undefined) return { reason: fromDetail.reason, detail: fromDetail.detail };
  return { reason: "interrupted", detail: "" };
}

export function createDecider() {
  /** sessionId → { sequence, running, waitingNotified, terminalNotified }：每会话的 run 状态。 */
  const runs = new Map();
  /** sessionId → 上一轮观察到的 pending 交互对象；没有这个键 = 上一轮没见过该会话。 */
  const previousPending = new Map();
  /** 上一次 observe 观察到的边沿事实（只读；见文件头）。 */
  let lastEdges = Object.freeze([]);

  return {
    /**
     * 上一次 `observe` 观察到的边沿事实（只读）：已产出提醒的在前、仅观察到的在后，
     * 见文件头。`observe` 返回的 notices 契约不受它影响。
     */
    get edges() {
      return lastEdges;
    },

    /** 按时间顺序喂一份领域快照，返回这一轮该产出的提醒（可能为空）。 */
    observe(snapshot) {
      const notices = [];
      // 边沿事实分两段攒（顺序即既有诊断记录的顺序，见文件头）。
      const notifiedEdges = [];
      const observedEdges = [];
      const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
      const currentId = snapshot?.currentId;
      const current = snapshot?.current;
      // 本轮有没有 turn/end 原因：同一轮的每条停止边沿记录用同一个值（与既有实现一致）。
      const hasTurnEndReason = current !== null && current !== undefined && current.turnEnd !== undefined;
      const seen = new Set();

      const edgeFact = (sessionId, kind, noticeIndex, extra) => Object.freeze({
        sessionId,
        kind,
        noticeIndex,
        interactionKind: null,
        suppressed: null,
        isCurrent: sessionId === currentId,
        hasTurnEndReason,
        ...extra
      });

      for (const session of sessions) {
        if (session === null || typeof session !== "object") continue;
        const sessionId = session.id;
        if (typeof sessionId !== "string" || sessionId === "") continue;
        seen.add(sessionId);

        const running = session.running === true;
        const pending = session.pending === undefined || session.pending === null ? undefined : session.pending;
        const seenBefore = previousPending.has(sessionId);
        const oldPending = previousPending.get(sessionId);

        let run = runs.get(sessionId);
        let initial = false;
        let wasRunning = false;
        if (run === undefined) {
          // 首次观察只建立基线：不追报它既有的等待或空闲。
          run = { sequence: running ? 1 : 0, running, waitingNotified: false, terminalNotified: false };
          runs.set(sessionId, run);
          initial = true;
        } else {
          wasRunning = run.running;
          if (running && !wasRunning) {
            // 新的 run：序号 +1，并重置本 run 的已提醒标记。
            run.sequence += 1;
            run.waitingNotified = false;
            run.terminalNotified = false;
          }
          run.running = running;
        }

        // 等待边沿：只在已观察到运行之后出现的等待才算中奖（sequence > 0），同一 run 至多一条。
        // 「出现」有两种：等待换了对象（按对象同一性），或上一轮在跑而这一轮停了。
        const waitingEdge = pending !== undefined && run.sequence > 0
          && !run.waitingNotified && !run.terminalNotified
          && ((seenBefore && oldPending !== pending) || (!initial && wasRunning && !running));
        if (waitingEdge) {
          const noticeIndex = notices.length;
          notices.push({
            sessionId,
            title: session.title,
            kind: "pending",
            reason: classifyInteraction(pending.kind),
            detail: ""
          });
          notifiedEdges.push(edgeFact(sessionId, "pending", noticeIndex, { interactionKind: pending.kind ?? null }));
          // 等待优先于停止：同一 run 里已因等待提醒过，就不再有停止提醒。
          run.waitingNotified = true;
          run.terminalNotified = true;
        }

        // 停止边沿：只能是「观察到的运行 → 停止」。
        if (!initial && wasRunning && !running && !run.terminalNotified) {
          // 抑制与静默同样算「这一轮已处理」，不再重复判定。
          run.terminalNotified = true;
          const selected = sessionId === currentId ? current : undefined;
          // `inList === false`（列表行不在了，可能是归档/移除）与已显式移除的选中会话都不产出提醒。
          const suppressed = session.inList === false ? "missing-list-row" : null;
          let notice;
          if (session.inList !== false && selected?.removed !== true) {
            const stop = classifyStop(selected);
            if (stop.silent !== true) {
              notice = {
                sessionId,
                title: session.title,
                kind: "terminal",
                reason: stop.reason,
                detail: stop.detail
              };
            }
          }
          if (notice !== undefined) {
            const noticeIndex = notices.length;
            notices.push(notice);
            notifiedEdges.push(edgeFact(sessionId, "terminal", noticeIndex, {}));
          } else {
            // 观察到停止边沿但没有提醒：抑制、静默、或选中会话被显式移除。
            observedEdges.push(edgeFact(sessionId, "terminal", null, { suppressed }));
          }
        }

        previousPending.set(sessionId, pending);
      }

      // 会话从快照消失：清除它的状态（不产出提醒）。
      for (const sessionId of [...previousPending.keys()]) {
        if (seen.has(sessionId)) continue;
        previousPending.delete(sessionId);
        runs.delete(sessionId);
      }

      lastEdges = Object.freeze([...notifiedEdges, ...observedEdges]);
      return notices;
    }
  };
}
