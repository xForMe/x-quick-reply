import { DEFAULTS, DEFAULT_REPLY_PROMPT } from "./settings.js";

document.addEventListener("DOMContentLoaded", async () => {
  const status = document.getElementById("status");
  const save = document.getElementById("save");
  const report = (text, error = false) => { status.textContent = text; status.classList.toggle("error", error); };
  try {
    const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
    for (const key of ["gatewayUrl", "tone", "candidateCount", "replyPrompt", "replyExamples"]) document.getElementById(key).value = settings[key];
    document.getElementById("autoLikeAfterReply").checked = settings.autoLikeAfterReply === true;
  } catch (error) {
    save.disabled = true;
    report(`读取设置失败：${error.message}`, true);
    return;
  }
  document.getElementById("resetPrompt").addEventListener("click", () => {
    document.getElementById("replyPrompt").value = DEFAULT_REPLY_PROMPT;
    report("已恢复默认提示词，请点击保存。");
  });
  save.addEventListener("click", async () => {
    const gatewayUrl = document.getElementById("gatewayUrl").value.trim();
    const replyPrompt = document.getElementById("replyPrompt").value.trim();
    const replyExamples = document.getElementById("replyExamples").value.trim();
    const autoLikeAfterReply = document.getElementById("autoLikeAfterReply").checked;
    const candidateCount = Number(document.getElementById("candidateCount").value);
    const tone = document.getElementById("tone").value;
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(gatewayUrl)) return report("仅支持 http://localhost 或 http://127.0.0.1", true);
    if (!Number.isInteger(candidateCount) || candidateCount < 2 || candidateCount > 5) return report("候选数量必须是 2–5 的整数", true);
    if (!["natural", "concise", "polite", "professional"].includes(tone)) return report("默认语气无效", true);
    if (!replyPrompt || replyPrompt.length > 3000) return report("整体回复提示词必须为 1–3000 字符", true);
    if (replyExamples.length > 3000) return report("我的回复示例不能超过 3000 字符", true);
    save.disabled = true;
    try {
      await chrome.storage.local.set({ gatewayUrl, tone, candidateCount, replyPrompt, replyExamples, autoLikeAfterReply });
      report("已保存，下次生成生效。");
    } catch (error) { report(`保存设置失败：${error.message}`, true); }
    finally { save.disabled = false; }
  });
});
