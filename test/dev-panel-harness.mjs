/**
 * 直测替身：最小假 React（能跑 hooks 与重渲染）、假测试服务（`sessionStatusTest` 的替身）、
 * 假 locale 绑定与假 Cordis 上下文。
 *
 * 这里不模拟浏览器、不 import React：面板是「服务 → 元素树」的纯映射，注入替身即可覆盖
 * 三态开关、探针、诊断 4 行、订阅/退订这些行为（见 panel.spec.mjs / plugin.spec.mjs）。
 *
 * 假服务**照抄服务的契约语义**：`setForegroundOverride` 只认三态、其余按 `auto`，同一个值
 * 重复写不通知；`deliverAdHoc` 服从前台抑制（前台时返回 `false`，但同样写一条
 * `suppressed-foreground` 的诊断记录）并通知订阅者。替身与真实服务语义一致，测试才有意义。
 */
import { FOREGROUND_MODES } from "../lib/client/dev-panel/panel.mjs";
import { dictionaries } from "../lib/client/dev-panel/strings.mjs";

/** 三态之一里挑出合法值，其余一律 `auto`（与主插件 `foregroundModeOf` 同一口径）。 */
function resolveMode(mode) {
  return typeof mode === "string" && FOREGROUND_MODES.includes(mode) ? mode : "auto";
}

/**
 * 假测试服务。选项：
 *   - `page`       宿主页面事实（缺省 `{ visibility: "visible", focused: true, background: false }`）
 *   - `permission` 通知权限（缺省 `"granted"`）
 */
export function createFakeService(options = {}) {
  const hostPage = { visibility: "visible", focused: true, background: false, ...(options.page ?? {}) };
  const listeners = new Set();
  const calls = { setForegroundOverride: [], deliverAdHoc: [], deliverSample: [], setDevToolsEnabled: [], subscribe: 0, unsubscribe: 0 };
  let devToolsEnabled = options.devTools !== false;
  const diagnostics = { status: null, edge: null, deliver: null };
  let override = "auto";
  let sequence = 0;

  // 「宿主事实 + 覆盖」的一个值：覆盖只替换 `background` 这一位结论，证据原样保留。
  const effectivePage = () => (override === "auto" ? { ...hostPage } : { ...hostPage, background: override === "background" });
  const snapshot = () => ({
    notificationPermission: options.permission ?? "granted",
    diagnostics: { ...diagnostics },
    foregroundOverride: override,
    devTools: { enabled: devToolsEnabled },
    page: effectivePage()
  });
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  return {
    calls,
    setDiagnostics(partial) {
      Object.assign(diagnostics, partial);
      notify();
    },
    setForegroundOverride(mode) {
      calls.setForegroundOverride.push(mode);
      const resolved = resolveMode(mode);
      if (resolved !== override) {
        override = resolved;
        notify();
      }
      return override;
    },
    getSnapshot: snapshot,
    subscribe(listener) {
      calls.subscribe += 1;
      listeners.add(listener);
      return () => {
        calls.unsubscribe += 1;
        listeners.delete(listener);
      };
    },
    deliverAdHoc(kind) {
      const resolved = kind === "interrupted" ? "interrupted" : "test";
      calls.deliverAdHoc.push(resolved);
      const background = effectivePage().background;
      const delivered = background;
      sequence += 1;
      diagnostics.deliver = {
        key: `test-probe:${resolved}:${sequence}`,
        kind: resolved,
        channel: delivered ? "browser" : "suppressed-foreground",
        delivered,
        background,
        at: "00:00:00",
        activation: false,
        foregroundOverride: override
      };
      notify();
      return delivered;
    },
    deliverSample(reason) {
      calls.deliverSample.push(reason);
      const background = effectivePage().background;
      const delivered = background;
      sequence += 1;
      diagnostics.deliver = {
        key: `test-probe:sample:${reason}:${sequence}`,
        kind: reason === "completed" ? "completed" : "interrupted",
        reason,
        channel: delivered ? "browser" : "suppressed-foreground",
        delivered,
        background,
        at: "00:00:00",
        activation: false,
        foregroundOverride: override
      };
      notify();
      return delivered;
    },
    setDevToolsEnabled(enabled) {
      calls.setDevToolsEnabled.push(enabled);
      devToolsEnabled = enabled === true;
      if (!devToolsEnabled) override = "auto";
      notify();
      return devToolsEnabled;
    },
    listenerCount: () => listeners.size
  };
}

