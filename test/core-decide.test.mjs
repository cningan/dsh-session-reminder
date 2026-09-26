/**
 * core/decide 直测：喂领域快照序列，断言产出的 notices。
 *
 * 不模拟浏览器、不 import `vm`：判定核心只认识领域快照，所以这一族测试是纯 Node 直测。
 * 每个用例都按「一轮 = 一次 observe」的时间顺序喂快照，覆盖 SPEC 里列出的判定规则。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createDecider } from "../lib/core/decide.mjs";

/** 一行领域会话；默认是「列表里有、空闲、无等待、未读为假」。 */
function session(id, overrides = {}) {
  return {
    id,
    title: `${id} title`,
    running: false,
    pending: null,
    unread: false,
    inList: true,
    ...overrides
  };
}

function snapshot(sessions, { currentId, current } = {}) {
  return { sessions, currentId, current };
}

/** 连续喂多份快照，返回每轮的 notices。 */
function feed(decider, snapshots) {
  return snapshots.map((next) => decider.observe(next));
}

test("首次观察只建立基线：既有的运行与等待都不追报", () => {
  const idle = createDecider();
  // 已经空闲的会话不是新的停止事件
  assert.deepEqual(idle.observe(snapshot([session("a")])), []);
  assert.deepEqual(idle.observe(snapshot([session("a")])), []);

  const waiting = createDecider();
  // 已经停在等待里的会话也不是新的等待事件
  assert.deepEqual(waiting.observe(snapshot([session("a", { pending: { kind: "approval" } })])), []);
  assert.deepEqual(waiting.observe(snapshot([session("a", { pending: { kind: "approval" } })])), []);

  // 但基线之后的停止边沿照常提醒
  const running = createDecider();
  assert.deepEqual(running.observe(snapshot([session("a", { running: true })])), []);
  assert.deepEqual(running.observe(snapshot([session("a", { running: false })])), [
    { sessionId: "a", title: "a title", kind: "terminal", reason: "interrupted", detail: "" }
  ]);
});

test("未读标记本身不触发提醒，也不被当成停止原因", () => {
  const decider = createDecider();
  const rounds = feed(decider, [
    snapshot([session("a", { unread: false })]),
    snapshot([session("a", { unread: true })]),
    snapshot([session("a", { unread: true })])
  ]);

  assert.deepEqual(rounds, [[], [], []]);
});

test("重复喂同一份空闲快照不产出任何提醒（连接状态不参与判定）", () => {
  const decider = createDecider();
  const rounds = feed(decider, [
    snapshot([session("a")]),
    snapshot([session("a")]),
    snapshot([session("a")]),
    snapshot([session("a")])
  ]);

  assert.deepEqual(rounds, [[], [], [], []]);
});

test("停止边沿用 turn/end 的原因分类", () => {
  const completed = createDecider();
  assert.deepEqual(
    feed(completed, [
      snapshot([session("a", { running: true })]),
      snapshot([session("a", { running: false })], {
        currentId: "a",
        current: { removed: false, turnEnd: { kind: "completed" }, detail: undefined }
      })
    ]).at(-1),
    [{ sessionId: "a", title: "a title", kind: "terminal", reason: "completed", detail: "" }]
  );

  const failed = createDecider();
  assert.deepEqual(
    feed(failed, [
      snapshot([session("a", { running: true })]),
      snapshot([session("a", { running: false })], {
        currentId: "a",
        current: {
          removed: false,
          turnEnd: { kind: "error", error: { code: "MODEL_ERR", message: "quota exhausted" } },
          detail: undefined
        }
      })
    ]).at(-1),
    [{ sessionId: "a", title: "a title", kind: "terminal", reason: "error", detail: "MODEL_ERR: quota exhausted" }]
  );

  const abortedByHook = createDecider();
  assert.deepEqual(
    feed(abortedByHook, [
      snapshot([session("a", { running: true })]),
      snapshot([session("a", { running: false })], {
        currentId: "a",
        current: { removed: false, turnEnd: { kind: "aborted", reason: { kind: "hook", reason: "lint gate" } }, detail: undefined }
      })
    ]).at(-1),
    [{ sessionId: "a", title: "a title", kind: "terminal", reason: "aborted-hook", detail: "lint gate" }]
  );
});

