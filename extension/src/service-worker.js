import { DEFAULTS } from "./settings.js";

const POST_SCHEMA = "quick-post.v1";
const CACHE_KEY = "quickPost.cache.v1";
const CACHE_LIMIT = 30;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const kind = message?.type === "GENERATE_REPLIES" ? message.context?.kind : "original-post";
  if (!["GENERATE_REPLIES", "GENERATE_POST_BATCH", "LIST_POST_CACHE", "POST_CACHE_OP"].includes(message?.type)) return undefined;
  authorizeSender(sender, message.type === "GENERATE_REPLIES" ? kind : "original-post").then(async (source) => {
    switch (message.type) {
      case "GENERATE_REPLIES": return generateReplies(message.context, source);
      case "GENERATE_POST_BATCH": return generatePostBatch(source);
      case "LIST_POST_CACHE": return { ok: true, ...(await readCache()) };
      case "POST_CACHE_OP": return applyCacheOp(message);
    }
  }).then(sendResponse).catch((error) => {
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
  if (!isConversationUrl(tab.url, kind, sender.url)) throw new Error(kind === "original-post"
    ? "当前 X 标签页不在发帖页面或发帖弹窗，请打开 /compose/post 或发帖弹窗"
    : "当前 X 标签页不在帖子回复页面或具体私信会话，请重新打开回复弹窗");
  if (new URL(tab.url).origin !== new URL(sender.url).origin) throw new Error("调用来源校验失败：标签页站点已变化，请刷新 X 页面");
  return { tabId: sender.tab.id, url: tab.url };
}

async function readSourceTab(tabId) {
  try { return await chrome.tabs.get(tabId); }
  catch (error) { throw new Error(`读取当前 X 标签页失败：${error.message}`); }
}

async function generateReplies(context, source) {
  if (!context || !Array.isArray(context.messages) || !context.messages.length) throw new Error("当前会话内容无效");
  const settings = await loadSettings();
  if (typeof settings.autoLikeAfterReply !== "boolean") throw new Error("自动点赞开关设置无效，请重新保存扩展设置");
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

  const base = gatewayBase(settings);
  const generated = await postJson(`${base}/v1/replies/generate`, request, settings.timeoutMs);
  if (generated?.schemaVersion !== "quick-reply.v2") throw new Error("生成接口协议版本无效，请重启新版网关并更新扩展");
  const candidates = validateCandidates(generated?.candidates);
  await assertTabUnchanged(source);
  const decision = await postJson(`${base}/v1/replies/decide`, { ...request, candidates }, settings.timeoutMs);
  const validDecision = validateDecision(decision, candidates);
  return { ok: true, mode: "gateway", candidates, decision: validDecision, generation: generated.meta,
    autoLikeAfterReply: settings.autoLikeAfterReply };
}

// One button runs the whole quick-post batch: topics fetch -> decision ->
// post generation -> cache append. Any failing stage stops the chain and is
// reported with its stage; there is no retry, fallback source or mock output.
async function generatePostBatch(source) {
  const settings = await loadSettings();
  if (typeof settings.postPrompt !== "string" || !settings.postPrompt.trim() || settings.postPrompt.length > 3000) throw new Error("请在扩展设置中填写发帖提示词（1–3000 字符）");
  const base = gatewayBase(settings);
  const head = { schemaVersion: POST_SCHEMA, kind: "original-post" };

  const fetched = await postJson(`${base}/v1/posts/topics/fetch`, head, settings.timeoutMs);
  if (fetched?.schemaVersion !== POST_SCHEMA) throw new Error("话题接口协议版本无效，请重启新版网关并更新扩展");
  const topics = validateTopics(fetched?.topics);
  await assertTabUnchanged(source);

  const decision = await postJson(`${base}/v1/posts/topics/decide`, { ...head, topics }, settings.timeoutMs);
  const validDecision = validatePostDecision(decision, topics);
  if (validDecision.reviewRequired) {
    return { ok: true, rejected: true, topics, decision: validDecision, source: fetched.source, fetchedAt: fetched.fetchedAt };
  }
  const selectedTopic = topics.find((topic) => topic.id === validDecision.selectedId);
  await assertTabUnchanged(source);

  const generated = await postJson(`${base}/v1/posts/generate`, {
    ...head,
    selectedTopic: { id: selectedTopic.id, title: selectedTopic.title, summary: selectedTopic.summary },
    language: "auto",
    tone: settings.tone,
    postPrompt: settings.postPrompt.trim(),
    postExamples: typeof settings.postExamples === "string" ? settings.postExamples.trim() : ""
  }, settings.timeoutMs);
  if (generated?.schemaVersion !== POST_SCHEMA) throw new Error("帖文接口协议版本无效，请重启新版网关并更新扩展");
  const candidates = validatePostCandidates(generated?.candidates);

  let cache = null;
  let cacheError = null;
  let evicted = 0;
  try {
    const appended = await appendCache(candidates, selectedTopic);
    cache = appended.items;
    evicted = appended.evicted;
  } catch (error) {
    // The batch itself is real and usable this session, but it must never be
    // presented as cached. Report the storage stage and keep the failure visible.
    cacheError = typeof error?.message === "string" ? error.message : "缓存写入失败（阶段 cache.write）";
  }
  return { ok: true, rejected: false, topics, decision: validDecision, selectedTopic, candidates,
    generation: generated.meta, cache, cacheError, evicted, source: fetched.source, fetchedAt: fetched.fetchedAt };
}

async function loadSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

function gatewayBase(settings) {
  if (!settings.gatewayUrl.trim()) throw new Error("请在扩展设置中配置本地网关地址");
  if (!isAllowedGateway(settings.gatewayUrl)) throw new Error("MVP 只允许使用 localhost 或 127.0.0.1 网关");
  return settings.gatewayUrl.replace(/\/$/, "");
}

async function assertTabUnchanged(source) {
  const currentTab = await readSourceTab(source.tabId);
  if (currentTab.url !== source.url) throw new Error("当前 X 页面已切换，已停止后续生成或回填，请重新生成");
}

// ---- quick-post draft cache (chrome.storage.local) ----

function validateCacheItem(item) {
  if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id
    || typeof item.text !== "string" || !item.text.trim() || item.text.length > 280
    || !Array.isArray(item.checkNotes) || item.checkNotes.length > 5
    || item.checkNotes.some((note) => typeof note !== "string" || !note.trim() || note.length > 120)
    || !item.sourceTopic || typeof item.sourceTopic.id !== "string" || typeof item.sourceTopic.title !== "string"
    || typeof item.batchId !== "string" || !item.batchId
    || typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)
    || (item.usedAt !== undefined && item.usedAt !== null && (typeof item.usedAt !== "number" || !Number.isFinite(item.usedAt)))) {
    throw new Error("缓存数据结构无效（阶段 cache.read）");
  }
}