/** 官方 locale 绑定的替身：`{name}` 插值，缺键时回落到键名本身（漏译会在测试里暴露）。 */
export function createTranslator(lang = "zh") {
  const table = dictionaries[lang] ?? dictionaries.zh;
  return (key, params) => {
    const template = typeof table[key] === "string" ? table[key] : key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

/**
 * 最小 React hooks 运行时：
 *   - `useState` 的 setter 触发一次重渲染（值没变则不渲染，与 React 的 bail-out 同效）；
 *   - `useEffect` 按依赖数组决定是否重跑，重跑前先跑上一次的清理；`unmount()` 跑最后一次清理。
 * 元素形状是 `{ type, props: { ...props, children: [...] } }`（与仓库其它直测一致）。
 */
export function createReactRuntime() {
  const hooks = [];
  let index = 0;
  let rendering = false;
  let pending = 0;
  let tree;

  const render = () => {
    let guard = 0;
    do {
      pending = 0;
      rendering = true;
      index = 0;
      tree = current();
      rendering = false;
      guard += 1;
    } while (pending > 0 && guard < 32);
  };

  const react = {
    h: (type, elementProps, ...children) => ({ type, props: { ...elementProps, children } }),
    useState(initial) {
      const slot = index++;
      const cell = hooks[slot];
      if (cell?.kind !== "state") {
        hooks[slot] = { kind: "state", value: typeof initial === "function" ? initial() : initial };
      }
      const current = hooks[slot];
      return [current.value, (next) => {
        const value = typeof next === "function" ? next(current.value) : next;
        if (Object.is(value, current.value)) return;
        current.value = value;
        if (rendering) pending += 1;
        else render();
      }];
    },
    useEffect(effect, deps) {
      const slot = index++;
      const previous = hooks[slot]?.kind === "effect" ? hooks[slot] : undefined;
      const changed = previous === undefined
        || deps === undefined
        || previous.deps === undefined
        || deps.length !== previous.deps.length
        || deps.some((dep, position) => !Object.is(dep, previous.deps[position]));
      if (!changed) return;
      if (typeof previous?.cleanup === "function") previous.cleanup();
      const cell = { kind: "effect", deps, cleanup: null };
      hooks[slot] = cell;
      const cleanup = effect();
      cell.cleanup = typeof cleanup === "function" ? cleanup : null;
    }
  };
  react.createElement = react.h;

  let current;
  return {
    react,
    /**
     * 首渲染一个**已经造好**的组件（它的 hooks 必须来自本 runtime 的 `react`，
     * 否则重渲染会找不到渲染入口）。bundle 直测就用它渲染 bundle 内部造的面板组件。
     */
    startComponent(component, props = {}) {
      current = () => component(props);
      render();
      return this;
    },
    /** 首渲染：`factory(react)` 当场造出组件，`props` 是它的 props。 */
    start(factory, props = {}) {
      return this.startComponent(factory(react), props);
    },
    /** 当前元素树。 */
    tree: () => tree,
    /** 全部叶子文本（按渲染顺序拼接）。 */
    text: () => collectText(tree).join(""),
    /** 收集所有满足谓词的元素节点。 */
    findAll: (predicate) => findAll(tree, predicate),
    /** 点第一个满足谓词的元素的 `onClick`（找不到就抛，避免静默通过）。 */
    click(predicate) {
      const node = findAll(tree, predicate)[0];
      if (node === undefined) throw new Error("click: no element matched the predicate");
      if (typeof node.props.onClick !== "function") throw new Error("click: matched element has no onClick");
      node.props.onClick();
      return node;
    },
    /** 按属性点名点按钮（`data-mode` / `data-probe`）。 */
    clickAttr(name, value) {
      return this.click((node) => node.props?.[name] === value);
    },
    /** 卸载：跑每个 hook 的最后一次清理（订阅退订就在这里发生）。 */
    unmount() {
      for (const cell of [...hooks].reverse()) {
        if (typeof cell?.cleanup === "function") cell.cleanup();
      }
    }
  };
}

/** 便捷入口：`mountWith((react) => createDebugPanel(react), props)`。 */
export function mountWith(factory, props = {}) {
  return createReactRuntime().start(factory, props);
}

function findAll(node, predicate, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (predicate(node)) out.push(node);
  findAll(node.props?.children, predicate, out);
  return out;
}

/** 元素树的叶子文本（字符串/数字节点按顺序收集）。 */
export function collectText(node, out = []) {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  collectText(node.props?.children, out);
  return out;
}

/** 某个元素子树的文本。 */
export function textOf(node) {
  return collectText(node).join("");
}

/**
 * 假 Cordis 上下文（只为把 `apply` 跑起来）：记录 locale 注册、effect 释放、slot 注册。
 * `lang` 决定 `bind` 返回的翻译器语言，用来验证「语言跟随 DSH 界面设置」这条接线。
 */
export function createFakeContext({ service, lang = "zh" } = {}) {
  const registered = { namespace: null, tables: null, effects: 0, disposers: [], slotName: null, slot: null };
  const ctx = {
    sessionStatusTest: service,
    locale: {
      register(namespace, tables) {
        registered.namespace = namespace;
        registered.tables = tables;
        return () => {};
      },
      bind() {
        return createTranslator(lang);
      }
    },
    effect(effect) {
      registered.effects += 1;
      const dispose = effect();
      if (typeof dispose === "function") registered.disposers.push(dispose);
      return typeof dispose === "function" ? dispose : () => {};
    },
    slots: {
      inject(name, callback) {
        registered.slotName = name;
        callback();
        return () => {};
      },
      register(meta, render) {
        registered.slot = { meta, render };
        return () => {};
      }
    }
  };
  return { ctx, registered };
}