test("turn/end 归因不明时用详情快照补原因", () => {
  const decider = createDecider();
  const rounds = feed(decider, [
    snapshot([session("a", { running: true })]),
    snapshot([session("a", { running: false })], {
      currentId: "a",
      // `{ kind: "interrupted" }` 等于「turn/end 没给出可用原因」，不是可用原因本身
      current: { removed: false, turnEnd: { kind: "interrupted" }, detail: { lastAgentError: "runtime blew up" } }
    })
  ]);

  assert.deepEqual(rounds.at(-1), [
    { sessionId: "a", title: "a title", kind: "terminal", reason: "agent-error", detail: "runtime blew up" }
  ]);
});

test("turn/end 缺席时依次回落：详情快照 → 通用 interrupted", () => {
  const fromPrompt = createDecider();
  assert.deepEqual(
    feed(fromPrompt, [
      snapshot([session("a", { running: true })]),
      snapshot([session("a", { running: false })], {
        currentId: "a",
        current: {
          removed: false,
          turnEnd: undefined,
          detail: { lastAgentError: null, promptError: { error: { code: "E_NET", message: "offline" } }, openState: "open", openError: null }
        }
      })
    ]).at(-1),
    [{ sessionId: "a", title: "a title", kind: "terminal", reason: "prompt-error", detail: "E_NET: offline" }]
  );

  const fromOpen = createDecider();
  assert.deepEqual(
    feed(fromOpen, [
      snapshot([session("a", { running: true })]),
      snapshot([session("a", { running: false })], {
        currentId: "a",
        current: {
          removed: false,
          turnEnd: undefined,
          detail: { lastAgentError: null, promptError: null, openState: "error", openError: { code: "ENOENT", message: "missing" } }
        }
      })
    ]).at(-1),
    [{ sessionId: "a", title: "a title", kind: "terminal", reason: "session-open-error", detail: "ENOENT: missing" }]
  );

  const unknown = createDecider();
  assert.deepEqual(
    feed(unknown, [
      snapshot([session("a", { running: true })]),
      snapshot([session("a", { running: false })], {
        currentId: "a",
        current: { removed: false, turnEnd: undefined, detail: { lastAgentError: null, promptError: null, openState: "open", openError: null } }
      })
    ]).at(-1),
    [{ sessionId: "a", title: "a title", kind: "terminal", reason: "interrupted", detail: "" }]
  );
});

test("详情只属于选中会话：后台会话的停止保持通用原因", () => {
  const decider = createDecider();
  const rounds = feed(decider, [
    snapshot([session("a", { running: true }), session("b", { running: true })], { currentId: "a" }),
    snapshot([session("a", { running: true }), session("b", { running: false })], {
      currentId: "a",
      // 这份详情是选中会话 a 的，不能算到停止的 b 头上
      current: { removed: false, turnEnd: undefined, detail: { lastAgentError: "a blew up" } }
    })
  ]);

  assert.deepEqual(rounds.at(-1), [
    { sessionId: "b", title: "b title", kind: "terminal", reason: "interrupted", detail: "" }
  ]);
});

test("只有观察到的运行 → 停止才算停止边沿；仅列表行消失不触发", () => {
  const decider = createDecider();
  const rounds = feed(decider, [
    // 基线：列表里有这一行、正在运行
    snapshot([session("a", { running: true })]),
    // 列表行没了并且停了：可能是归档/移除，抑制（不产出 notice）
    snapshot([session("a", { running: false, inList: false, unread: true })])
  ]);

  assert.deepEqual(rounds, [[], []]);
});

