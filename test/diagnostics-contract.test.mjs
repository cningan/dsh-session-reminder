/**
 * 诊断契约直测（`lib/diagnostics-contract.mjs`）：这条 wire 语义的 owner 是它，所以这
 * 里断言的是**三方共用的那份东西**本身——不模拟浏览器、不碰 Host 路由，只喂记录。
 *
 *   1. 事件词表：六类客户端事件 + Host 自己写的两类；裸名不带 `client:` 前缀；
 *   2. 落盘前缀规则：`storedEventName`（写方）与 `bareEventName`（读方）互逆，且读方
 *      **只认词表里的名字**（Host 行、没见过的名字 → null，读方因此不解释它们）；
 *   3. 载荷最小形状表本身是良构的（required 都在 fields 里声明、类型名都在词典内、
 *      变体的分叉字段已声明）——表坏了校验会静默放行，所以这条也要测；
 *   4. `validateRecord` 对六类事件的**规范记录**放行（含容忍未知字段与缺席的 `build`：
 *      契约只能向前加字段），对形状不符的记录**逐条拒绝**并给出可读原因（阳性对照：
 *      每一条拒绝都是对一条合法记录的定点变异，防止断言退化成永真）；
 *   5. envelope 的字段顺序由 `createRecord` 固定，`build` 缺席时不写这个字段。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_BUILDS,
  CLIENT_EVENT_PREFIX,
  DIAGNOSTIC_EVENTS,
  EVENT_NAMES,
  HOST_BUILD,
  HOST_EVENTS,
  PAYLOAD_SHAPES,
  PLATFORM_EVENT_NAMES,
  bareEventName,
  compileTimeBuild,
  createRecord,
  isKnownEvent,
  readBuild,
  storedEventName,
  validatePayload,
  validateRecord
} from "../lib/diagnostics-contract.mjs";
import { INTERPRETED_EVENTS, VERDICTS, analyze } from "../scripts/check-diagnostics.mjs";

const AT = "2026-09-26T10:20:30.000Z";

/** 一条规范记录（可选覆盖 envelope / payload）。 */
function record(event, payload, overrides = {}) {
  return { at: AT, event, payload, ...overrides };
}

/** 六类事件的**规范载荷**：字段取真实生产者的形状（见 assembly / delivery / sink）。 */
const VALID = Object.freeze({
  [DIAGNOSTIC_EVENTS.ATTACH]: {
    hasSessionsList: true,
    hasSessionStatus: true,
    hasCurrentScope: true,
    visibility: "visible",
    focused: false,
    browserPermission: "granted",
    nativeBridge: false,
    userActivation: { active: false, everActive: true }
  },
  [DIAGNOSTIC_EVENTS.STATUS]: {
    statusEntries: 2,
    currentId: "current",
    currentInStatuses: true,
    listHandlesCurrent: true,
    runs: [{ id: "current", running: true, pending: false, unread: false, inList: true }]
  },
  [DIAGNOSTIC_EVENTS.EDGE]: { sessionId: "a", kind: "terminal", suppressed: null, isCurrent: true, hasTurnEndReason: true },
  [DIAGNOSTIC_EVENTS.DELIVER]: {
    key: "terminal:a:1",
    kind: "interrupted",
    sessionId: "a",
    channel: "browser",
    delivered: true,
    background: true,
    browserPermission: "granted",
    nativeBridge: false,
    userActivation: null
  },
  [DIAGNOSTIC_EVENTS.PLATFORM]: { key: "terminal:a:1", event: "onshow", error: null },
  [DIAGNOSTIC_EVENTS.SOURCE_SHAPE]: { stage: "list", byIdType: "undefined", snapshotKeys: null }
});

