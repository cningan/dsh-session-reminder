/**
 * 设置区直测（`lib/client/settings.mjs`）：不模拟浏览器，只注入替身——
 * 假 React 三件套（`h`/`useState`/`useEffect`）、假 `model`、假 locale、可选的真 debugTools
 * 配假连接口。
 *
 * 断言四件事：
 *   1. **正式构建口径**（`debugTools` 为空）：设置区只留两个空位，元素树里没有任何
 *      诊断块/工具行/探针文案——调试 UI 不是「隐藏」，而是根本没渲染；
 *   2. **调试构建口径**（注入 debugTools）：诊断块与探针按钮都在，点击探针经注入的
 *      连接口投递（探针可达）；
 *   3. 设置行状态机：自检按钮按结果给出提示、请求权限按钮的忙碌态复位、权限分支的控件；
 *   4. locale 绑定接线与样式表装载（字典来自 `core/text`，CSS 按标记安装/卸载）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { dictionaries } from "../lib/core/text.mjs";
import { createDebugTools } from "../lib/client/debug-tools.mjs";
import {
  LOCALE_NAMESPACE,
  SETTINGS_CSS,
  SETTINGS_STYLE_TAG,
  createSettingsRow,
  installSettingsStyle,
  registerSettingsLocale
} from "../lib/client/settings.mjs";

/**
 * 假 React：`h` 造普通对象；`useState` 的状态存在闭包里（重渲染时复用，所以能直测
 * 设置行状态机）；`useEffect` 只占位不执行副作用（订阅与 2600ms 定时器是浏览器侧的事）。
 */
function createReactDouble() {
  const states = [];
  let cursor = 0;
  return {
    h: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const index = cursor++;
      if (states.length <= index) states[index] = initial;
      return [states[index], (next) => {
        states[index] = typeof next === "function" ? next(states[index]) : next;
      }];
    },
    useEffect() {
      cursor += 1;
    },
    beginRender() {
      cursor = 0;
    }
  };
}

function createModel(overrides = {}) {
  const snapshot = {
    notificationPermission: "granted",
    diagnostics: {},
    testMode: false,
    ...overrides.snapshot
  };
  const calls = { subscribe: 0, test: 0, permission: 0 };
  const model = {
    getSnapshot: () => snapshot,
    subscribe: () => {
      calls.subscribe += 1;
      return () => {};
    },
    sendTestNotification: () => {
      calls.test += 1;
      return overrides.testDelivered !== false;
    },
    requestPermission: async () => {
      calls.permission += 1;
      return "granted";
    },
    snapshot,
    calls
  };
  return model;
}

/** 造一个可渲染的设置区：返回 render(props 覆盖) 与假 React（状态跨重渲染保留）。 */
function createRow() {
  const react = createReactDouble();
  const Row = createSettingsRow({ h: react.h, useEffect: react.useEffect, useState: react.useState });
  const render = (props) => {
    react.beginRender();
    return Row(props);
  };
  return { react, Row, render };
}

const t = (key) => `t:${key}`;

function textOf(node) {
  if (node === null || node === undefined) return [];
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap((child) => textOf(child));
  const children = node.props?.children;
  if (!Array.isArray(children)) return [];
  return children.flatMap((child) => textOf(child));
}

/** 假 `h` 的 children 永远是数组；按钮文案取第一个子节点。 */
function labelOf(node) {
  const children = node.props?.children;
  return Array.isArray(children) ? children[0] : children;
}

function classesOf(node, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (typeof node.props?.className === "string") out.push(node.props.className);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const child of children) classesOf(child, out);
  return out;
}

function buttonsOf(node, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (node.type === "button") out.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const child of children) buttonsOf(child, out);
  return out;
}

test("正式构建口径：debugTools 为空时设置区不渲染任何调试 UI（只留两个空位）", () => {
  const { render } = createRow();
  const tree = render({ model: createModel(), t, debugTools: null });

  assert.equal(tree.props.className, "dshss-settings");
  const [row, diagnostics, tools] = tree.props.children;
  assert.equal(row.props.className, "dshss-settings-row");
  assert.equal(diagnostics, null);
  assert.equal(tools, null);

  const classes = classesOf(tree);
  assert.ok(!classes.includes("dshss-settings-diagnostics"));
  assert.ok(!classes.includes("dshss-settings-tools"));
  const text = textOf(tree).join(" | ");
  assert.doesNotMatch(text, /诊断|探针|测试模式/);
  // 常规内容（描述 + 自检）照旧在。
  assert.match(text, /t:notificationsDescription/);
  assert.match(text, /t:testNotification/);

  // `undefined` 与 `null` 同口径（slot 注册少给一个键也不能崩或漏调试 UI）。
  const withoutKey = render({ model: createModel(), t });
  assert.equal(withoutKey.props.children[1], null);
  assert.equal(withoutKey.props.children[2], null);
});

test("调试构建口径：注入 debugTools 时诊断块与探针按钮都在，点击探针经连接口投递", () => {
  const delivered = [];
  const link = { testMode: false, deliverAdHoc: (notice) => delivered.push(notice), notify() {} };
  const debugTools = createDebugTools({ link, t, h: (type, props, ...children) => ({ type, props: { ...props, children } }), setTimeout: () => 0 });
  const { render } = createRow();
  const tree = render({ model: createModel(), t, debugTools });

  const classes = classesOf(tree);
  assert.ok(classes.includes("dshss-settings-diagnostics"));
  assert.ok(classes.includes("dshss-settings-tools"));

  const labels = buttonsOf(tree).map((button) => labelOf(button));
  // 自检 + 测试模式开关 + 两个探针 + 连发探针
  assert.deepEqual(labels, [
    "t:testNotification",
    "t:testMode",
    "t:probeNotification",
    "t:probeInterrupted",
    "t:probeBurst"
  ]);

  const buttons = buttonsOf(tree);
  buttons[2].props.onClick();
  assert.deepEqual(delivered, [{
    keyPrefix: "test-probe",
    kind: "test",
    title: "t:testNotificationTitle",
    message: "t:testNotificationMessage"
  }]);

  // 探针点击把设置行的提示状态改成「探针已投递」，重渲染后按钮文案跟着变。
  const afterProbe = render({ model: createModel(), t, debugTools });
  assert.equal(labelOf(buttonsOf(afterProbe)[2]), "t:probeFired");
});