test("缺失列表行抑制后，同一 run 不再重复判定，新 run 重新提醒", () => {
  const decider = createDecider();
  const rounds = feed(decider, [
    snapshot([session("a", { running: true })]),
    snapshot([session("a", { running: false, inList: false })]), // 抑制
    snapshot([session("a", { running: false, inList: false })]), // 抑制过就不再判定
    snapshot([session("a", { running: false, inList: true })]),  // 列表行回来也不补报
    snapshot([session("a", { running: true, inList: true })]),   // 新 run
    snapshot([session("a", { running: false, inList: true })])
  ]);

  assert.deepEqual(rounds.slice(0, 5), [[], [], [], [], []]);
  assert.deepEqual(rounds.at(-1), [
    { sessionId: "a", title: "a title", kind: "terminal", reason: "interrupted", detail: "" }
  ]);
});

test("用户取消的 turn/end 静默，但仍标记该 run 已处理", () => {
  const decider = createDecider();
  const cancelled = { removed: false, turnEnd: { kind: "aborted", reason: { kind: "user" } }, detail: undefined };
  const rounds = feed(decider, [
    snapshot([session("a", { running: true })], { currentId: "a" }),
    snapshot([session("a", { running: false })], { currentId: "a", current: cancelled }),
    snapshot([session("a", { running: false })], { currentId: "a", current: cancelled })
  ]);

  assert.deepEqual(rounds, [[], [], []]);

  // 静默不阻塞新的 run：下一轮停止照常提醒
  const next = decider.observe(snapshot([session("a", { running: true })], { currentId: "a" }));
  const stopped = decider.observe(snapshot([session("a", { running: false })], { currentId: "a" }));
  assert.deepEqual(next, []);
  assert.deepEqual(stopped, [
    { sessionId: "a", title: "a title", kind: "terminal", reason: "interrupted", detail: "" }
  ]);
});

test("显式移除的选中会话静默，但仍标记该 run 已处理", () => {
  const decider = createDecider();
  const removed = { removed: true, turnEnd: undefined, detail: undefined };
  const rounds = feed(decider, [
    snapshot([session("a", { running: true })], { currentId: "a" }),
    snapshot([session("a", { running: false })], { currentId: "a", current: removed }),
    snapshot([session("a", { running: false })], { currentId: "a", current: removed })
  ]);

  assert.deepEqual(rounds, [[], [], []]);
});

test("等待边沿：已观察到运行之后出现的新等待对象产出 pending 提醒", () => {
  const decider = createDecider();
  const rounds = feed(decider, [
    snapshot([session("a", { running: true })]),
    snapshot([session("a", { running: true, pending: { kind: "plan-review" } })])
  ]);

  assert.deepEqual(rounds, [
    [],
    [{ sessionId: "a", title: "a title", kind: "pending", reason: "plan-review", detail: "" }]
  ]);
});

test("等待去重按对象同一性：同一对象重复观察不重复提醒，新对象是新边沿", () => {
  const decider = createDecider();
  const approval = { kind: "approval" };
  const rounds = feed(decider, [
    snapshot([session("a", { running: true })]),
    snapshot([session("a", { running: true, pending: approval })]),   // 首次出现 → 提醒
    snapshot([session("a", { running: true, pending: approval })]),   // 同一对象 → 去重
    snapshot([session("a", { running: true, pending: { kind: "approval" } })]) // 新对象（即使同 kind）→ 同一 run 已提醒，仍不重复
  ]);

  assert.deepEqual(rounds[0], []);
  assert.deepEqual(rounds[1], [
    { sessionId: "a", title: "a title", kind: "pending", reason: "approval", detail: "" }
  ]);
  assert.deepEqual(rounds[2], []);
  assert.deepEqual(rounds[3], []);

  // 同一 run 里已经提醒过，停止也不会再补一条
  const stopped = decider.observe(snapshot([session("a", { running: false, pending: null })]));
  assert.deepEqual(stopped, []);

  // 新的 run 会让新的等待对象重新成为边沿
  const restarted = decider.observe(snapshot([session("a", { running: true })]));
  const next = decider.observe(snapshot([session("a", { running: true, pending: { kind: "question" } })]));
  assert.deepEqual(restarted, []);
  assert.deepEqual(next, [
    { sessionId: "a", title: "a title", kind: "pending", reason: "question", detail: "" }
  ]);
});