test("词表是六类客户端事件的单一来源，Host 自己写的两类另有其表", () => {
  assert.ok(Object.isFrozen(DIAGNOSTIC_EVENTS));
  assert.deepEqual(Object.keys(DIAGNOSTIC_EVENTS).sort(),
    ["ATTACH", "DELIVER", "EDGE", "PLATFORM", "SOURCE_SHAPE", "STATUS"]);
  assert.deepEqual(Object.values(DIAGNOSTIC_EVENTS).sort(),
    ["attach", "deliver", "edge", "platform", "source-shape", "status"]);
  assert.deepEqual(EVENT_NAMES, Object.values(DIAGNOSTIC_EVENTS));
  // Client 上报的是裸名：`client:` 前缀是 Host 落盘时才加的（前缀规则的唯一实现）。
  for (const name of EVENT_NAMES) {
    assert.equal(name.startsWith(CLIENT_EVENT_PREFIX), false);
    assert.equal(isKnownEvent(name), true);
  }
  // Host 自己的行不是 Client 事件，也不在词表里。
  for (const name of Object.values(HOST_EVENTS)) {
    assert.equal(isKnownEvent(name), false);
  }
  assert.deepEqual(Object.values(HOST_EVENTS).sort(), ["diagnostics-rejected", "host-ready"]);
  assert.equal(HOST_BUILD, "host");
  assert.deepEqual(Object.values(CLIENT_BUILDS).sort(), ["debug", "production"]);
});

test("落盘前缀规则：写方加前缀，读方只认词表里的名字", () => {
  assert.equal(storedEventName(DIAGNOSTIC_EVENTS.EDGE), "client:edge");
  assert.equal(storedEventName("client:edge"), "client:edge"); // 幂等
  assert.equal(storedEventName(""), "");
  assert.equal(storedEventName(undefined), undefined);

  assert.equal(bareEventName("client:edge"), DIAGNOSTIC_EVENTS.EDGE);
  // Host 自己写的行、词表外的名字、裸名（没有前缀就不是落盘形状）都给 null：
  // 读方据此「只解释它认识的事件」。
  assert.equal(bareEventName(HOST_EVENTS.READY), null);
  assert.equal(bareEventName(HOST_EVENTS.REJECTED), null);
  assert.equal(bareEventName("client:telemetry"), null);
  assert.equal(bareEventName("edge"), null);
  assert.equal(bareEventName(undefined), null);
  assert.equal(bareEventName(42), null);
});

test("载荷形状表是良构的：required 都声明了类型，类型名都在词典内", () => {
  const knownTypes = ["string", "number", "boolean", "object", "array", "null"];
  for (const [event, shape] of Object.entries(PAYLOAD_SHAPES)) {
    assert.equal(isKnownEvent(event), true, `${event} 应是词表里的事件`);
    const variants = shape.variants === undefined ? { [event]: shape } : shape.variants;
    if (shape.variants !== undefined) {
      // 分叉事件必须声明分叉字段，且每个变体自己声明 required 与类型。
      assert.equal(typeof shape.discriminator, "string");
      for (const [name, variant] of Object.entries(shape.variants)) {
        assert.equal(Object.prototype.hasOwnProperty.call(variant.fields, shape.discriminator), true,
          `${event}[${name}] 必须声明分叉字段 ${shape.discriminator} 的类型`);
      }
    }
    for (const [name, variant] of Object.entries(variants)) {
      for (const field of variant.required) {
        assert.equal(Object.prototype.hasOwnProperty.call(variant.fields, field), true,
          `${event}[${name}] 的必填字段 ${field} 必须声明类型`);
      }
      for (const [field, allowed] of Object.entries(variant.fields)) {
        assert.ok(Array.isArray(allowed) && allowed.length > 0, `${event}.${field} 的类型声明不能为空`);
        for (const type of allowed) assert.ok(knownTypes.includes(type), `${event}.${field} 的类型 ${type} 不合法`);
      }
      for (const field of Object.keys(variant.enums ?? {})) {
        assert.equal(Object.prototype.hasOwnProperty.call(variant.fields, field), true,
          `${event}.${field} 的枚举必须同时声明类型`);
      }
    }
  }
  assert.deepEqual(PLATFORM_EVENT_NAMES, ["onshow", "onerror", "onclose"]);
});