async function readCache() {
  let stored;
  try {
    stored = await chrome.storage.local.get(CACHE_KEY);
  } catch (error) {
    throw new Error(`缓存读取失败（阶段 cache.read）：${error?.message || "存储不可用"}`);
  }
  const value = stored[CACHE_KEY];
  if (value === undefined) return { items: [] };
  if (!value || typeof value !== "object" || !Array.isArray(value.items)) throw new Error("缓存数据结构无效（阶段 cache.read）");
  value.items.forEach(validateCacheItem);
  return { items: value.items };
}

async function writeCache(items) {
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: { items } });
  } catch (error) {
    throw new Error(`缓存写入失败（阶段 cache.write）：${error?.message || "存储不可用"}`);
  }
}

async function appendCache(candidates, selectedTopic) {
  const { items } = await readCache();
  const now = Date.now();
  const batchId = crypto.randomUUID();
  const added = candidates.map((candidate) => ({
    id: crypto.randomUUID(),
    text: candidate.text,
    checkNotes: candidate.checkNotes,
    sourceTopic: { id: selectedTopic.id, title: selectedTopic.title },
    batchId,
    createdAt: now
  }));
  let merged = [...items, ...added];
  let evicted = 0;
  // 2026-10-24 review: when over the limit, delete items already used first,
  // then the oldest ones. Eviction is visible in the response, never silent.
  while (merged.length > CACHE_LIMIT) {
    const used = merged.filter((item) => item.usedAt).sort((a, b) => a.usedAt - b.usedAt)[0];
    const oldest = [...merged].sort((a, b) => a.createdAt - b.createdAt)[0];
    const victim = used || oldest;
    merged = merged.filter((item) => item !== victim);
    evicted += 1;
  }
  await writeCache(merged);
  return { items: merged, evicted };
}