test("设置行状态机：自检按钮按投递结果给提示，请求权限按钮的忙碌态会复位", async () => {
  const { render } = createRow();
  const model = createModel();
  let tree = render({ model, t, debugTools: null });

  buttonsOf(tree)[0].props.onClick();
  assert.equal(model.calls.test, 1);
  tree = render({ model, t, debugTools: null });
  assert.equal(labelOf(buttonsOf(tree)[0]), "t:testNotificationSent");

  const failing = createModel({ testDelivered: false });
  const second = createRow();
  let failingTree = second.render({ model: failing, t, debugTools: null });
  buttonsOf(failingTree)[0].props.onClick();
  failingTree = second.render({ model: failing, t, debugTools: null });
  assert.equal(labelOf(buttonsOf(failingTree)[0]), "t:testNotificationFailed");

  // 权限还没给：唯一的控件是「启用提醒」，点击期间 disabled，结束后复位。
  const pending = createModel({ snapshot: { notificationPermission: "default" } });
  const third = createRow();
  let pendingTree = third.render({ model: pending, t, debugTools: null });
  const enable = buttonsOf(pendingTree)[0];
  assert.equal(labelOf(enable), "t:enableNotifications");
  assert.equal(enable.props.disabled, false);
  enable.props.onClick();
  pendingTree = third.render({ model: pending, t, debugTools: null });
  assert.equal(buttonsOf(pendingTree)[0].props.disabled, true);
  await new Promise((resolve) => setImmediate(resolve));
  pendingTree = third.render({ model: pending, t, debugTools: null });
  assert.equal(pending.calls.permission, 1);
  assert.equal(buttonsOf(pendingTree)[0].props.disabled, false);
});

test("权限分支：每个通知能力状态都有自己的控件与文案", () => {
  const cases = [
    ["native", "t:nativeBridgeDetected"],
    ["granted", "t:enabledNotifications"],
    ["denied", "t:notificationDenied"],
    ["unsupported", "t:notificationUnavailable"]
  ];
  for (const [permission, expected] of cases) {
    const { render } = createRow();
    const tree = render({ model: createModel({ snapshot: { notificationPermission: permission } }), t, debugTools: null });
    assert.ok(textOf(tree).includes(expected), `${permission} 应显示 ${expected}`);
  }
});

test("locale 绑定接线：字典注册给官方 locale 服务，返回的 t 跟随界面语言", () => {
  const registered = [];
  const effects = [];
  let language = "zh";
  const service = {
    register(namespace, table) {
      registered.push({ namespace, table });
      return () => {};
    },
    bind() {
      return (key, params) => {
        const template = registered.at(-1).table[language]?.[key] ?? key;
        if (params === void 0) return template;
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
      };
    }
  };
  const ctx = {
    locale: service,
    effect(effect, label) {
      effects.push(label);
      return effect();
    }
  };

  const bound = registerSettingsLocale(ctx, "test: dictionaries");
  assert.equal(LOCALE_NAMESPACE, "dsh-session-status-notifications");
  assert.equal(registered[0].namespace, LOCALE_NAMESPACE);
  assert.equal(registered[0].table, dictionaries);
  assert.deepEqual(effects, ["test: dictionaries"]);
  assert.equal(bound("notifications"), "会话提醒");
  language = "en";
  assert.equal(bound("notifications"), "Session reminders");
});

test("样式表按标记安装、替换旧的、卸载时移除，且 CSS 里含设置区与诊断块的类", () => {
  const created = [];
  const head = {
    children: [],
    appendChild(node) {
      node.parentNode = head;
      head.children.push(node);
    }
  };
  const existing = {
    removed: false,
    remove() {
      this.removed = true;
    }
  };
  const previousDocument = globalThis.document;
  globalThis.document = {
    head,
    querySelector: (selector) => {
      assert.match(selector, /system-notifications\.css/);
      return existing;
    },
    createElement(tag) {
      const element = {
        tagName: tag,
        dataset: {},
        textContent: "",
        parentNode: null,
        remove() {
          const index = head.children.indexOf(element);
          if (index >= 0) head.children.splice(index, 1);
          element.parentNode = null;
        }
      };
      created.push(element);
      return element;
    }
  };
  try {
    const dispose = installSettingsStyle("@cningan/dsh-session-status");
    assert.equal(existing.removed, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].dataset.plugin, "@cningan/dsh-session-status");
    assert.equal(created[0].dataset.pluginCss, SETTINGS_STYLE_TAG);
    assert.equal(created[0].textContent, SETTINGS_CSS);
    assert.equal(head.children.length, 1);
    for (const className of [".dshss-settings", ".dshss-settings-diagnostics", ".dshss-settings-tools", ".dshss-settings-button"]) {
      assert.ok(SETTINGS_CSS.includes(className), `CSS 应包含 ${className}`);
    }
    dispose();
    assert.equal(head.children.length, 0);
  } finally {
    globalThis.document = previousDocument;
  }
});
