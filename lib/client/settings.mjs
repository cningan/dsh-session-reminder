/**
 * 设置区：插件配置页 section 的内容（React 组件 + 样式表 + locale 绑定接线）。
 *
 * 它只依赖注入进来的协作者，不读装配层的私有变量、也不自己去取框架：
 *   - `model`      投递能力状态、请求权限、设置页自检（公开面在两种构建里一致）
 *   - `t`          官方 locale 绑定（字典与绑定接线在本 module：`registerSettingsLocale`）
 *   - `debugTools` 调试部分（诊断文本块 + 诊断工具行），**仅调试构建**注入；为空时
 *                  设置区只留两个空位，元素树形状与调试构建一致
 *
 * 调试能力由 `client/debug-tools` 拥有并经 `renderExtras(...)` 交出，本 module 不认识
 * 探针与测试模式本身——正式产物因此不含任何调试代码（见 ADR-0002）。
 */

import { dictionaries } from "../core/text.mjs";

/** 官方 locale 命名空间：字典注册与绑定的键。 */
export const LOCALE_NAMESPACE = "dsh-session-status-notifications";

/**
 * 样式表标记：安装与替换时的身份。只按它查找/替换，不误伤别的插件样式。
 */
export const SETTINGS_STYLE_TAG = "@cningan/dsh-session-status/system-notifications.css";

export const SETTINGS_CSS = `
      .dshss-settings {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 0;
        color: var(--dsw-alias-label-primary, #202124);
        font-family: var(--dsw-font-family, inherit);
      }
      .dshss-settings-row {
        box-sizing: border-box;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      .dshss-settings-copy {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .dshss-settings-title {
        font-size: 13px;
        line-height: 18px;
        font-weight: 600;
      }
      .dshss-settings-description {
        max-width: 560px;
        color: var(--dsw-alias-label-secondary, #5f6368);
        font-size: 12px;
        line-height: 17px;
      }
      .dshss-settings-diagnostics {
        margin-top: 4px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        font-size: 11px;
        line-height: 16px;
        font-variant-numeric: tabular-nums;
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .dshss-settings-tools {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .dshss-settings-status {
        flex: none;
        max-width: 300px;
        color: var(--dsw-alias-label-tertiary, #8a8f98);
        font-size: 12px;
        line-height: 17px;
        text-align: right;
      }
      .dshss-settings-button {
        flex: none;
        min-height: 30px;
        padding: 5px 10px;
        border: 1px solid var(--dsw-alias-border-primary, rgba(0, 0, 0, .14));
        border-radius: 7px;
        background: var(--dsw-alias-bg-secondary, rgba(0, 0, 0, .04));
        color: inherit;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
      }
      .dshss-settings-button:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .08));
      }
      .dshss-settings-button:disabled {
        cursor: default;
        opacity: .6;
      }
      .dshss-settings-actions {
        flex: none;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        flex-wrap: wrap;
      }
      @media (max-width: 620px) {
        .dshss-settings-row {
          align-items: flex-start;
          flex-direction: column;
          gap: 8px;
        }
        .dshss-settings-status {
          max-width: none;
          text-align: left;
        }
        .dshss-settings-actions {
          justify-content: flex-start;
        }
      }
    `;

/**
 * locale 绑定接线：把 `core/text` 的字典注册给官方 locale 服务并绑定 `t`。
 * 语言跟随 DSH 界面设置——不读 `document.documentElement.lang` 或 `navigator.language`
 * 猜语言；注册经 `ctx.effect` 释放。返回的 `t` 同时供通知文案（投递层）与设置区使用。
 */
export function registerSettingsLocale(ctx, label) {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, dictionaries), label);
  return ctx.locale.bind(LOCALE_NAMESPACE);
}

/**
 * 安装样式表，返回卸载函数。同一个标记的旧样式先移除（重复 `apply` 不留孤儿）；
 * 没有 `document` 或没有 `head`（Node 直测/非浏览器环境）时是 no-op。
 */
