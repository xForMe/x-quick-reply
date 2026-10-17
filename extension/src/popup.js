document.getElementById("open").addEventListener("click", async () => {
  const status = document.getElementById("status");
  const button = document.getElementById("open");
  button.disabled = true;
  let stage = "读取当前标签页";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/(x\.com|twitter\.com)\//.test(tab.url || "")) throw new Error("请先打开 X 的帖子回复弹窗或具体私信会话");
    // Initialize on every deliberate click, before messaging. No send-fail/retry path.
    stage = "注入页面脚本";
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["src/content.js"], world: "ISOLATED" });
    const boot = results.find(result => result.frameId === 0)?.result;
    if (!boot?.ok) throw new Error(boot?.error || "页面脚本未返回初始化结果");
    if (boot.version !== "0.3.0") throw new Error(`页面脚本版本不符：${boot.version}`);
    stage = "加载面板样式";
    await chrome.scripting.insertCSS({ target: { tabId: tab.id, frameIds: [0] }, files: ["src/content.css"] });
    stage = "连接页面脚本";
    const response = await chrome.tabs.sendMessage(tab.id, { type: "OPEN_QUICK_REPLY" }, { frameId: 0 });
    if (!response?.ok) throw new Error(response?.error || "打开面板失败");
    window.close();
  } catch (error) {
    status.classList.add("error");
    const message = /^Extension context invalidated\.?$/i.test(error?.message || "")
      ? "插件连接已失效。请刷新 X 页面，再重新打开回复弹窗和插件面板。" : error.message;
    status.textContent = `${stage}失败：${message}`;
  }
  finally { button.disabled = false; }
});
document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
