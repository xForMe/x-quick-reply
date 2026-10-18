(() => {
  if (!globalThis.React || !globalThis.ReactDOM) throw new Error("React runtime 未加载，无法初始化插件弹窗");
  const h = React.createElement;

  function Popup() {
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState("生成后只填草稿，由你检查并发送。");
    const [error, setError] = React.useState(false);

    async function openPanel() {
      if (busy) return;
      setBusy(true);
      setError(false);
      let stage = "读取当前标签页";
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !/^https:\/\/(x\.com|twitter\.com)\//.test(tab.url || "")) throw new Error("请先打开 X 的帖子回复弹窗或具体私信会话");
        // 每次用户明确点击都重新注入当前版本，避免扩展重载后复用失效脚本。
        stage = "注入页面脚本";
        const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["src/vendor/react.production.min.js", "src/vendor/react-dom.production.min.js", "src/content.js"], world: "ISOLATED" });
        const boot = results.find(result => result.frameId === 0)?.result;
        if (!boot?.ok) throw new Error(boot?.error || "页面脚本未返回初始化结果");
        if (boot.version !== "0.4.0") throw new Error(`页面脚本版本不符：${boot.version}`);
        stage = "加载面板样式";
        await chrome.scripting.insertCSS({ target: { tabId: tab.id, frameIds: [0] }, files: ["src/content.css"] });
        stage = "连接页面脚本";
        const response = await chrome.tabs.sendMessage(tab.id, { type: "OPEN_QUICK_REPLY" }, { frameId: 0 });
        if (!response?.ok) throw new Error(response?.error || "打开面板失败");
        window.close();
      } catch (error) {
        setError(true);
        const message = /^Extension context invalidated\.?$/i.test(error?.message || "")
          ? "插件连接已失效。请刷新 X 页面，再重新打开回复弹窗和插件面板。" : error.message;
        setStatus(`${stage}失败：${message}`);
      } finally {
        setBusy(false);
      }
    }

    return h("main", null,
      h("strong", null, "X 快速回复 · 0.4.0"),
      h("p", null, "先点击帖子的回复按钮，打开回复弹窗；也可打开具体私信会话。"),
      h("button", { id: "open", type: "button", disabled: busy, onClick: openPanel }, busy ? "打开中…" : "打开快速回复面板"),
      h("button", { id: "settings", type: "button", onClick: () => chrome.runtime.openOptionsPage() }, "扩展设置"),
      h("p", { id: "status", role: "status", className: error ? "error" : "" }, status)
    );
  }

  ReactDOM.render(h(Popup), document.getElementById("app"));
})();
