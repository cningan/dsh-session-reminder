/**
 * 设置区直测（`lib/client/settings.mjs`）：不模拟浏览器，只注入替身——
 * 假 React 三件套（`h`/`useState`/`useEffect`）、假 `model`、假 locale。
 *
 * 断言四件事：
 *   1. **设置区只有正常使用者那一行**：说明文字 + 权限/渠道状态 + 「发送测试提醒」；
 *      诊断块、探针按钮与测试模式开关都已随测试能力移出主插件（ADR-0003），元素树里
 *      既没有它们的类名，也没有它们的文案；
 *   2. 设置行状态机：自检按钮按结果给出提示、请求权限按钮的忙碌态复位、权限分支的控件；
 *   3. locale 绑定接线与样式表装载（字典来自 `core/text`，CSS 按标记安装/卸载）；
 *   4. 样式表里没有任何调试 UI 的类（它们属于 `dev/` 调试插件自己的样式）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { dictionaries } from "../lib/core/text.mjs";
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
    diagnostics: { status: null, edge: null, deliver: null },
    foregroundOverride: "auto",
    page: { visibility: "visible", focused: true, background: false },
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

/** 造一个可渲染的设置区：返回 render(props) 与假 React（状态跨重渲染保留）。 */
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

test("设置区只有正常使用者那一行：说明 + 状态/自检，没有调试 UI 的痕迹", () => {
  const { render } = createRow();
  const tree = render({ model: createModel(), t });

  assert.equal(tree.props.className, "dshss-settings");
  // 只有一个子节点：那一行（说明 + 状态/自检），没有诊断块与工具行的位置。
  assert.equal(tree.props.children.length, 1);
  const [row] = tree.props.children;
  assert.equal(row.props.className, "dshss-settings-row");
  const [copy, control] = row.props.children;
  assert.equal(copy.props.className, "dshss-settings-copy");
  assert.ok(control !== null && control !== undefined);

  const classes = classesOf(tree);
  for (const gone of ["dshss-settings-diagnostics", "dshss-settings-tools"]) {
    assert.ok(!classes.includes(gone), `调试 UI 的类 ${gone} 不该出现`);
  }
  const text = textOf(tree).join(" | ");
  assert.doesNotMatch(text, /诊断|探针|测试模式/);
  // 常规内容（描述 + 自检）照旧在。
  assert.match(text, /t:notificationsDescription/);
  assert.match(text, /t:testNotification/);
  // 这一行就这几件：说明文字 + 渠道状态 + 自检按钮（顺序即渲染顺序）。
  assert.deepEqual(textOf(tree), ["t:notificationsDescription", "t:enabledNotifications", "t:testNotification"]);
  assert.deepEqual(buttonsOf(tree).map((button) => labelOf(button)), ["t:testNotification"]);
});

test("设置行状态机：自检按钮按投递结果给提示，请求权限按钮的忙碌态会复位", async () => {
  const { render } = createRow();
  const model = createModel();
  let tree = render({ model, t });

  const testButton = buttonsOf(tree).at(-1);
  testButton.props.onClick();
  assert.equal(model.calls.test, 1);
  tree = render({ model, t });
  assert.equal(labelOf(buttonsOf(tree).at(-1)), "t:testNotificationSent");

  const failing = createModel({ testDelivered: false });
  const second = createRow();
  let failingTree = second.render({ model: failing, t });
  buttonsOf(failingTree)[0].props.onClick();
  failingTree = second.render({ model: failing, t });
  assert.equal(labelOf(buttonsOf(failingTree)[0]), "t:testNotificationFailed");

  // 权限还没给：唯一的控件是「启用提醒」，点击期间 disabled，结束后复位。
  const pending = createModel({ snapshot: { notificationPermission: "default" } });
  const third = createRow();
  let pendingTree = third.render({ model: pending, t });
  const enable = buttonsOf(pendingTree)[0];
  assert.equal(labelOf(enable), "t:enableNotifications");
  assert.equal(enable.props.disabled, false);
  enable.props.onClick();
  pendingTree = third.render({ model: pending, t });
  assert.equal(buttonsOf(pendingTree)[0].props.disabled, true);
  await new Promise((resolve) => setImmediate(resolve));
  pendingTree = third.render({ model: pending, t });
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
    const tree = render({ model: createModel({ snapshot: { notificationPermission: permission } }), t });
    assert.ok(textOf(tree).includes(expected), `${permission} 应显示 ${expected}`);
  }
  // native 与 granted 才有「发送测试提醒」；其余状态不给按钮。
  for (const [permission, hasTest] of [["native", true], ["granted", true], ["default", false], ["denied", false], ["unsupported", false]]) {
    const { render } = createRow();
    const labels = buttonsOf(render({ model: createModel({ snapshot: { notificationPermission: permission } }), t }))
      .map((button) => labelOf(button));
    assert.equal(labels.includes("t:testNotification"), hasTest, `${permission} 的测试按钮存在性`);
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

test("样式表按标记安装、替换旧的、卸载时移除；CSS 里没有调试 UI 的类", () => {
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
    for (const className of [".dshss-settings", ".dshss-settings-row", ".dshss-settings-description", ".dshss-settings-status", ".dshss-settings-button"]) {
      assert.ok(SETTINGS_CSS.includes(className), `CSS 应包含 ${className}`);
    }
    // 调试 UI 的样式随调试能力一起移出：它们属于 dev/ 调试插件。
    for (const gone of [".dshss-settings-diagnostics", ".dshss-settings-tools"]) {
      assert.ok(!SETTINGS_CSS.includes(gone), `CSS 不该包含 ${gone}`);
    }
    dispose();
    assert.equal(head.children.length, 0);
  } finally {
    globalThis.document = previousDocument;
  }
});