test("六类事件的规范记录都通过校验（valid 是下面每条拒绝用例的阳性对照）", () => {
  for (const [event, payload] of Object.entries(VALID)) {
    const verdict = validateRecord(record(event, payload));
    assert.equal(verdict.ok, true, `${event} 的规范记录应通过：${verdict.reason ?? ""}`);
    assert.equal(verdict.event, event);
    assert.equal(verdict.payload, payload);
    // 一份记录也可以显式带上 build（构建产物总是带）。
    assert.equal(validateRecord(record(event, payload, { build: CLIENT_BUILDS.DEBUG })).ok, true);
  }
});

test("契约只向前加字段：未知字段与缺席的 build 都不算坏记录", () => {
  // 读方/写方都可能比对方新：没见过的字段（envelope 或载荷里的）都容忍。
  const forward = record(DIAGNOSTIC_EVENTS.DELIVER, { ...VALID[DIAGNOSTIC_EVENTS.DELIVER], futureField: 1 },
    { futureEnvelopeField: "x" });
  assert.equal(validateRecord(forward).ok, true);

  // 旧版本产物（没有 build）仍要能落盘：这条决定 Host 与 Client 可以各自独立升级。
  const legacy = record(DIAGNOSTIC_EVENTS.STATUS, VALID[DIAGNOSTIC_EVENTS.STATUS]);
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, "build"), false);
  assert.equal(validateRecord(legacy).ok, true);
  assert.equal(readBuild(legacy), null);
  assert.equal(readBuild({ build: CLIENT_BUILDS.DEBUG }), CLIENT_BUILDS.DEBUG);
  assert.equal(readBuild({ build: "" }), null);
  assert.equal(readBuild(null), null);
});

test("读方写下的那份固定样本形状本身是合法记录（历史更薄的 edge 也在容忍范围内）", () => {
  // check-diagnostics 的样本：edge 带一个词表外的 `key`、没有 isCurrent/hasTurnEndReason。
  const thin = record(DIAGNOSTIC_EVENTS.EDGE, { key: "terminal:session-abc:1", kind: "terminal", sessionId: "session-abc", suppressed: null });
  assert.equal(validateRecord(thin).ok, true);
});

test("形状不符的记录逐条被拒绝，并给出可读原因", () => {
  const cases = [
    ["不是对象", "client:edge", /记录必须是对象/],
    ["event 缺失", record(undefined, VALID[DIAGNOSTIC_EVENTS.EDGE]), /event 必须是非空字符串/],
    ["event 为空串", record("", VALID[DIAGNOSTIC_EVENTS.EDGE]), /event 必须是非空字符串/],
    ["event 带了落盘前缀", record("client:edge", VALID[DIAGNOSTIC_EVENTS.EDGE]), /裸事件名/],
    ["event 不在词表", record("telemetry", {}), /未知事件 telemetry/],
    ["at 缺失", { event: DIAGNOSTIC_EVENTS.EDGE, payload: VALID[DIAGNOSTIC_EVENTS.EDGE] }, /at 必须是可解析/],
    ["at 不可解析", record(DIAGNOSTIC_EVENTS.EDGE, VALID[DIAGNOSTIC_EVENTS.EDGE], { at: "not a date" }), /at 必须是可解析/],
    ["build 不是字符串", record(DIAGNOSTIC_EVENTS.EDGE, VALID[DIAGNOSTIC_EVENTS.EDGE], { build: 7 }), /build 必须是非空字符串/],
    ["payload 不是对象", record(DIAGNOSTIC_EVENTS.EDGE, "nope"), /payload 必须是对象/],
    ["payload 是数组", record(DIAGNOSTIC_EVENTS.EDGE, []), /payload 必须是对象/],
    ["payload 缺失", record(DIAGNOSTIC_EVENTS.EDGE, undefined), /payload 必须是对象/]
  ];

  for (const [label, input, expected] of cases) {
    const verdict = validateRecord(input);
    assert.equal(verdict.ok, false, `${label} 应被拒绝`);
    assert.match(verdict.reason, expected, `${label} 的原因：${verdict.reason}`);
  }
});

