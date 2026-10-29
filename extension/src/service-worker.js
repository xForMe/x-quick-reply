import { DEFAULTS, migrateSettings } from "./settings.js";

const POST_SCHEMA = "quick-post.v1";
const CACHE_KEY = "quickPost.cache.v1";
const HISTORY_KEY = "quickPost.history.v1";
const FILLED_KEY = "quickPost.filled.v1";
const CACHE_LIMIT = 30;
const HISTORY_LIMIT = 500;
const FILLED_LIMIT = 500;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const kind = message?.type === "GENERATE_REPLIES" ? message.context?.kind : "original-post";
  if (!["GENERATE_REPLIES", "GENERATE_POST_BATCH", "OPTIMIZE_POST", "LIST_POST_CACHE", "POST_CACHE_OP"].includes(message?.type)) return undefined;
  authorizeSender(sender, message.type === "GENERATE_REPLIES" ? kind : "original-post").then(async (source) => {
    switch (message.type) {
      case "GENERATE_REPLIES": return generateReplies(message.context, source);
      case "GENERATE_POST_BATCH": return generatePostBatch(source, message.source);
      case "OPTIMIZE_POST": return optimizePost(source, message.draft);
      case "LIST_POST_CACHE": return { ok: true, ...(await readCache()), historyCount: (await readHistory()).items.length, filledCount: (await readFilled()).items.length };
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

  const base = gatewayBase(settings);
  const generated = await postJson(`${base}/v1/replies/generate`, request, settings.timeoutMs);
  if (generated?.schemaVersion !== "quick-reply.v2") throw new Error("生成接口协议版本无效，请重启新版网关并更新扩展");
  const candidates = validateCandidates(generated?.candidates);
  await assertTabUnchanged(source);
  const decision = await postJson(`${base}/v1/replies/decide`, { ...request, candidates }, settings.timeoutMs);
  const validDecision = validateDecision(decision, candidates);
  return { ok: true, mode: "gateway", candidates, decision: validDecision, generation: generated.meta,
    autoLikeAfterReply: settings.autoLikeAfterReply, oneClickReply: settings.oneClickReply,
    oneClickCountdownSeconds: settings.oneClickCountdownSeconds };
}

// One button runs the whole quick-post batch: topics fetch -> one post per
// topic -> decision recommendation -> cache append. Any failing stage stops
// the chain and is reported with its stage; no retry, fallback or mock output.
async function generatePostBatch(source, board) {
  const settings = await loadSettings();
  if (typeof settings.postPrompt !== "string" || !settings.postPrompt.trim() || settings.postPrompt.length > 3000) throw new Error("请在扩展设置中填写发帖提示词（1–3000 字符）");
  // The board is chosen explicitly by the user (topics or tweets). A failing
  // board is reported as-is; the worker never switches sources by itself.
  if (board !== undefined && board !== "topics" && board !== "tweets") throw new Error("话题来源无效：只能是 topics 或 tweets");
  const categories = validateCategories(settings.postCategories);
  const base = gatewayBase(settings);
  const head = { schemaVersion: POST_SCHEMA, kind: "original-post", source: board || "topics", categories };
  const topicPayload = (topics) => topics.map((topic) => ({
    id: topic.id, rank: topic.rank, title: topic.title, summary: topic.summary, tags: topic.tags, repliesCount: topic.repliesCount,
    sourceMaterials: topic.sourceMaterials, sourceStatus: topic.sourceStatus
  }));

  const fetched = await postJson(`${base}/v1/posts/topics/fetch`, head, settings.timeoutMs);
  if (fetched?.schemaVersion !== POST_SCHEMA) throw new Error("话题接口协议版本无效，请重启新版网关并更新扩展");
  const topics = validateTopics(fetched?.topics);
  await assertTabUnchanged(source);

  // One post per topic: generation covers every fetched topic, then the
  // decision model recommends one post (or abstains). Abstention only hides
  // the recommendation; every post still goes to the cache pool.
  const generated = await postJson(`${base}/v1/posts/generate`, {
    ...head,
    topics: topicPayload(topics),
    language: "auto",
    tone: settings.tone,
    postPrompt: settings.postPrompt.trim(),
    postExamples: typeof settings.postExamples === "string" ? settings.postExamples.trim() : ""
  }, settings.timeoutMs);
  if (generated?.schemaVersion !== POST_SCHEMA) throw new Error("帖文接口协议版本无效，请重启新版网关并更新扩展");
  const candidates = validatePostCandidates(generated?.candidates, topics);
  await assertTabUnchanged(source);

  const decision = await postJson(`${base}/v1/posts/decide`, { ...head, topics: topicPayload(topics), candidates }, settings.timeoutMs);
  const validDecision = validatePostDecision(decision, candidates);

  let cache = null;
  let cacheError = null;
  let evicted = 0;
  let skippedCount = 0;
  let skippedHistoryCount = 0;
  let skippedFilledCount = 0;
  let historyCount = 0;
  let filledCount = 0;
  try {
    const appended = await appendCache(candidates, topics, fetched.source);
    cache = appended.items;
    evicted = appended.evicted;
    skippedCount = appended.skippedCount;
    skippedHistoryCount = appended.skippedHistoryCount;
    skippedFilledCount = appended.skippedFilledCount;
    historyCount = appended.historyCount;
    filledCount = appended.filledCount;
  } catch (error) {
    // The batch itself is real and usable this session, but it must never be
    // presented as cached. Report the storage stage and keep the failure visible.
    cacheError = typeof error?.message === "string" ? error.message : "缓存写入失败（阶段 cache.write）";
  }
  return { ok: true, topics, candidates, decision: validDecision,
    generation: generated.meta, cache, cacheError, evicted, skippedCount, skippedHistoryCount, skippedFilledCount, historyCount, filledCount, source: fetched.source, fetchedAt: fetched.fetchedAt };
}

// User-authored drafts are optimized through a separate stateless route. They
// never enter the hot-topic cache or its deduplication history.
async function optimizePost(source, draft) {
  const settings = await loadSettings();
  if (typeof settings.postPrompt !== "string" || !settings.postPrompt.trim() || settings.postPrompt.length > 3000) throw new Error("请在扩展设置中填写发帖提示词（1–3000 字符）");
  if (typeof draft !== "string" || !draft.trim() || draft.trim().length > 4000) throw new Error("原始草稿必须为 1–4000 字符");
  const request = { schemaVersion: POST_SCHEMA, kind: "original-post", draft: draft.trim(), language: "auto", tone: settings.tone,
    postPrompt: settings.postPrompt.trim(), postExamples: typeof settings.postExamples === "string" ? settings.postExamples.trim() : "" };
  const base = gatewayBase(settings);
  const optimized = await postJson(`${base}/v1/posts/optimize`, request, settings.timeoutMs);
  if (optimized?.schemaVersion !== POST_SCHEMA) throw new Error("优化接口协议版本无效（阶段 optimize.protocol），请重启新版网关并更新扩展");
  const candidate = validateOptimizedPost(optimized?.candidate);
  await assertTabUnchanged(source);
  return { ok: true, candidate, generation: optimized.meta };
}

async function loadSettings() {
  return migrateSettings({ ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) });
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
    || (item.sourceMaterialIds !== undefined && (!Array.isArray(item.sourceMaterialIds) || item.sourceMaterialIds.some((id) => typeof id !== "string" || !id)))
    || (item.sourceMaterials !== undefined && (!Array.isArray(item.sourceMaterials) || item.sourceMaterials.some((material) => !material || typeof material.id !== "string" || typeof material.kind !== "string" || typeof material.text !== "string" || !material.text.trim() || material.text.length > 2000)))
    || (item.sourcePostId !== undefined && item.sourcePostId !== null && typeof item.sourcePostId !== "string")
    || typeof item.batchId !== "string" || !item.batchId
    || typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)
    || (item.usedAt !== undefined && item.usedAt !== null && (typeof item.usedAt !== "number" || !Number.isFinite(item.usedAt)))
    || (item.excludedAt !== undefined && item.excludedAt !== null && (typeof item.excludedAt !== "number" || !Number.isFinite(item.excludedAt)))) {
    throw new Error("缓存数据结构无效（阶段 cache.read）");
  }
}