test("同一等待对象的 kind 变化不改判定（身份优先，与既有实现一致）", () => {
  const decider = createDecider();
  const interaction = { kind: "approval" };
  feed(decider, [
    snapshot([session("a", { running: true })]),
    snapshot([session("a", { running: true, pending: interaction })])
  ]);

  interaction.kind = "plan-review";
  assert.deepEqual(decider.observe(snapshot([session("a", { running: true, pending: interaction })])), []);
});

test("等待优先于停止：同一 run 只产出等待那一条", () => {
  const decider = createDecider();
  const rounds = feed(decider, [
    snapshot([session("a", { running: true })]),
    // 停止的同时出现等待（新对象）→ 等待是唯一原因
    snapshot([session("a", { running: false, pending: { kind: "question" } })], {
      currentId: "a",
      current: { removed: false, turnEnd: { kind: "completed" }, detail: undefined }
    }),
    snapshot([session("a", { running: false, pending: null })])
  ]);

  assert.deepEqual(rounds[0], []);
  assert.deepEqual(rounds[1], [
    { sessionId: "a", title: "a title", kind: "pending", reason: "question", detail: "" }
  ]);
  assert.deepEqual(rounds[2], []);
});

test("已在运行中携带等待的会话停止时，等待仍是唯一原因", () => {
  const decider = createDecider();
  const interaction = { kind: "approval" };
  const rounds = feed(decider, [
    // 基线：运行中已在等待
    snapshot([session("a", { running: true, pending: interaction })]),
    // 停下时等待对象没变，但「上一轮在跑而这一轮停了」让等待成为边沿
    snapshot([session("a", { running: false, pending: interaction })], {
      currentId: "a",
      current: { removed: false, turnEnd: { kind: "completed" }, detail: undefined }
    })
  ]);

  assert.deepEqual(rounds[0], []);
  assert.deepEqual(rounds[1], [
    { sessionId: "a", title: "a title", kind: "pending", reason: "approval", detail: "" }
  ]);
});

test("每 run 每种至多一条：重复的停止观察与重复的等待都不再提醒", () => {
  const decider = createDecider();
  const rounds = feed(decider, [
    snapshot([session("a", { running: true })], { currentId: "a" }),
    snapshot([session("a", { running: false })], { currentId: "a" }),
    snapshot([session("a", { running: false })], { currentId: "a" }),
    snapshot([session("a", { running: false, pending: { kind: "approval" } })], { currentId: "a" }),
    snapshot([session("a", { running: false, pending: { kind: "approval" } })], { currentId: "a" })
  ]);

  assert.deepEqual(rounds[0], []);
  assert.deepEqual(rounds[1], [
    { sessionId: "a", title: "a title", kind: "terminal", reason: "interrupted", detail: "" }
  ]);
  assert.deepEqual(rounds.slice(2), [[], [], []]);
});

test("新的 run 重置已提醒标记：运行 → 停止可以再次提醒", () => {
  const decider = createDecider();
  const rounds = feed(decider, [
    snapshot([session("a", { running: true })], { currentId: "a" }),
    snapshot([session("a", { running: false })], { currentId: "a" }),
    snapshot([session("a", { running: true })], { currentId: "a" }),
    snapshot([session("a", { running: false })], { currentId: "a" })
  ]);

  const terminal = { sessionId: "a", title: "a title", kind: "terminal", reason: "interrupted", detail: "" };
  assert.deepEqual(rounds, [[], [terminal], [], [terminal]]);
});