test("每个事件的定点变异都被拒绝：分叉、必填、类型与枚举各有牙齿", () => {
  const mutate = (event, patch) => ({ ...VALID[event], ...patch });
  const rejects = (event, payload, expected) => {
    const verdict = validatePayload(event, payload);
    assert.equal(verdict.ok, false, `${event} ${JSON.stringify(payload)} 应被拒绝`);
    assert.match(verdict.reason, expected);
  };

  // edge：形状随 kind 分叉，「哪种边沿」和「有没有被抑制」都是语义的一部分。
  rejects(DIAGNOSTIC_EVENTS.EDGE, mutate(DIAGNOSTIC_EVENTS.EDGE, { kind: "waiting" }), /kind 必须是 pending \/ terminal/);
  rejects(DIAGNOSTIC_EVENTS.EDGE, { sessionId: "a", kind: "terminal" }, /缺少 suppressed/);
  rejects(DIAGNOSTIC_EVENTS.EDGE, { sessionId: "a", kind: "terminal", suppressed: 5 }, /suppressed 期望 string\|null/);
  rejects(DIAGNOSTIC_EVENTS.EDGE, { sessionId: "a", kind: "pending", interactionKind: 5 }, /interactionKind 期望 string\|null/);
  rejects(DIAGNOSTIC_EVENTS.EDGE, { kind: "pending", interactionKind: null }, /缺少 sessionId/);
  rejects(DIAGNOSTIC_EVENTS.EDGE, mutate(DIAGNOSTIC_EVENTS.EDGE, { isCurrent: "yes" }), /isCurrent 期望 boolean/);
  // pending 那一支通过（同一张表的两支都要有阳性对照）。
  assert.equal(validatePayload(DIAGNOSTIC_EVENTS.EDGE, { sessionId: "a", kind: "pending", interactionKind: null }).ok, true);
  assert.equal(validatePayload(DIAGNOSTIC_EVENTS.EDGE, { sessionId: "a", kind: "pending", interactionKind: "approval" }).ok, true);

  // deliver：reader 的结论建立在 channel / delivered / key / background 上。
  rejects(DIAGNOSTIC_EVENTS.DELIVER, mutate(DIAGNOSTIC_EVENTS.DELIVER, { delivered: "true" }), /delivered 期望 boolean/);
  rejects(DIAGNOSTIC_EVENTS.DELIVER, { channel: "browser", delivered: true }, /缺少 key/);
  rejects(DIAGNOSTIC_EVENTS.DELIVER, { key: "k", channel: "browser", delivered: true }, /缺少 background/);
  rejects(DIAGNOSTIC_EVENTS.DELIVER, mutate(DIAGNOSTIC_EVENTS.DELIVER, { userActivation: [] }), /userActivation 期望 object\|null/);

  // platform：平台生命周期事件名被枚举化。
  rejects(DIAGNOSTIC_EVENTS.PLATFORM, mutate(DIAGNOSTIC_EVENTS.PLATFORM, { event: "onplatform" }), /只接受 onshow\/onerror\/onclose/);
  rejects(DIAGNOSTIC_EVENTS.PLATFORM, { key: "k", event: "onshow" }, /缺少 error/);
  assert.equal(validatePayload(DIAGNOSTIC_EVENTS.PLATFORM, { key: "k", event: "onerror", error: "boom" }).ok, true);

  // status / source-shape：读方打印的字段就是必填字段。
  rejects(DIAGNOSTIC_EVENTS.STATUS, { statusEntries: 1 }, /缺少 currentId/);
  rejects(DIAGNOSTIC_EVENTS.STATUS, mutate(DIAGNOSTIC_EVENTS.STATUS, { runs: "nope" }), /runs 期望 array/);
  rejects(DIAGNOSTIC_EVENTS.SOURCE_SHAPE, { byIdType: "undefined" }, /缺少 stage/);

  // attach：字段一个都不必填（读方不读它），但**声明过的**字段一旦出现就校验类型。
  rejects(DIAGNOSTIC_EVENTS.ATTACH, { hasSessionsList: "yes" }, /hasSessionsList 期望 boolean/);
  rejects(DIAGNOSTIC_EVENTS.ATTACH, { visibility: 1 }, /visibility 期望 string/);
  assert.equal(validatePayload(DIAGNOSTIC_EVENTS.ATTACH, VALID[DIAGNOSTIC_EVENTS.ATTACH]).ok, true);

  // 未知事件没有形状可言。
  assert.match(validatePayload("telemetry", {}).reason, /未知事件/);
});