async function applyCacheOp(message) {
  const { items } = await readCache();
  const op = message?.op;
  const id = message?.id;
  let next = items;
  if (op === "clear") {
    next = [];
  } else if (op === "delete" || op === "mark" || op === "unmark") {
    if (typeof id !== "string" || !id) throw new Error("缓存操作缺少条目 ID（阶段 cache.write）");
    if (!items.some((item) => item.id === id)) throw new Error("缓存条目不存在（阶段 cache.write）");
    next = items.map((item) => {
      if (item.id !== id) return item;
      if (op === "mark") return { ...item, usedAt: Date.now() };
      if (op === "unmark") { const { usedAt, ...rest } = item; return rest; }
      return item;
    });
    if (op === "delete") next = items.filter((item) => item.id !== id);
  } else {
    throw new Error("未知缓存操作（阶段 cache.write）");
  }
  await writeCache(next);
  return { ok: true, items: next };
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

function validateTopics(value) {
  if (!Array.isArray(value) || !value.length || value.length > 5) throw new Error("话题接口返回的话题数量无效");
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item.id !== "string" || !item.id || seen.has(item.id)
      || typeof item.title !== "string" || !item.title.trim() || item.title.length > 300
      || typeof item.summary !== "string" || item.summary.length > 2000
      || !Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string" || tag.length > 40)
      || !Number.isInteger(item.repliesCount) || item.repliesCount < 0
      || !Number.isInteger(item.rank) || item.rank < 1) throw new Error("话题接口返回了非法话题条目");
    seen.add(item.id);
    return { id: item.id, rank: item.rank, title: item.title.trim(), summary: item.summary, tags: item.tags, repliesCount: item.repliesCount };
  });
}

function validatePostDecision(value, topics) {
  if (!value || value.schemaVersion !== POST_SCHEMA || value.model !== "decision-model-preview") throw new Error("decision 协议版本或模型无效");
  const rejected = value.reviewRequired === true && value.selectedId === null;
  if (!rejected && (value.reviewRequired !== false || !topics.some((topic) => topic.id === value.selectedId))) throw new Error("decision 返回的话题 ID 无效");
  const confidence = value.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("decision 返回的置信度无效");
  const allowed = new Set([...topics.map((topic) => topic.id), "__none__"]);
  const probabilities = value.probabilities;
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities) || Object.keys(probabilities).length !== allowed.size || Object.entries(probabilities).some(([id, probability]) => !allowed.has(id) || typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) || Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.02) throw new Error("decision 返回的概率分布无效");
  return { selectedId: value.selectedId, reviewRequired: rejected, confidence, probabilities, model: value.model, elapsedMs: value.elapsedMs };
}

function validatePostCandidates(value) {
  if (!Array.isArray(value) || value.length !== 5) throw new Error("帖文接口必须返回恰好 5 条候选");
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item.id !== "string" || !/^c[1-5]$/.test(item.id) || seen.has(item.id)
      || typeof item.text !== "string" || !item.text.trim() || item.text.length > 280
      || !Array.isArray(item.checkNotes) || item.checkNotes.length > 5
      || item.checkNotes.some((note) => typeof note !== "string" || !note.trim() || note.length > 120)) throw new Error("帖文接口返回了非法候选");
    seen.add(item.id);
    return { id: item.id, text: item.text.trim(), checkNotes: item.checkNotes.map((note) => note.trim()) };
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
    if (kind === "original-post") {
      if (url.pathname === "/compose/post") return true;
      // A compose dialog opened from the feed keeps the tab URL on the feed.
      // The content script still validates one compose editor without a target.
      return isFeedPath(url.pathname) && isFeedPath(new URL(senderValue).pathname);
    }
    return false;
  } catch { return false; }
}

function isFeedPath(pathname) {
  return pathname === "/home" || pathname === "/explore" || pathname === "/notifications"
    || pathname === "/i/bookmarks" || pathname === "/search" || /^\/[^/]+$/.test(pathname);
}