function validateFilledItem(item) {
  if (!item || typeof item !== "object" || typeof item.textHash !== "string" || !/^[0-9a-f]{64}$/.test(item.textHash)
    || !Array.isArray(item.sourceMaterialIds) || item.sourceMaterialIds.some((id) => typeof id !== "string" || !id)
    || (!Number.isFinite(item.filledAt) && !Number.isFinite(item.markedAt))
    || (item.filledAt !== undefined && !Number.isFinite(item.filledAt))
    || (item.markedAt !== undefined && !Number.isFinite(item.markedAt))
    || (item.reason !== undefined && !["filled", "published"].includes(item.reason))) {
    throw new Error("已填入历史数据结构无效（阶段 cache.read）");
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

function normalizePostText(text) {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ");
}

async function hashText(text) {
  if (!globalThis.crypto?.subtle) throw new Error("去重指纹计算不可用（阶段 cache.dedup）");
  const bytes = new TextEncoder().encode(normalizePostText(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateHistoryItem(item) {
  if (!item || typeof item !== "object" || typeof item.textHash !== "string" || !/^[0-9a-f]{64}$/.test(item.textHash)
    || (item.sourcePostId !== undefined && item.sourcePostId !== null && typeof item.sourcePostId !== "string")
    || typeof item.firstSeenAt !== "number" || !Number.isFinite(item.firstSeenAt)) {
    throw new Error("去重历史数据结构无效（阶段 cache.read）");
  }
}

async function readHistory() {
  let stored;
  try { stored = await chrome.storage.local.get(HISTORY_KEY); }
  catch (error) { throw new Error(`去重历史读取失败（阶段 cache.read）：${error?.message || "存储不可用"}`); }
  const value = stored[HISTORY_KEY];
  if (value === undefined) return { items: [] };
  if (!value || typeof value !== "object" || !Array.isArray(value.items) || value.items.length > HISTORY_LIMIT) throw new Error("去重历史数据结构无效（阶段 cache.read）");
  value.items.forEach(validateHistoryItem);
  return { items: value.items };
}

async function readFilled() {
  let stored;
  try { stored = await chrome.storage.local.get(FILLED_KEY); }
  catch (error) { throw new Error(`已填入历史读取失败（阶段 cache.read）：${error?.message || "存储不可用"}`); }
  const value = stored[FILLED_KEY];
  if (value === undefined) return { items: [] };
  if (!value || typeof value !== "object" || !Array.isArray(value.items) || value.items.length > FILLED_LIMIT) throw new Error("已填入历史数据结构无效（阶段 cache.read）");
  value.items.forEach(validateFilledItem);
  return { items: value.items };
}

async function writeCacheAndHistory(items, history) {
  try { await chrome.storage.local.set({ [CACHE_KEY]: { items }, [HISTORY_KEY]: { items: history } }); }
  catch (error) { throw new Error(`缓存写入失败（阶段 cache.write）：${error?.message || "存储不可用"}`); }
}

async function writeCacheAndFilled(items, filled) {
  try { await chrome.storage.local.set({ [CACHE_KEY]: { items }, [FILLED_KEY]: { items: filled } }); }
  catch (error) { throw new Error(`已填入历史写入失败（阶段 cache.write）：${error?.message || "存储不可用"}`); }
}

async function appendCache(candidates, topics, source) {
  const { items } = await readCache();
  const historyValue = await readHistory();
  const filledValue = await readFilled();
  const history = [...historyValue.items];
  const filled = [...filledValue.items];
  for (const item of items.filter((entry) => entry.usedAt)) {
    const textHash = await hashText(item.text);
    if (!history.some((entry) => entry.textHash === textHash)) {
      history.push({ textHash, ...(item.sourcePostId ? { sourcePostId: item.sourcePostId } : {}), firstSeenAt: item.createdAt });
    }
  }
  const now = Date.now();
  const batchId = crypto.randomUUID();
  const added = [];
  let skippedCount = 0;
  let skippedHistoryCount = 0;
  let skippedFilledCount = 0;
  let historyCount = 0;
  for (const candidate of candidates) {
    const topic = topics.find((entry) => entry.id === candidate.topicId);
    if (!topic) throw new Error("候选来源话题不存在（阶段 cache.dedup）");
    const textHash = await hashText(candidate.text);
    const sourcePostId = source === "xzhishu-tweets-hot" ? topic.id : null;
    const sourceMaterialIds = Array.isArray(candidate.sourceMaterialIds) ? candidate.sourceMaterialIds : [];
    const historyHit = history.some((entry) => entry.textHash === textHash || (sourcePostId && entry.sourcePostId === sourcePostId));
    const filledHit = filled.some((entry) => entry.textHash === textHash || sourceMaterialIds.some((id) => entry.sourceMaterialIds.includes(id)));
    if (historyHit || filledHit || added.some((entry) => entry.textHash === textHash || (sourcePostId && entry.sourcePostId === sourcePostId))) {
      skippedCount += 1;
      if (historyHit) skippedHistoryCount += 1;
      if (filledHit) skippedFilledCount += 1;
      continue;
    }
    added.push({
      id: crypto.randomUUID(),
      text: candidate.text,
      checkNotes: candidate.checkNotes,
      sourceTopic: { id: topic.id, title: topic.title },
      sourceMaterialIds,
      sourceMaterials: topic.sourceMaterials,
      ...(sourcePostId ? { sourcePostId } : {}),
      batchId,
      createdAt: now
    });
    history.push({ textHash, ...(sourcePostId ? { sourcePostId } : {}), firstSeenAt: now });
  }
  if (history.length > HISTORY_LIMIT) throw new Error(`去重历史已达到上限 ${HISTORY_LIMIT} 条，请先清除历史（阶段 cache.write）`);
  let merged = [...items, ...added];
  let evicted = 0;
  // When over the limit, delete items already used or manually excluded first,
  // then the oldest ones. Eviction is visible in the response, never silent.
  while (merged.length > CACHE_LIMIT) {
    const used = merged.filter((item) => item.usedAt || item.excludedAt).sort((a, b) =>
      (a.usedAt || a.excludedAt) - (b.usedAt || b.excludedAt))[0];
    const oldest = [...merged].sort((a, b) => a.createdAt - b.createdAt)[0];
    const victim = used || oldest;
    merged = merged.filter((item) => item !== victim);
    evicted += 1;
  }
  await writeCacheAndHistory(merged, history);
  historyCount = history.length;
  return { items: merged, evicted, skippedCount, skippedHistoryCount, skippedFilledCount, historyCount, filledCount: filled.length };
}

async function applyCacheOp(message) {
  const { items } = await readCache();
  const op = message?.op;
  const id = message?.id;
  let next = items;
  if (op === "clear-history") {
    await writeStorage({ [HISTORY_KEY]: { items: [] } });
    return { ok: true, items, historyCount: 0 };
  } else if (op === "clear") {
    next = [];
  } else if (op === "delete" || op === "mark" || op === "exclude") {
    if (typeof id !== "string" || !id) throw new Error("缓存操作缺少条目 ID（阶段 cache.write）");
    if (!items.some((item) => item.id === id)) throw new Error("缓存条目不存在（阶段 cache.write）");
    next = items.map((item) => {
      if (item.id !== id) return item;
      if (op === "mark") return { ...item, usedAt: Date.now() };
      if (op === "exclude") return { ...item, excludedAt: Date.now() };
      return item;
    });
    if (op === "delete") next = items.filter((item) => item.id !== id);
  } else {
    throw new Error("未知缓存操作（阶段 cache.write）");
  }
  if (op === "mark" || op === "exclude") {
    const item = items.find((entry) => entry.id === id);
    const filledValue = await readFilled();
    const filled = [...filledValue.items];
    const textHash = await hashText(item.text);
    const sourceMaterialIds = Array.isArray(item.sourceMaterialIds) ? item.sourceMaterialIds : [];
    if (!filled.some((entry) => entry.textHash === textHash || sourceMaterialIds.some((sourceId) => entry.sourceMaterialIds.includes(sourceId)))) {
      const timestamp = Date.now();
      filled.push(op === "mark"
        ? { textHash, sourceMaterialIds: [...sourceMaterialIds], filledAt: timestamp, reason: "filled" }
        : { textHash, sourceMaterialIds: [...sourceMaterialIds], markedAt: timestamp, reason: "published" });
    }
    if (filled.length > FILLED_LIMIT) throw new Error(`已填入历史已达到上限 ${FILLED_LIMIT} 条，请先清理（阶段 cache.write）`);
    await writeCacheAndFilled(next, filled);
    return { ok: true, items: next, filledCount: filled.length };
  }
  await writeCache(next);
  return { ok: true, items: next, filledCount: (await readFilled()).items.length };
}

async function writeStorage(entries) {
  try { await chrome.storage.local.set(entries); }
  catch (error) { throw new Error(`缓存写入失败（阶段 cache.write）：${error?.message || "存储不可用"}`); }
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
      || item.sourceStatus !== "available" || !Array.isArray(item.sourceMaterials) || !item.sourceMaterials.length
      || item.sourceMaterials.some((material) => !material || typeof material.id !== "string" || !material.id
        || !["tweet", "article"].includes(material.kind) || typeof material.text !== "string" || !material.text.trim() || material.text.length > 2000)
      || !Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string" || tag.length > 40)
      || !Number.isInteger(item.repliesCount) || item.repliesCount < 0
      || !Number.isInteger(item.rank) || item.rank < 1) throw new Error("话题接口返回了非法话题条目");
    seen.add(item.id);
    return { id: item.id, rank: item.rank, title: item.title.trim(), summary: item.summary, tags: item.tags, repliesCount: item.repliesCount,
      sourceStatus: item.sourceStatus, sourceMaterials: item.sourceMaterials.map((material) => ({ id: material.id, kind: material.kind, text: material.text.trim() })) };
  });
}

function validatePostDecision(value, candidates) {
  if (!value || value.schemaVersion !== POST_SCHEMA || value.model !== "decision-model-preview") throw new Error("decision 协议版本或模型无效");
  const rejected = value.reviewRequired === true && value.selectedId === null;
  if (!rejected && (value.reviewRequired !== false || !candidates.some((candidate) => candidate.id === value.selectedId))) throw new Error("decision 返回的候选 ID 无效");
  const confidence = value.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("decision 返回的置信度无效");
  const allowed = new Set([...candidates.map((candidate) => candidate.id), "__none__"]);
  const probabilities = value.probabilities;
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities) || Object.keys(probabilities).length !== allowed.size || Object.entries(probabilities).some(([id, probability]) => !allowed.has(id) || typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) || Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.02) throw new Error("decision 返回的概率分布无效");
  return { selectedId: value.selectedId, reviewRequired: rejected, confidence, probabilities, model: value.model, elapsedMs: value.elapsedMs };
}