test("会话从快照消失只清除状态，不产出提醒；重现算首次观察", () => {
  const decider = createDecider();
  const rounds = feed(decider, [
    snapshot([session("a", { running: true })], { currentId: "a" }),
    // 会话整行从状态快照消失：清状态，不产出提醒
    snapshot([session("b", { running: false })], { currentId: "a" }),
    // 重现后 running 为真：这是首次观察，不追报
    snapshot([session("a", { running: true })], { currentId: "a" }),
    snapshot([session("a", { running: false })], { currentId: "a" })
  ]);

  assert.deepEqual(rounds[0], []);
  assert.deepEqual(rounds[1], []);
  assert.deepEqual(rounds[2], []);
  assert.deepEqual(rounds[3], [
    { sessionId: "a", title: "a title", kind: "terminal", reason: "interrupted", detail: "" }
  ]);
});

test("消失后再出现不会继承上一轮的已提醒标记", () => {
  const decider = createDecider();
  feed(decider, [
    snapshot([session("a", { running: true })], { currentId: "a" }),
    snapshot([session("a", { running: false })], { currentId: "a" }) // 第 1 轮 run 已提醒
  ]);

  decider.observe(snapshot([], { currentId: "a" })); // 消失：清状态

  const running = decider.observe(snapshot([session("a", { running: true })], { currentId: "a" }));
  const stopped = decider.observe(snapshot([session("a", { running: false })], { currentId: "a" }));
  assert.deepEqual(running, []);
  assert.deepEqual(stopped, [
    { sessionId: "a", title: "a title", kind: "terminal", reason: "interrupted", detail: "" }
  ]);
});

test("多会话各自独立判定，停止的那一个才产出提醒", () => {
  const decider = createDecider();
  const rounds = feed(decider, [
    snapshot([session("a", { running: true }), session("b", { running: true })], { currentId: "a" }),
    snapshot([session("a", { running: true }), session("b", { running: false })], { currentId: "a" }),
    snapshot([session("a", { running: false }), session("b", { running: false })], { currentId: "a" })
  ]);

  assert.deepEqual(rounds[0], []);
  assert.deepEqual(rounds[1], [
    { sessionId: "b", title: "b title", kind: "terminal", reason: "interrupted", detail: "" }
  ]);
  assert.deepEqual(rounds[2], [
    { sessionId: "a", title: "a title", kind: "terminal", reason: "interrupted", detail: "" }
  ]);
});

test("两个 decider 的状态互不干扰（判定状态自持）", () => {
  const first = createDecider();
  const second = createDecider();

  first.observe(snapshot([session("a", { running: true })], { currentId: "a" }));
  assert.deepEqual(second.observe(snapshot([session("a", { running: false })], { currentId: "a" })), []);
  assert.deepEqual(first.observe(snapshot([session("a", { running: false })], { currentId: "a" })), [
    { sessionId: "a", title: "a title", kind: "terminal", reason: "interrupted", detail: "" }
  ]);
});

test("形状不完整的快照被忽略，不会崩也不会产出提醒", () => {
  const decider = createDecider();

  assert.deepEqual(decider.observe(undefined), []);
  assert.deepEqual(decider.observe({}), []);
  assert.deepEqual(decider.observe({ sessions: [null, 42, {}, { id: "" }] }), []);
  assert.deepEqual(decider.observe({ sessions: [{ id: "a" }] }), []);
});

// 以下是**追加**的只读边沿事实通道（`decider.edges`）：`observe` 的 notices 契约不变，
// 边沿事实走独立的只读出口，让诊断 sink 能记录「边沿被观察到、只是没有提醒」那类事实。

test("只读边沿事实不改变 notices：被抑制的停止边沿仍然没有提醒，但边沿被观察到", () => {
  const decider = createDecider();
  assert.deepEqual(decider.edges, []);

  decider.observe(snapshot([session("a", { running: true })]));
  const notices = decider.observe(snapshot([session("a", { running: false, inList: false, unread: true })]));

  // 既有契约：抑制的边沿不产出提醒，observe 返回的仍是没有附加属性的数组。
  assert.deepEqual(notices, []);
  assert.equal(Object.keys(notices).length, notices.length);

  // 只读事实：边沿确实被观察到了，且明说「没有提醒」。
  assert.deepEqual(decider.edges, [{
    sessionId: "a",
    kind: "terminal",
    noticeIndex: null,
    interactionKind: null,
    suppressed: "missing-list-row",
    isCurrent: false,
    hasTurnEndReason: false
  }]);
});