test("createRecord 定死 envelope 的字段顺序，build 缺席时不写这个字段", () => {
  assert.deepEqual(Object.keys(createRecord({ at: AT, event: "edge", payload: {}, build: CLIENT_BUILDS.PRODUCTION })),
    ["at", "event", "payload", "build"]);
  assert.deepEqual(createRecord({ at: AT, event: "edge", payload: {} }), { at: AT, event: "edge", payload: {} });
  assert.deepEqual(createRecord({ at: AT, event: "edge", payload: {}, build: "" }), { at: AT, event: "edge", payload: {} });
  assert.deepEqual(createRecord(), { at: undefined, event: undefined, payload: undefined });
});

test("构建标注默认值：不在构建产物里跑时按正式构建算", () => {
  // Node 直测没有 __DEBUG__（构建产物里由 esbuild define 成字面量，见 model-surface 直测）。
  assert.equal(compileTimeBuild(), CLIENT_BUILDS.PRODUCTION);
});

// —— 读方与契约：它消费同一份词表，**只解释它认识的事件** ——

/** 落盘形状的一行（读方看到的就是这个）。 */
function stored(bareEvent, payload, extra = {}) {
  return { at: AT, event: storedEventName(bareEvent), payload, ...extra };
}

test("读方的解释名单是词表的子集：attach 与 Host 自己写的行都不参与结论", () => {
  assert.deepEqual([...INTERPRETED_EVENTS].sort(),
    ["deliver", "edge", "platform", "source-shape", "status"]);
  for (const event of INTERPRETED_EVENTS) assert.equal(isKnownEvent(event), true);
  assert.equal(INTERPRETED_EVENTS.includes(DIAGNOSTIC_EVENTS.ATTACH), false);

  // 词表外的事件即使载荷长得像 deliver、还配了同 key 的 onshow，也不能被解释成成功。
  const mislabeled = [
    stored(DIAGNOSTIC_EVENTS.ATTACH, VALID[DIAGNOSTIC_EVENTS.ATTACH]),
    stored(DIAGNOSTIC_EVENTS.DELIVER, VALID[DIAGNOSTIC_EVENTS.DELIVER], { event: "client:telemetry" }),
    stored(DIAGNOSTIC_EVENTS.PLATFORM, VALID[DIAGNOSTIC_EVENTS.PLATFORM], { event: "client:deliver-ack" }),
    { at: AT, event: HOST_EVENTS.READY, payload: {} },
    { at: AT, event: HOST_EVENTS.REJECTED, payload: { rejected: 1 } }
  ];
  const verdict = analyze(mislabeled);
  assert.equal(verdict.label, "PENDING");
  assert.equal(verdict.code, VERDICTS.PENDING);
  assert.notEqual(verdict.label, "OK");
});

