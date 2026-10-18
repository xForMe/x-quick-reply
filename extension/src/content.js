(() => {
  const VERSION = "0.4.0";
  const INVALID_CONTEXT_TEXT = "插件连接已失效。请刷新 X 页面，再重新打开回复弹窗并生成。";
  function isInvalidContext(error) { return /^Extension context invalidated\.?$/i.test(error?.message || ""); }
  const READY_TEXT = "点击下方按钮，生成回复并填入输入框。";
  const RUNTIME_KEY = "__xQuickReplyRuntime";
  const PENDING_LIKE_KEY = "__xQuickReplyPendingLike.v1";
  const PENDING_LIKE_MAX_AGE = 30000;
  const DEBUG_LIKE_BREAKPOINTS = true;
  try {
  const PANEL_ID = "quick-reply-panel";
  const previous = globalThis[RUNTIME_KEY];
  if (previous) {
    previous.dispose();
    // Use the current extension API context, including after an unpacked reload.
    chrome.runtime.onMessage.removeListener(previous.onMessage);
  }
  let state = { candidates: [], decision: null, mode: "" };
  let generation = 0;
  let source = null;
  let dismissed = false;
  let inserting = false;
  let pendingFill = null;
  let autoLikeAfterReply = false;
  let autoLikeSettingResolved = false;
  let pendingLike = null;

  // A DOM node is not evidence that this extension context has a live listener.
  document.getElementById(PANEL_ID)?.remove();
  const panel = document.createElement("aside");
  panel.id = PANEL_ID;
  const header = element("div", "qr-header");
  const close = actionButton("close", "×");
  close.title = "关闭";
  header.append(element("strong", "", `快速回复 · ${VERSION}`), close);
  const status = element("div", "qr-status", READY_TEXT);
  status.dataset.role = "status";
  status.setAttribute("role", "status");
  const candidates = element("div", "qr-candidates");
  candidates.dataset.role = "candidates";
  const fill = actionButton("fill", "回填输入框", "qr-fill");
  fill.disabled = true;
  fill.hidden = true;
  const diagnostics = actionButton("diagnostics", "复制排查信息", "qr-diagnostics");
  diagnostics.hidden = true;
  panel.append(header, status, actionButton("generate", "生成并填入回复", "qr-primary"), candidates, fill, diagnostics);
  document.body.appendChild(panel);
  panel.addEventListener("click", onClick);
  const onInput = (event) => {
    if (inserting || !source?.editor.contains(event.target)) return;
    // Sending a reply can clear the controlled editor and emit an input event;
    // keep the send confirmation alive while the one-shot like operation runs.
    if (pendingLike?.source === source) return;
    // Framework notifications for the exact expected text do not transfer
    // ownership. Any actual user input or different text invalidates it.
    if (!event.isTrusted && editorText(source.editor) === (pendingFill?.text ?? source.draft)) return;
    invalidate("草稿已变化，请重新生成");
  };
  document.addEventListener("input", onInput, true);
  const onDocumentClick = (event) => {
    const button = findSendButton(event.target);
    // 先在所有后续条件之前确认是否捕获到发送按钮点击；否则任一前置条件失败时，
    // 后面的断点都不会出现，无法区分“没有捕获点击”和“捕获后被条件拦截”。
    if (button) likeDebugger("send-button-click-captured", {
      buttonTestId: button.getAttribute("data-testid"),
      route: location.href,
      replyRoute: isReplyRoute(),
      pendingLike: !!pendingLike,
      sourceUrl: source?.url || null,
      autoLikeSettingResolved,
      autoLikeAfterReply
    });
    if (pendingLike || !isReplyRoute()) return;
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;
    let likeSource = source?.owned && source.kind === "public-reply" ? source : null;
    if (!likeSource) {
      try {
        const context = readContext();
        if (context.kind !== "public-reply" || !context.dialog?.contains(button)) return;
        likeSource = { url: location.href, kind: context.kind, editor: context.editor, target: context.target,
          dialog: context.dialog, targetLinks: context.targetLinks };
      } catch (error) {
        likeDebugger("send-context-read-failed", { message: error?.message || String(error) });
        return;
      }
    } else if (!likeSource.dialog?.contains(button)) {
      likeDebugger("send-button-outside-reply-dialog", { buttonTestId: button.getAttribute("data-testid") });
      return;
    }
    // 只有用户实际点击 X 的发送按钮，且当前弹窗仍是最初识别的回复目标，
    // 才允许启动一次点赞任务；生成或回填草稿本身不会触发点赞。
    const start = (enabled) => {
      if (!enabled) return likeDebugger("auto-like-disabled", { sourceUrl: likeSource.url });
      if (likeSource.url !== location.href) return likeDebugger("send-button-route-mismatch", {
        sourceUrl: likeSource.url,
        currentUrl: location.href
      });
      startPendingLike(likeSource);
    };
    if (autoLikeSettingResolved) return start(autoLikeAfterReply);
    // StorageArea 方法必须保留 storage 作为调用对象，不能先取出 get 再裸调用。
    const storage = chrome.storage?.local;
    if (!storage || typeof storage.get !== "function") {
      return setStatus("读取自动点赞设置失败：chrome.storage.local.get 不可用", true);
    }
    likeDebugger("read-auto-like-setting", { storageType: typeof storage, getType: typeof storage.get });
    Promise.resolve(storage.get({ autoLikeAfterReply: false })).then((settings) => {
      autoLikeSettingResolved = true;
      if (typeof settings.autoLikeAfterReply !== "boolean") return setStatus("自动点赞开关设置无效，请重新保存扩展设置", true);
      autoLikeAfterReply = settings.autoLikeAfterReply;
      start(autoLikeAfterReply);
    }).catch((error) => setStatus(`读取自动点赞设置失败：${error.message}`, true));
  };
  document.addEventListener("click", onDocumentClick, true);
  const onMessage = (message, _sender, sendResponse) => {
    if (message?.type !== "OPEN_QUICK_REPLY") return;
    dismissed = false;
    panel.hidden = false;
    try { readContext(); setStatus(`已识别当前回复目标。${READY_TEXT}`); sendResponse({ ok: true, version: VERSION }); }
    catch (error) { setStatus(error.message, true); sendResponse({ ok: false, error: error.message }); }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  const timer = observeUrlChanges();
  globalThis[RUNTIME_KEY] = { version: VERSION, panel, onMessage, dispose() {
    generation++;
    clearTimeout(pendingFill?.timer);
    pendingFill = null;
    clearInterval(timer);
    clearPendingLike();
    panel.removeEventListener("click", onClick);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("click", onDocumentClick, true);
    panel.remove();
  } };
  restorePendingLike();

  function element(tag, className = "", text = "") {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  function actionButton(action, text, className = "") {
    const node = element("button", className, text);
    node.type = "button";
    node.dataset.action = action;
    return node;
  }

  function onClick(event) {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "close") { dismissed = true; panel.hidden = true; invalidate("面板已关闭，旧请求已取消"); }
    if (action === "generate") generate();
    if (action === "fill") fillSelected();
    if (action === "diagnostics") copyDiagnostics();
    if (event.target.closest("[data-candidate]")) {
      if (state.decision?.reviewRequired || pendingFill) return;
      state.selectedId = event.target.closest("[data-candidate]").dataset.candidate;
      renderCandidates();
    }
  }

  async function generate() {
    if (pendingFill) return;
    const current = ++generation;
    source = null;
    state = { candidates: [], decision: null, mode: "" };
    renderCandidates();
    let response;
    try {
      const context = readContext();
      if (editorText(context.editor).trim()) throw new Error("输入框已有草稿，请处理草稿后重新生成");
      source = { url: location.href, kind: context.kind, key: contextKey(context), editor: context.editor,
        target: context.target, dialog: context.dialog, textNode: context.textNode, targetLinks: context.targetLinks,
        draft: editorText(context.editor) };
      setGenerating(true);
      setStatus("正在生成回复并选择合适内容，请稍候…");
      response = await chrome.runtime.sendMessage({ type: "GENERATE_REPLIES", context: { kind: context.kind, messages: context.messages, language: "auto" } });
    } catch (error) {
      if (current !== generation) return;
      if (isInvalidContext(error)) return invalidate(INVALID_CONTEXT_TEXT);
      return setStatus(error instanceof Error ? error.message : "生成失败", true);
    } finally {
      if (current === generation) setGenerating(false);
    }
    if (current !== generation) return;
    if (!sourceIsCurrent()) return setStatus("会话或草稿已变化，请重新生成", true);
    if (!response?.ok) return setStatus(response?.error || "生成失败", true);
    autoLikeAfterReply = response.autoLikeAfterReply === true;
    autoLikeSettingResolved = true;
    state = { candidates: response.candidates, decision: response.decision, selectedId: response.decision.selectedId, mode: response.mode };
    renderCandidates();
    if (state.decision.reviewRequired) return setStatus("百炼未选择合适回复，请人工起草", true);
    setStatus("已生成，百炼已选择候选");
    fillSelected();
  }

  function startPendingLike(likeSource) {
    if (pendingLike) return;
    // 这是发送后的单次状态机：先确认发送迹象，再定位原帖，最后点击并核验点赞。
    likeDebugger("send-confirmation-start");
    pendingLike = { source: likeSource, clicked: false, deadline: Date.now() + 5000, timer: null };
    setStatus("已点击发送，正在确认回复并点赞原帖…");
    pendingLike.timer = setInterval(checkReplyAndLike, 100);
    checkReplyAndLike();
  }

  function restorePendingLike() {
    let marker;
    try {
      const raw = sessionStorage.getItem(PENDING_LIKE_KEY);
      if (!raw) return;
      likeDebugger("pending-like-restore-start");
      marker = JSON.parse(raw);
    } catch (error) {
      clearPendingLikeMarker();
      setStatus(`读取原帖点赞任务失败：${error.message}`, true);
      return;
    }
    if (!marker || marker.schema !== "quick-reply.like.v1" || typeof marker.url !== "string"
      || !Number.isInteger(marker.createdAt) || Date.now() - marker.createdAt > PENDING_LIKE_MAX_AGE) {
      clearPendingLikeMarker();
      return;
    }
    const targetUrl = canonicalStatusUrl(marker.url);
    if (!targetUrl || statusIdFromHref(location.href) !== statusIdFromHref(targetUrl)) return;
    // 原帖通过完整导航打开后，内存中的 pendingLike 已丢失；这里用短时标记恢复一次任务。
    pendingLike = { source: { url: location.href, kind: "public-reply", target: null, editor: null, targetLinks: [targetUrl] },
      clicked: false, deadline: Date.now() + 10000, timer: null, navigationStarted: true };
    setStatus("已打开原帖，正在确认点赞按钮…");
    pendingLike.timer = setInterval(checkReplyAndLike, 100);
    checkReplyAndLike();
  }

  function readConversation(editor) {
    const scope = editor.closest('[data-testid="DMConversation"]') || editor.closest('[data-testid="DmActivityViewport"]');
    if (!scope) throw new Error("读取失败：无法确定当前私信会话边界");
    const selectors = [
      '[data-testid="messageEntry"]',
      '[data-testid*="messageEntry"]'
    ];
    const nodes = selectors.flatMap((selector) => [...scope.querySelectorAll(selector)]);
    const visible = [...new Set(nodes)].filter((node) => node.getClientRects().length && !node.closest('[aria-hidden="true"]'));
    const unique = visible.filter((node) => !visible.some((other) => other !== node && node.contains(other)))
      .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const messages = unique.map((node) => ({ role: "unknown", text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim() }))
      .filter((item) => item.text)
      .slice(-20)
      .map((item) => ({ ...item, text: item.text.slice(0, 800) }));
    let total = 0;
    return messages.reverse().filter((item) => {
      if (total + item.text.length > 8000) return false;
      total += item.text.length;
      return true;
    }).reverse();
  }

  function renderCandidates() {
    const container = panel.querySelector('[data-role="candidates"]');
    const selectedId = state.selectedId;
    container.replaceChildren(...state.candidates.map((candidate) => {
      const button = element("button", `qr-candidate ${candidate.id === selectedId ? "selected" : ""}`);
      button.type = "button";
      button.dataset.candidate = candidate.id;
      button.disabled = state.decision?.reviewRequired === true || !!pendingFill;
      button.append(element("span", "", candidate.text));
      if (candidate.id === state.decision?.selectedId) button.append(element("em", "", "百炼选中"));
      return button;
    }));
    if (state.decision) container.append(element("div", "qr-reason", `选择置信度：${(state.decision.confidence * 100).toFixed(1)}%（不代表回复正确率）`));
    panel.querySelector('[data-action="fill"]').disabled = !selectedId || state.decision?.reviewRequired || !!pendingFill;
    panel.querySelector('[data-action="fill"]').hidden = !selectedId || state.decision?.reviewRequired === true;
  }

  function fillSelected() {
    if (pendingFill) return;
    if (!sourceIsCurrent()) return invalidate("会话或草稿已变化，请重新生成");
    const selected = state.candidates.find((candidate) => candidate.id === state.selectedId);
    if (!selected) return setStatus("请先选择候选回复", true);
    const editor = source.editor;
    if (!editor) return setStatus("没有找到消息输入框，请点击输入区域后重试", true);
    if (source.owned && source.draft === selected.text) return setStatus("已回填此候选，无需重复填入；请检查后手动发送");
    const operation = { source, text: selected.text, timer: null };
    pendingFill = operation;
    renderCandidates();
    setGenerating(false);
    setStatus("正在回填并核验输入框…");
    inserting = true;
    try {
      editor.focus();
      if (!sourceIsCurrent()) throw new Error("聚焦输入框时目标或草稿发生变化");
      if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
        editor.setRangeText(selected.text, 0, editor.value.length, "end");
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: selected.text }));
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges(); selection.addRange(range);
        // Synchronize the controlled editor's selection before replacing text.
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        if (!sourceIsCurrent()) throw new Error("选择输入区域时目标或草稿发生变化");
        const clipboard = new DataTransfer();
        clipboard.setData("text/plain", selected.text);
        const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard });
        editor.dispatchEvent(paste);
        // A synthetic paste has no native default insertion. The site's editor
        // must handle it once; never combine it with execCommand/DOM mutation.
        if (!paste.defaultPrevented) throw new Error("当前编辑器未接收粘贴事件，未执行其他写入方式");
      }
    } catch (error) {
      return invalidate(`回填失败：${error.message}`);
    } finally { inserting = false; }
    // Keep controls locked until the framework has rendered. Ownership is
    // granted only after exact text AND target checks, never after acceptance alone.
    operation.timer = setTimeout(() => {
      if (pendingFill !== operation || source !== operation.source) return;
      if (!sourceIsCurrent(operation.text)) return invalidate("回填核验失败：目标或草稿发生变化，请检查输入框；未自动重试或发送");
      source.draft = operation.text;
      source.owned = true;
      pendingFill = null;
      renderCandidates();
      setGenerating(false);
      setStatus(autoLikeAfterReply && source.kind === "public-reply"
        ? "已回填输入框，可切换候选后再次回填；请检查后手动发送，发送成功后将打开原帖并自动点赞"
        : "已回填输入框，可切换候选后再次回填；请检查后手动发送");
    }, 150);
  }

  function checkReplyAndLike() {
    const operation = pendingLike;
    if (!operation || (source && operation.source !== source)) return clearPendingLike();
    const editorGone = !operation.source.editor?.isConnected;
    const editorCleared = operation.source.editor?.isConnected && !editorText(operation.source.editor).trim();
    // 清空或卸载编辑器才算页面确认发送；否则不能因为发送按钮被点击就提前点赞。
    if (!editorGone && !editorCleared) {
      if (Date.now() >= operation.deadline) return finishLike(false, "发送未确认，未自动点赞；未重试");
      return;
    }
    const target = findLikeTarget(operation.source);
    const targetUrl = findTargetStatusUrl(operation.source);
    if (!targetUrl) return finishLike(false, "回复已发送，但没有可靠的原帖链接；未自动跳转或点赞");
    if (!target && !operation.navigationStarted) return navigateToTarget(operation, targetUrl);
    if (!target) {
      if (Date.now() >= operation.deadline) return finishLike(false, "已打开原帖，但未找到目标帖子；未自动重试");
      return;
    }
    const like = target && findLikeButton(target);
    if (!like) {
      if (!operation.debugMissingButton) {
        operation.debugMissingButton = true;
        likeDebugger("like-button-missing", { targetUrl });
      }
      if (Date.now() >= operation.deadline) return finishLike(false, "已打开原帖，但未找到点赞按钮；未自动重试");
      return;
    }
    if (isLiked(like)) return finishLike(true, "回复已发送，目标帖子此前已点赞");
    if (!operation.clicked) {
      // 只允许点击一次；点击后必须从 DOM 状态确认已点赞，不能把 click() 本身当成成功。
      likeDebugger("like-button-before-click", {
        dataTestId: like.getAttribute("data-testid"),
        ariaLabel: like.getAttribute("aria-label"),
        targetUrl
      });
      operation.clicked = true;
      like.click();
      likeDebugger("like-button-after-click", {
        dataTestId: like.getAttribute("data-testid"),
        ariaLabel: like.getAttribute("aria-label"),
        liked: isLiked(like),
        targetUrl
      });
    }
    if (isLiked(like)) return finishLike(true, "回复已发送，已自动点赞目标帖子");
    if (Date.now() >= operation.deadline) return finishLike(false, "已尝试点赞，但页面未确认成功；未自动重试");
  }

  function findLikeTarget(operationSource) {
    if (operationSource.target?.isConnected) return operationSource.target;
    // 发送后弹窗可能被 X 卸载。此时只用唯一状态 ID 找回原帖，不能用用户主页链接猜目标。
    const statusIds = [...new Set((operationSource.targetLinks || [])
      .map(statusIdFromHref).filter(Boolean))];
    if (!statusIds.length) return null;
    return [...document.querySelectorAll('[data-testid="tweet"]')].find((post) =>
      statusIds.some((id) => [...post.querySelectorAll('a[href]')].some((anchor) => statusIdFromHref(anchor.getAttribute("href")) === id)));
  }

  function findTargetStatusUrl(operationSource) {
    return (operationSource.targetLinks || []).map(canonicalStatusUrl).find(Boolean) || null;
  }

  function navigateToTarget(operation, targetUrl) {
    operation.navigationStarted = true;
    try {
      // 完整导航会销毁当前 content script，所以先保存脱敏 URL，供原帖页恢复一次任务。
      sessionStorage.setItem(PENDING_LIKE_KEY, JSON.stringify({ schema: "quick-reply.like.v1", url: targetUrl, createdAt: Date.now() }));
      setStatus("回复已发送，正在打开原帖确认点赞…");
      likeDebugger("navigate-to-original-post", { targetUrl });
      location.assign(targetUrl);
      return true;
    } catch (error) {
      operation.navigationStarted = false;
      return finishLike(false, `打开原帖失败：${error.message}`);
    }
  }

  function findLikeButton(target) {
    // X 的点赞数量会出现在 aria-label 前缀中；筛选交给 isLikeControl，只判断语义状态词。
    const selector = '[data-testid="like"], [data-testid="unlike"], [data-testid*="like"], [aria-label], [role="button"]';
    return [...target.querySelectorAll(selector)]
      .filter((button) => isLikeControl(button))
      .find((button) => visible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true") || null;
  }

  function isLiked(button) {
    // 真实 X 页面点赞后通常同时出现 data-testid="unlike" 和 aria-label 末尾 "Liked"。
    return button?.getAttribute("data-testid") === "unlike" || button?.getAttribute("aria-pressed") === "true"
      || ["liked", "取消喜欢", "已喜欢"].includes(likeLabelState(button?.getAttribute("aria-label")));
  }

  function isLikeControl(button) {
    const testId = button?.getAttribute("data-testid") || "";
    return /^(?:un)?like(?:button)?$/i.test(testId) || !!likeLabelState(button?.getAttribute("aria-label"));
  }

  function likeLabelState(label) {
    // X prefixes the state with a localized count, e.g. "43 Likes. Like".
    // Only the trailing state word is semantic; the count and its wording are not.
    const match = String(label || "").trim().match(/(?:^|[.。:：]\s*)(Like|Liked|喜欢|已喜欢|取消喜欢)\s*$/i);
    return match?.[1]?.toLowerCase() || null;
  }

  function likeDebugger(stage, details = {}) {
    if (!DEBUG_LIKE_BREAKPOINTS) return;
    console.debug("[x-quick-reply like breakpoint]", stage, details);
    debugger;
  }

  function findSendButton(node) {
    if (!(node instanceof Element)) return null;
    const button = node.closest('[data-testid^="tweetButton"]');
    if (!button) return null;
    return button;
  }

  function statusIdFromHref(href) {
    const match = String(href || "").match(/\/status\/(\d+)(?:[/?#]|$)/);
    return match?.[1] || null;
  }

  function canonicalStatusUrl(href) {
    try {
      const url = new URL(href, location.origin);
      if (!["x.com", "twitter.com"].includes(url.hostname) || !statusIdFromHref(url.href)) return null;
      url.search = ""; url.hash = "";
      return url.href;
    } catch { return null; }
  }

  function clearPendingLikeMarker() {
    try { sessionStorage.removeItem(PENDING_LIKE_KEY); } catch { /* no-op: expiration will bound a stale marker */ }
  }

  function finishLike(success, message) {
    clearPendingLike(true);
    setStatus(message, !success);
  }

  function clearPendingLike(removeMarker = false) {
    if (pendingLike?.timer) clearInterval(pendingLike.timer);
    if (removeMarker) clearPendingLikeMarker();
    pendingLike = null;
  }

  function findDmEditor() {
    const nodes = [...document.querySelectorAll('[data-testid="dmComposerTextInput"], [data-testid="DmActivityViewport"] [contenteditable="true"][role="textbox"], [data-testid="DMConversation"] [contenteditable="true"][role="textbox"]')]
      .map((node) => node.matches('[contenteditable="true"], textarea, input') ? node : node.querySelector('[contenteditable="true"], textarea, input'))
      .filter((node) => node && node.getClientRects().length);
    return [...new Set(nodes)].length === 1 ? nodes[0] : null;
  }

  function editorText(editor) { return editor ? ("value" in editor ? editor.value : editor.textContent || "") : ""; }
  function isConversation() { return /^\/(i\/chat|messages)\/[^/]+/.test(location.pathname); }
  function isReplyRoute() {
    return location.pathname === "/compose/post" || /^\/[^/]+\/status\/\d+\/?$/.test(location.pathname) || hasVisibleReplyDialog();
  }
  function hasVisibleReplyDialog() {
    const selector = '[data-testid^="tweetTextarea_"][contenteditable="true"][role="textbox"]';
    return [...document.querySelectorAll(selector)].some((editor) => visible(editor) && editor.closest('[role="dialog"]'));
  }
  function visible(node) { return node.getClientRects().length && !node.closest('[aria-hidden="true"]'); }
  function readContext() {
    if (isConversation()) {
      const editor = findDmEditor();
      if (!editor) throw new Error("读取失败：没有找到唯一的私信输入框");
      const messages = readConversation(editor);
      if (!messages.length) throw new Error("读取失败：没有读到当前私信消息");
      return { kind: "direct-message", messages, editor, target: editor.closest('[data-testid="DMConversation"], [data-testid="DmActivityViewport"]') };
    }
    if (!isReplyRoute()) throw new Error("请点击帖子的回复按钮打开回复弹窗，或打开具体私信会话");
    // A single reply modal can have several nested dialog wrappers. Identify the
    // editing surface first; counting all role=dialog nodes rejects that surface.
    const editors = [...document.querySelectorAll('[data-testid^="tweetTextarea_"][contenteditable="true"][role="textbox"]')]
      .filter(node => visible(node) && node.closest('[role="dialog"]'));
    if (!editors.length) throw new Error("读取失败：没有找到弹窗内的回复输入框，请保持帖子回复弹窗打开");
    if (editors.length !== 1) throw new Error("读取失败：检测到多个回复输入框，无法确定回复目标");
    const editor = editors[0];
    let dialog = editor.closest('[role="dialog"]');
    while (dialog.parentElement?.closest('[role="dialog"]')) dialog = dialog.parentElement.closest('[role="dialog"]');
    const posts = [...dialog.querySelectorAll('[data-testid="tweet"]')].filter(visible);
    if (posts.length !== 1 || !(posts[0].compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING) || posts[0].contains(editor)) throw new Error("读取失败：无法确定回复目标；不支持普通发帖、引用帖或多目标弹窗");
    const target = posts[0];
    const texts = [...target.querySelectorAll('[data-testid="tweetText"]')].filter(visible);
    if (texts.length !== 1) throw new Error("读取失败：目标帖子必须有唯一的可见正文；不支持纯图片或多正文帖子");
    const text = texts[0].innerText || texts[0].textContent || "";
    if (!text.trim() || text.length > 800) throw new Error("读取失败：目标帖子正文为空或超过 800 字符，未截取部分内容");
    // X reply previews can expose text without a status link. Bind to the
    // validated live modal/target/editor instead of requiring an unavailable ID.
    // Links are snapshot metadata only, never an alternate source of post text.
    const targetLinks = [...target.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
    return { kind: "public-reply", messages: [{ role: "them", text: text.trim() }], editor, target, dialog, textNode: texts[0], targetLinks };
  }
  function contextKey(context) { return JSON.stringify({ kind: context.kind, messages: context.messages, targetLinks: context.targetLinks }); }
  function sourceIsCurrent(expectedDraft = source?.draft) {
    if (!source || source.url !== location.href) return false;
    try { const context = readContext(); return source.key === contextKey(context) && source.editor === context.editor && source.target === context.target && source.dialog === context.dialog && source.textNode === context.textNode && expectedDraft === editorText(context.editor); }
    catch { return false; } // Caller reports stale/invalid context and stops all filling.
  }
  function invalidate(message, error = true) { generation++; clearTimeout(pendingFill?.timer); pendingFill = null; clearPendingLike(true); source = null; autoLikeAfterReply = false; autoLikeSettingResolved = false; state = { candidates: [], decision: null, mode: "" }; setGenerating(false); renderCandidates(); setStatus(message, error); }

  function setGenerating(busy) {
    const button = panel.querySelector('[data-action="generate"]');
    button.disabled = busy || !!pendingFill;
    button.textContent = busy ? "生成中，请稍候…" : "生成并填入回复";
    panel.setAttribute("aria-busy", String(busy || !!pendingFill));
  }

  function setStatus(text, error = false) { const element = panel.querySelector('[data-role="status"]'); element.textContent = text; element.classList.toggle("error", error); diagnostics.hidden = !error; }

  async function copyDiagnostics() {
    // Structural metadata only: no text, HTML, status IDs, URLs, draft or credentials.
    const selector = '[data-testid^="tweetTextarea_"][contenteditable="true"][role="textbox"]';
    const summary = node => ({ tag: node.tagName, role: node.getAttribute("role"),
      testId: /^(tweet|tweetText|sheetDialog|tweetTextarea_\d+)$/.test(node.getAttribute("data-testid") || "") ? node.getAttribute("data-testid") : null,
      ariaModal: node.getAttribute("aria-modal"), ariaHidden: node.getAttribute("aria-hidden"),
      hasRects: !!node.getClientRects().length, visible: !!visible(node) });
    const allDialogs = [...document.querySelectorAll('[role="dialog"]')];
    const allEditors = [...document.querySelectorAll(selector)];
    const result = { schema: "quick-reply.dom.v1", version: VERSION,
      route: location.pathname === "/compose/post" ? "composer" : isConversation() ? "direct-message" : isReplyRoute() ? "status" : "other",
      dialogCount: allDialogs.length, editorCount: allEditors.length,
      eligibleEditorCount: allEditors.filter(node => visible(node) && node.closest('[role="dialog"]')).length,
      dialogs: allDialogs.slice(0, 12).map(node => ({ ...summary(node), editors: node.querySelectorAll(selector).length,
        visibleEditors: [...node.querySelectorAll(selector)].filter(visible).length,
        visibleTweets: [...node.querySelectorAll('[data-testid="tweet"]')].filter(visible).length,
        visibleTexts: [...node.querySelectorAll('[data-testid="tweetText"]')].filter(visible).length,
        tweets: node.querySelectorAll('[data-testid="tweet"]').length, texts: node.querySelectorAll('[data-testid="tweetText"]').length,
        statusLinks: node.querySelectorAll('a[href*="/status/"]').length })),
      editors: allEditors.slice(0, 6).map(node => { const ancestors = []; for (let parent = node.parentElement; parent && ancestors.length < 12; parent = parent.parentElement) ancestors.push(summary(parent));
        let boundary = node.closest('[role="dialog"]');
        while (boundary?.parentElement?.closest('[role="dialog"]')) boundary = boundary.parentElement.closest('[role="dialog"]');
        return { ...summary(node), nearestDialogIndex: allDialogs.indexOf(node.closest('[role="dialog"]')), boundaryDialogIndex: allDialogs.indexOf(boundary), ancestors }; }) };
    try {
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
      setStatus("排查信息已复制，可粘贴反馈；不包含帖子或草稿正文。");
    } catch (error) { setStatus(`复制排查信息失败：${error.message}`, true); }
  }
  function observeUrlChanges() {
    let href = location.href;
    const sync = () => {
      if (href !== location.href) {
        const hadWork = source !== null;
        href = location.href;
        dismissed = false;
        // X commonly closes the reply modal and changes back to the timeline
        // immediately after a successful send. Preserve the one-shot like
        // confirmation across that expected transition; the target is still
        // checked by node identity or its captured status ID before clicking.
        if (pendingLike) {
          pendingLike.source.url = location.href;
        } else {
          invalidate(hadWork ? "页面已切换，旧回复已停止。请点击下方按钮重新生成。" : READY_TEXT, hadWork);
        }
      }
      panel.hidden = dismissed || !(isConversation() || (isReplyRoute() && [...document.querySelectorAll('[role="dialog"]')].some(visible)));
    };
    sync();
    return setInterval(sync, 500);
  }
  return { ok: true, version: VERSION };
  } catch (error) {
    if (isInvalidContext(error)) return { ok: false, version: VERSION, error: INVALID_CONTEXT_TEXT };
    return { ok: false, version: VERSION, error: `页面脚本初始化失败：${error instanceof Error ? error.message : String(error)}` };
  }
})();