test("只读边沿事实的顺序：已产出提醒的在前（与 notices 同序），仅观察到的在后", () => {
  const decider = createDecider();
  decider.observe(snapshot([session("a", { running: true }), session("b", { running: true })]));

  // a 的列表行不在（抑制）、b 正常停止（提醒）：既有诊断记录也是「先提醒、后抑制」。
  const notices = decider.observe(snapshot([
    session("a", { running: false, inList: false }),
    session("b", { running: false })
  ]));

  assert.deepEqual(notices, [
    { sessionId: "b", title: "b title", kind: "terminal", reason: "interrupted", detail: "" }
  ]);
  assert.deepEqual(decider.edges, [
    {
      sessionId: "b",
      kind: "terminal",
      noticeIndex: 0,
      interactionKind: null,
      suppressed: null,
      isCurrent: false,
      hasTurnEndReason: false
    },
    {
      sessionId: "a",
      kind: "terminal",
      noticeIndex: null,
      interactionKind: null,
      suppressed: "missing-list-row",
      isCurrent: false,
      hasTurnEndReason: false
    }
  ]);
});

test("只读边沿事实区分「静默」（用户取消/已移除）与「被抑制」，并带上选中会话与 turn/end 事实", () => {
  const decider = createDecider();
  const cancelled = { removed: false, turnEnd: { kind: "aborted", reason: { kind: "user" } }, detail: undefined };
  decider.observe(snapshot([session("a", { running: true }), session("c", { running: true })], { currentId: "a" }));

  const notices = decider.observe(snapshot(
    [session("a", { running: false }), session("c", { running: false })],
    { currentId: "a", current: cancelled }
  ));

  assert.deepEqual(notices, [
    { sessionId: "c", title: "c title", kind: "terminal", reason: "interrupted", detail: "" }
  ]);
  assert.deepEqual(decider.edges, [
    {
      sessionId: "c",
      kind: "terminal",
      noticeIndex: 0,
      interactionKind: null,
      suppressed: null,
      isCurrent: false,
      hasTurnEndReason: true
    },
    // 选中会话被用户取消：静默（不是「列表行不在」），所以 suppressed 为 null。
    {
      sessionId: "a",
      kind: "terminal",
      noticeIndex: null,
      interactionKind: null,
      suppressed: null,
      isCurrent: true,
      hasTurnEndReason: true
    }
  ]);
});

test("只读边沿事实给等待边沿带上游交互子类与 notices 下标", () => {
  const decider = createDecider();
  decider.observe(snapshot([session("a", { running: true })]));

  const notices = decider.observe(snapshot([session("a", { running: true, pending: { kind: "plan-review" } })]));
  assert.equal(notices.length, 1);
  assert.deepEqual(decider.edges, [{
    sessionId: "a",
    kind: "pending",
    noticeIndex: 0,
    interactionKind: "plan-review",
    suppressed: null,
    isCurrent: false,
    hasTurnEndReason: false
  }]);
});

test("只读边沿事实是冻结的，且每轮 observe 都重新给出本轮的事实", () => {
  const decider = createDecider();
  decider.observe(snapshot([session("a", { running: true })]));
  const stopped = decider.observe(snapshot([session("a", { running: false })]));

  assert.ok(Object.isFrozen(decider.edges));
  assert.ok(decider.edges.every((edge) => Object.isFrozen(edge)));
  assert.equal(decider.edges.length, 1);
  assert.equal(stopped.length, 1);

  // 没有新边沿的一轮：事实清空（不是沿用上一轮的）。
  const idle = decider.observe(snapshot([session("a", { running: false })]));
  assert.deepEqual(idle, []);
  assert.deepEqual(decider.edges, []);
});