test("读方把 build 当作事实报出来：哪台仪器写的、是不是同一台", () => {
  const deliver = VALID[DIAGNOSTIC_EVENTS.DELIVER];
  const platform = VALID[DIAGNOSTIC_EVENTS.PLATFORM];
  const edge = VALID[DIAGNOSTIC_EVENTS.EDGE];

  const one = analyze([
    stored(DIAGNOSTIC_EVENTS.EDGE, edge, { build: CLIENT_BUILDS.PRODUCTION }),
    stored(DIAGNOSTIC_EVENTS.DELIVER, deliver, { build: CLIENT_BUILDS.PRODUCTION }),
    stored(DIAGNOSTIC_EVENTS.PLATFORM, platform, { build: CLIENT_BUILDS.PRODUCTION })
  ]);
  assert.deepEqual([...one.build], [CLIENT_BUILDS.PRODUCTION]);
  assert.ok(one.report.some((line) => line === `BUILD:    ${CLIENT_BUILDS.PRODUCTION}`));
  assert.equal(one.label, "OK");

  const mixed = analyze([
    stored(DIAGNOSTIC_EVENTS.EDGE, edge, { build: CLIENT_BUILDS.PRODUCTION }),
    stored(DIAGNOSTIC_EVENTS.EDGE, { ...edge, sessionId: "b" }, { build: CLIENT_BUILDS.DEBUG })
  ]);
  assert.deepEqual([...mixed.build], [CLIENT_BUILDS.DEBUG, CLIENT_BUILDS.PRODUCTION]);
  assert.ok(mixed.report.some((line) => /混合/.test(line)));

  // 旧版本产物（没标注构建）与 Host 行都不会被算成一台仪器。
  const unlabeled = analyze([stored(DIAGNOSTIC_EVENTS.EDGE, edge), { at: AT, event: HOST_EVENTS.READY, payload: {} }]);
  assert.deepEqual([...unlabeled.build], []);
  assert.ok(unlabeled.report.some((line) => /未标注构建/.test(line)));
});

test("未确认的结论会交代仪器：正式构建里没有探针可再问一遍", () => {
  const deliver = VALID[DIAGNOSTIC_EVENTS.DELIVER];
  const sample = (extra) => [
    stored(DIAGNOSTIC_EVENTS.EDGE, VALID[DIAGNOSTIC_EVENTS.EDGE], extra),
    stored(DIAGNOSTIC_EVENTS.DELIVER, deliver, extra)
  ];

  const production = analyze(sample({ build: CLIENT_BUILDS.PRODUCTION }));
  assert.equal(production.label, "UNCONFIRMED");
  assert.equal(production.code, VERDICTS.UNCONFIRMED);
  assert.match(production.message, /正式构建/);
  // 结论文字不得把"调用成功"说成"已显示"。
  assert.doesNotMatch(production.message, /平台确认显示/);

  const debug = analyze(sample({ build: CLIENT_BUILDS.DEBUG }));
  assert.equal(debug.label, "UNCONFIRMED");
  assert.doesNotMatch(debug.message, /正式构建/);

  // 没有标注（旧产物）时同样不冒认仪器。
  assert.doesNotMatch(analyze(sample({})).message, /正式构建/);
});

test("读方按同一份最小形状提示漂移，但只提示、不改结论", () => {
  const thin = { key: "terminal:a:1", channel: "browser", delivered: true }; // 少了 background
  const verdict = analyze([
    stored(DIAGNOSTIC_EVENTS.EDGE, VALID[DIAGNOSTIC_EVENTS.EDGE]),
    stored(DIAGNOSTIC_EVENTS.DELIVER, thin)
  ]);
  assert.equal(verdict.label, "UNCONFIRMED");
  assert.ok(verdict.report.some((line) => /SHAPE-WARN: client:deliver/.test(line) && /缺少 background/.test(line)));

  // 与契约一致的样本不该报漂移（阳性对照：提示不是永真）。
  const clean = analyze([
    stored(DIAGNOSTIC_EVENTS.EDGE, VALID[DIAGNOSTIC_EVENTS.EDGE]),
    stored(DIAGNOSTIC_EVENTS.DELIVER, VALID[DIAGNOSTIC_EVENTS.DELIVER]),
    stored(DIAGNOSTIC_EVENTS.PLATFORM, VALID[DIAGNOSTIC_EVENTS.PLATFORM])
  ]);
  assert.equal(clean.report.some((line) => /SHAPE-WARN/.test(line)), false);
});