export function installSettingsStyle(pluginId) {
  if (typeof document === "undefined" || document.head === null) return () => {};
  const old = document.querySelector(`style[data-plugin-css=${JSON.stringify(SETTINGS_STYLE_TAG)}]`);
  if (old !== null) old.remove();
  const style = document.createElement("style");
  style.dataset.plugin = pluginId;
  style.dataset.pluginCss = SETTINGS_STYLE_TAG;
  style.textContent = SETTINGS_CSS;
  document.head.appendChild(style);
  return () => {
    if (style.parentNode !== null) style.remove();
  };
}

/**
 * 造设置区组件。React 三件套由装配层注入（它已经 `loadModule("react")`），所以本 module
 * 不依赖框架加载器，也能在 Node 直测里用替身渲染（见 `test/settings.test.mjs`）。
 *
 * 组件的 props 就是 slot 注册时 `inject()` 交出的那些：`{ model, t, debugTools }`。
 */
export function createSettingsRow({ h, useEffect, useState }) {
  // 插件配置页（setting section）的内容区；标题由 slot 注册的 label 提供。
  return function NotificationSettingsRow({ model, t, debugTools }) {
    const [, rerender] = useState(0);
    const [requesting, setRequesting] = useState(false);
    const [testResult, setTestResult] = useState("");
    useEffect(() => model.subscribe(() => rerender((value) => value + 1)), [model]);
    useEffect(() => {
      if (testResult === "") return;
      const timer = setTimeout(() => setTestResult(""), 2600);
      return () => clearTimeout(timer);
    }, [testResult]);
    const snapshot = model.getSnapshot();
    const canTest = snapshot.notificationPermission === "native" || snapshot.notificationPermission === "granted";
    const testButton = canTest ? h("button", {
      className: "dshss-settings-button",
      type: "button",
      onClick: () => setTestResult(model.sendTestNotification() ? "sent" : "failed")
    }, testResult === "sent"
      ? t("testNotificationSent")
      : testResult === "failed" ? t("testNotificationFailed") : t("testNotification")) : null;
    let control;
    if (snapshot.notificationPermission === "native") {
      control = h("div", { className: "dshss-settings-actions" },
        h("span", { className: "dshss-settings-status" }, t("nativeBridgeDetected")),
        testButton
      );
    } else if (snapshot.notificationPermission === "default") {
      control = h("button", {
        className: "dshss-settings-button",
        type: "button",
        disabled: requesting,
        onClick: () => {
          setRequesting(true);
          Promise.resolve(model.requestPermission()).then(() => {}, () => {}).then(() => setRequesting(false));
        }
      }, t("enableNotifications"));
    } else if (snapshot.notificationPermission === "granted") {
      control = h("div", { className: "dshss-settings-actions" },
        h("span", { className: "dshss-settings-status" }, t("enabledNotifications")),
        testButton
      );
    } else if (snapshot.notificationPermission === "denied") {
      control = h("span", { className: "dshss-settings-status" }, t("notificationDenied"));
    } else {
      control = h("span", { className: "dshss-settings-status" }, t("notificationUnavailable"));
    }
    // 调试区（诊断文本块 + 诊断工具行）由注入的 debugTools 自己渲染：正式构建下没有
    // 注入方，这里只留两个空位——设置区的元素树形状在两种构建里一致。
    const extras = debugTools === null || debugTools === undefined
      ? [null, null]
      : debugTools.renderExtras({ snapshot, canTest, testResult, setTestResult });
    // 纵向布局：① 主行（描述 + 状态/自检）② 诊断块（全宽可换行）③ 诊断工具行。
    return h("div", { className: "dshss-settings" },
      h("div", { className: "dshss-settings-row" },
        h("div", { className: "dshss-settings-copy" },
          h("div", { className: "dshss-settings-description" }, t("notificationsDescription"))
        ),
        control
      ),
      ...extras
    );
  };
}
