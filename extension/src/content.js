(() => {
  const VERSION = "0.3.0";
  const INVALID_CONTEXT_TEXT = "插件连接已失效。请刷新 X 页面，再重新打开回复弹窗并生成。";
  function isInvalidContext(error) { return /^Extension context invalidated\.?$/i.test(error?.message || ""); }
  const READY_TEXT = "点击下方按钮，生成回复并填入输入框。";
  const RUNTIME_KEY = "__xQuickReplyRuntime";
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
    // Framework notifications for the exact expected text do not transfer
    // ownership. Any actual user input or different text invalidates it.
    if (!event.isTrusted && editorText(source.editor) === (pendingFill?.text ?? source.draft)) return;
    invalidate("草稿已变化，请重新生成");
  };
  document.addEventListener("input", onInput, true);
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
    panel.removeEventListener("click", onClick);
    document.removeEventListener("input", onInput, true);
    panel.remove();
  } };

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
      source = { url: location.href, key: contextKey(context), editor: context.editor, target: context.target, dialog: context.dialog, textNode: context.textNode, draft: editorText(context.editor) };
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
    state = { candidates: response.candidates, decision: response.decision, selectedId: response.decision.selectedId, mode: response.mode };
    renderCandidates();
    if (state.decision.reviewRequired) return setStatus("百炼未选择合适回复，请人工起草", true);
    setStatus("已生成，百炼已选择候选");
    fillSelected();
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
      setStatus("已回填输入框，可切换候选后再次回填；请检查后手动发送");
    }, 150);
  }

  function findDmEditor() {
    const nodes = [...document.querySelectorAll('[data-testid="dmComposerTextInput"], [data-testid="DmActivityViewport"] [contenteditable="true"][role="textbox"], [data-testid="DMConversation"] [contenteditable="true"][role="textbox"]')]
      .map((node) => node.matches('[contenteditable="true"], textarea, input') ? node : node.querySelector('[contenteditable="true"], textarea, input'))
      .filter((node) => node && node.getClientRects().length);
    return [...new Set(nodes)].length === 1 ? nodes[0] : null;
  }

  function editorText(editor) { return editor ? ("value" in editor ? editor.value : editor.textContent || "") : ""; }
  function isConversation() { return /^\/(i\/chat|messages)\/[^/]+/.test(location.pathname); }
  function isReplyRoute() { return location.pathname === "/compose/post" || /^\/[^/]+\/status\/\d+\/?$/.test(location.pathname); }
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
  function invalidate(message, error = true) { generation++; clearTimeout(pendingFill?.timer); pendingFill = null; source = null; state = { candidates: [], decision: null, mode: "" }; setGenerating(false); renderCandidates(); setStatus(message, error); }

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
        invalidate(hadWork ? "页面已切换，旧回复已停止。请点击下方按钮重新生成。" : READY_TEXT, hadWork);
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