function validateCategories(value) {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return [];
  if (!Array.isArray(value) || value.length > 15
    || value.some((name) => typeof name !== "string" || !name.trim() || name.length > 40)) throw new Error("发帖类别设置无效，请重新保存扩展设置");
  return [...new Set(value.map((name) => name.trim()))];
}

function validatePostCandidates(value, topics) {
  if (!Array.isArray(value) || value.length !== topics.length) throw new Error("帖文接口必须为每个话题返回恰好一条候选");
  const topicIds = new Set(topics.map((topic) => topic.id));
  const seen = new Set();
  const covered = new Set();
  return value.map((item) => {
    if (!item || typeof item.id !== "string" || !/^c[1-5]$/.test(item.id) || seen.has(item.id)
      || typeof item.topicId !== "string" || !topicIds.has(item.topicId) || covered.has(item.topicId)
      || typeof item.text !== "string" || !item.text.trim() || item.text.length > 280
      || !Array.isArray(item.sourceMaterialIds) || item.sourceMaterialIds.some((id) => typeof id !== "string" || !id
        || !topics.find((topic) => topic.id === item.topicId).sourceMaterials.some((material) => material.id === id))
      || !Array.isArray(item.checkNotes) || item.checkNotes.length > 5
      || item.checkNotes.some((note) => typeof note !== "string" || !note.trim() || note.length > 120)) throw new Error("帖文接口返回了非法候选（每个话题必须恰好一条）");
    seen.add(item.id);
    covered.add(item.topicId);
    return { id: item.id, topicId: item.topicId, sourceMaterialIds: [...item.sourceMaterialIds], text: item.text.trim(), checkNotes: item.checkNotes.map((note) => note.trim()) };
  });
}

function validateOptimizedPost(value) {
  if (!value || typeof value !== "object" || typeof value.text !== "string" || !value.text.trim() || value.text.length > 280
    || !Array.isArray(value.checkNotes) || value.checkNotes.length > 5
    || value.checkNotes.some((note) => typeof note !== "string" || !note.trim() || note.length > 120)) {
    throw new Error("优化接口返回了非法候选（阶段 optimize.parse）");
  }
  return { id: "manual-optimize", text: value.text.trim(), checkNotes: value.checkNotes.map((note) => note.trim()), manual: true };
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
