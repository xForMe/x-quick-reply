import { DEFAULTS } from "./settings.js";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "GENERATE_REPLIES") return undefined;
  authorizeSender(sender, message.context?.kind).then(source => generateReplies(message.context, source)).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: typeof error?.message === "string" ? error.message : "生成失败" });
  });
  return true;
});

async function authorizeSender(sender, kind) {
  if (sender.id !== chrome.runtime.id) throw new Error("调用来源校验失败：请求不是来自本插件");
  if (!Number.isInteger(sender.tab?.id) || sender.tab.id < 0 || sender.frameId !== 0) throw new Error("调用来源校验失败：仅允许 X 顶层标签页调用");
  if (!isXUrl(sender.url)) throw new Error("调用来源校验失败：发送方不是 X 页面");
  if (sender.documentLifecycle && sender.documentLifecycle !== "active") throw new Error("调用来源校验失败：发送方页面已不处于活动状态");
  // MessageSender identifies the source document. SPA navigation can change
  // the current route without replacing that document. Query Chrome for the
  // current tab instead of treating the document's old route as current.
  const tab = await readSourceTab(sender.tab.id);
  if (!isConversationUrl(tab.url, kind, sender.url)) throw new Error("当前 X 标签页不在帖子回复页面或具体私信会话，请重新打开回复弹窗");
  if (new URL(tab.url).origin !== new URL(sender.url).origin) throw new Error("调用来源校验失败：标签页站点已变化，请刷新 X 页面");
  return { tabId: sender.tab.id, url: tab.url };
}

async function readSourceTab(tabId) {
  try { return await chrome.tabs.get(tabId); }
  catch (error) { throw new Error(`读取当前 X 标签页失败：${error.message}`); }
}

async function generateReplies(context, source) {
  if (!context || !Array.isArray(context.messages) || !context.messages.length) throw new Error("当前会话内容无效");
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  if (typeof settings.autoLikeAfterReply !== "boolean") throw new Error("自动点赞开关设置无效，请重新保存扩展设置");
  if (typeof settings.oneClickReply !== "boolean") throw new Error("一键回复开关设置无效，请重新保存扩展设置");
  if (!Number.isInteger(settings.oneClickCountdownSeconds) || settings.oneClickCountdownSeconds < 3 || settings.oneClickCountdownSeconds > 60) {
    throw new Error("一键回复倒计时设置无效（需 3–60 秒整数），请重新保存扩展设置");
  }
  if (typeof settings.replyPrompt !== "string" || !settings.replyPrompt.trim() || settings.replyPrompt.length > 3000) throw new Error("请在扩展设置中填写整体回复提示词（1–3000 字符）");
  const request = {
    schemaVersion: "quick-reply.v2",
    kind: context.kind,
    messages: context.messages,
    language: "auto",
    tone: settings.tone,
    candidateCount: clampInt(settings.candidateCount, 2, 5),
    replyPrompt: settings.replyPrompt.trim(),
    replyExamples: typeof settings.replyExamples === "string" ? settings.replyExamples.trim() : ""
  };

  if (!settings.gatewayUrl.trim()) throw new Error("请在扩展设置中配置本地网关地址");
  if (!isAllowedGateway(settings.gatewayUrl)) throw new Error("MVP 只允许使用 localhost 或 127.0.0.1 网关");

  const base = settings.gatewayUrl.replace(/\/$/, "");
  const generated = await postJson(`${base}/v1/replies/generate`, request, settings.timeoutMs);
  if (generated?.schemaVersion !== "quick-reply.v2") throw new Error("生成接口协议版本无效，请重启新版网关并更新扩展");
  const candidates = validateCandidates(generated?.candidates);
  const currentTab = await readSourceTab(source.tabId);
  if (currentTab.url !== source.url) throw new Error("当前 X 页面已切换，已停止决策和回填，请重新生成");
  const decision = await postJson(`${base}/v1/replies/decide`, { ...request, candidates }, settings.timeoutMs);
  const validDecision = validateDecision(decision, candidates);
  return { ok: true, mode: "gateway", candidates, decision: validDecision, generation: generated.meta,
    autoLikeAfterReply: settings.autoLikeAfterReply, oneClickReply: settings.oneClickReply,
    oneClickCountdownSeconds: settings.oneClickCountdownSeconds };
}

async function postJson(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "X-Quick-Reply": "v1" }, body: JSON.stringify(body), signal: controller.signal, credentials: "omit", redirect: "error" });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error.slice(0, 300) : `网关请求失败（HTTP ${response.status}）`);
    return result;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("网关请求超时");
    throw error instanceof Error ? error : new Error("网关请求失败");
  } finally {
    clearTimeout(timer);
  }
}

function validateCandidates(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) throw new Error("生成接口返回的候选数量无效");
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item.id !== "string" || !/^c[1-5]$/.test(item.id) || seen.has(item.id) || typeof item.text !== "string" || !item.text.trim() || item.text.length > 1000) throw new Error("生成接口返回了非法候选");
    seen.add(item.id);
    return { id: item.id, text: item.text.trim() };
  });
}

function validateDecision(value, candidates) {
  if (!value || value.schemaVersion !== "quick-reply.v2" || value.model !== "decision-model-preview") throw new Error("decision 协议版本或模型无效");
  const rejected = value.reviewRequired === true && value.selectedId === null;
  if (!rejected && (value.reviewRequired !== false || !candidates.some((candidate) => candidate.id === value.selectedId))) throw new Error("decision 返回的候选 ID 无效");
  const confidence = value.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("decision 返回的置信度无效");
  const allowed = new Set([...candidates.map((candidate) => candidate.id), "__none__"]);
  const probabilities = value.probabilities;
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities) || Object.keys(probabilities).length !== allowed.size || Object.entries(probabilities).some(([id, probability]) => !allowed.has(id) || typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) || Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.02) throw new Error("decision 返回的概率分布无效");
  return { selectedId: value.selectedId, reviewRequired: rejected, confidence, probabilities, model: value.model, elapsedMs: value.elapsedMs };
}

function clampInt(value, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}

function isAllowedGateway(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1") && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isXUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && ["x.com", "twitter.com"].includes(url.hostname); }
  catch { return false; }
}

function isConversationUrl(value, kind, senderValue = value) {
  try {
    if (!isXUrl(value)) return false;
    const url = new URL(value);
    if (kind === "direct-message") return /^\/(i\/chat|messages)\/[^/]+/.test(url.pathname);
    if (kind === "public-reply") {
      if (url.pathname === "/compose/post" || /^\/[^/]+\/status\/\d+\/?$/.test(url.pathname)) return true;
      // A reply dialog opened from the home/feed surface can keep the tab URL
      // at /home. The content script still validates one visible target post
      // and one editor before sending this request.
      return isFeedPath(url.pathname) && isFeedPath(new URL(senderValue).pathname);
    }
    return false;
  } catch { return false; }
}

function isFeedPath(pathname) {
  return pathname === "/home" || pathname === "/explore" || pathname === "/notifications"
    || pathname === "/i/bookmarks" || pathname === "/search" || /^\/[^/]+$/.test(pathname);
}
