(() => {
  const VERSION = "0.6.0";
  const INVALID_CONTEXT_TEXT = "插件连接已失效。请刷新 X 页面，再重新打开回复弹窗并生成。";
  function isInvalidContext(error) { return /^Extension context invalidated\.?$/i.test(error?.message || ""); }
  const READY_TEXT = "点击下方按钮，生成回复并填入输入框。";
  const RUNTIME_KEY = "__xQuickReplyRuntime";
  const PENDING_LIKE_KEY = "__xQuickReplyPendingLike.v1";
  const PENDING_LIKE_MAX_AGE = 30000;
  const LIKE_DELAY_MIN_MS = 1500;
  const LIKE_DELAY_MAX_MS = 4000;
  const SEND_CONFIRMATION_TIMEOUT_MS = 5000;
  const LIKE_TARGET_TIMEOUT_MS = 5000;
  const AUTO_TRIGGER_WINDOW_MS = 5000;
  const COUNTDOWN_TICK_MS = 250;
  const COUNTDOWN_INVALID_TEXT = "一键回复倒计时设置无效（需 3–60 秒整数），请重新保存扩展设置";
  try {
  if (!globalThis.React || !globalThis.ReactDOM) throw new Error("React runtime 未加载，无法初始化快速回复面板");
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
  let pendingSend = null;
  let sendConfirmation = null;
  let autoTrigger = null;
  let autoTriggerRead = 0;
  let countdown = null;
  let panelMount = null;
  // quick-post: draft cache is owned by the service worker; these are views.
  let postCache = [];
  let postBatch = null;
  let postFilledId = null;
  let ui = { status: READY_TEXT, statusError: false, generating: false, routeHidden: false, countdown: null };
  const autoLike = createAutoLikeController({
    getSource: () => source,
    readContext,
    isReplyRoute,
    setStatus,
    onSendConfirmed: releaseSentReply
  });

  // A DOM node is not evidence that this extension context has a live listener.
  document.getElementById(PANEL_ID)?.remove();
  document.getElementById(`${PANEL_ID}-mount`)?.remove();
  panelMount = document.createElement("div");
  panelMount.id = "quick-reply-panel-mount";
  document.body.appendChild(panelMount);
  renderPanel();
  const onInput = (event) => {
    if (inserting || !source?.editor.contains(event.target)) return;
    // Sending a reply can clear the controlled editor and emit an input event;
    // keep the send confirmation alive while the one-shot like operation runs.
    if (autoLike.isPending()) return;
    // Framework notifications for the exact expected text do not transfer
    // ownership. Any actual user input or different text invalidates it.
    if (!event.isTrusted && editorText(source.editor) === (pendingFill?.text ?? source.draft)) return;
    invalidate(countdown ? "已取消自动发送（草稿被修改），未发送；请手动检查后发送" : "草稿已变化，请重新生成");
  };
  document.addEventListener("input", onInput, true);
  const onDocumentClick = (event) => {
    autoLike.captureReplyLaunch(event.target);
    captureAutoTrigger(event);
    autoLike.handleSendClick(event.target);
  };
  document.addEventListener("click", onDocumentClick, true);
  const onMessage = (message, _sender, sendResponse) => {
    const type = message?.type;
    if (type !== "OPEN_QUICK_REPLY" && type !== "OPEN_QUICK_POST") return;
    dismissed = false;
    ui.routeHidden = false;
    renderPanel();
    try {
      if (type === "OPEN_QUICK_POST") {
        // 发帖是独立入口：只在发帖场景打开发帖面板，不与回复混用。
        if (!isComposeScene()) throw new Error("请先打开发帖弹窗或 /compose/post，再点击“发帖助手”");
        readComposeContext();
        loadPostCache();
        setStatus(`已识别发帖框。点击“生成新一批”，从 xzhishu 热榜取话题并生成帖文。`);
      } else {
        if (isComposeScene()) throw new Error("当前是发帖场景，回复面板不可用；请点击工具栏的“发帖助手”");
        readContext();
        setStatus(`已识别当前回复目标。${READY_TEXT}`);
      }
      sendResponse({ ok: true, version: VERSION });
    } catch (error) { setStatus(error.message, true); sendResponse({ ok: false, error: error.message }); }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  const timer = observeUrlChanges();
  globalThis[RUNTIME_KEY] = { version: VERSION, onMessage, dispose() {
    generation++;
    clearTimeout(pendingFill?.timer);
    pendingFill = null;
    pendingSend = null;
    autoTrigger = null;
    clearCountdown();
    clearSendConfirmation();
    clearInterval(timer);
    autoLike.dispose();
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("click", onDocumentClick, true);
    ReactDOM.unmountComponentAtNode(panelMount);
    panelMount.remove();
  } };
  autoLike.restore();

  /**
   * One-click auto trigger: only a trusted click on X's own reply control may
   * start an automatic send. The setting is read fresh for every click so that
   * turning the switch off takes effect immediately.
   */
  function captureAutoTrigger(event) {
    if (!event.isTrusted || isConversation()) return;
    const replyButton = event.target instanceof Element ? event.target.closest('[data-testid="reply"]') : null;
    if (!replyButton?.closest('[data-testid="tweet"]')) return;
    const read = ++autoTriggerRead;
    autoTrigger = null;
    Promise.resolve().then(() => {
      // StorageArea methods must keep their receiver.
      const storage = chrome.storage?.local;
      if (!storage || typeof storage.get !== "function") throw new Error("chrome.storage.local.get 不可用");
      return storage.get({ oneClickReply: false, oneClickCountdownSeconds: 10 });
    }).then((settings) => {
      if (read !== autoTriggerRead) return;
      if (typeof settings.oneClickReply !== "boolean") return setStatus("一键回复开关设置无效，请重新保存扩展设置", true);
      if (!settings.oneClickReply) return;
      if (!isValidCountdownSeconds(settings.oneClickCountdownSeconds)) return setStatus(COUNTDOWN_INVALID_TEXT, true);
      autoTrigger = { deadline: Date.now() + AUTO_TRIGGER_WINDOW_MS };
      consumeAutoTrigger();
    }).catch((error) => {
      if (read !== autoTriggerRead) return;
      if (isInvalidContext(error)) return setStatus(INVALID_CONTEXT_TEXT, true);
      setStatus(`读取一键回复设置失败：${error.message}`, true);
    });
  }

  // Consumed at most once, when the reply dialog opened by that click appears.
  function consumeAutoTrigger() {
    if (!autoTrigger) return;
    if (Date.now() > autoTrigger.deadline) { autoTrigger = null; return; }
    if (!hasVisibleReplyDialog()) return;
    autoTrigger = null;
    // An unfinished reply keeps ownership of the panel; a new click never preempts it.
    if (ui.generating || pendingFill || countdown || sendConfirmation || autoLike.isPending()) {
      return setStatus("上一条回复仍在处理中，本次未自动生成；请等待完成后重新打开回复", true);
    }
    dismissed = false;
    generate({ trigger: "auto" });
  }

  function isValidCountdownSeconds(value) {
    return Number.isInteger(value) && value >= 3 && value <= 60;
  }

  function renderPanel() {
    if (!panelMount) return;
    // React 只负责插件自己的面板；X 的帖子和编辑器仍由下方业务逻辑直接读取。
    ReactDOM.render(React.createElement(QuickReplyPanel, {
      version: VERSION,
      status: ui.status,
      statusError: ui.statusError,
      generating: ui.generating,
      hidden: dismissed || ui.routeHidden,
      panelKind: isComposeScene() ? "post" : "reply",
      candidates: state.candidates,
      selectedId: state.selectedId,
      decision: state.decision,
      pendingFill: !!pendingFill,
      postCache: postCache,
      postBatch: postBatch,
      postFilledId: postFilledId,
      countdown: ui.countdown,
      sending: !!sendConfirmation,
      onAction: handlePanelAction,
      onCandidateSelect: selectCandidate
    }), panelMount);
  }

  function handlePanelAction(action, argument) {
    switch (action) {
      case "close":
        dismissed = true;
        invalidate(countdown ? "已取消自动发送（面板已关闭），未发送；请手动检查后发送" : "面板已关闭，旧请求已取消", !countdown);
        break;
      case "generate":
        generate();
        break;
      case "fill":
        fillSelected();
        break;
      case "send-now":
        sendCountdownNow();
        break;
      case "cancel-send":
        cancelCountdown();
        break;
      case "diagnostics":
        copyDiagnostics();
        break;
      case "post-batch":
        generateBatch();
        break;
      case "post-fill":
        fillPostItem(argument);
        break;
      case "post-unmark":
        postCacheOp("unmark", argument);
        break;
      case "post-delete":
        postCacheOp("delete", argument);
        break;
      case "post-clear":
        postCacheOp("clear");
        break;
      default:
        throw new Error(`未知面板操作：${action}`);
    }
  }

  function selectCandidate(candidateId) {
    if (state.decision?.reviewRequired || pendingFill || sendConfirmation) return;
    if (countdown) {
      if (candidateId === state.selectedId) return;
      // Choosing another candidate during the countdown confirms it: replace
      // the unchanged plugin draft, verify, then send once without a new countdown.
      clearCountdown();
      state.selectedId = candidateId;
      renderPanel();
      return fillSelected({ send: { mode: "immediate" } });
    }
    state.selectedId = candidateId;
    renderPanel();
  }

  function QuickReplyPanel(props) {
    const h = React.createElement;
    const reviewRequired = props.decision?.reviewRequired === true;
    const fillHidden = !props.selectedId || reviewRequired || !!props.countdown;
    const fillDisabled = !props.selectedId || reviewRequired || props.pendingFill;
    const candidateNodes = props.candidates.map(candidate => h(
      "button",
      { key: candidate.id, type: "button", className: `qr-candidate ${candidate.id === props.selectedId ? "selected" : ""}`,
        "data-candidate": candidate.id, disabled: reviewRequired || props.pendingFill || props.sending,
        onClick: () => props.onCandidateSelect(candidate.id) },
      h("span", null, candidate.text),
      candidate.id === props.decision?.selectedId ? h("em", null, "百炼选中") : null
    ));
    if (props.decision) candidateNodes.push(h(
      "div",
      { key: "reason", className: "qr-reason" },
      `选择置信度：${(props.decision.confidence * 100).toFixed(1)}%（不代表回复正确率）`
    ));
    const postMode = props.panelKind === "post";
    const cacheNodes = props.postCache.map(item => h(
      "div", { key: item.id, className: `qr-cache-item${item.usedAt ? " used" : ""}`, "data-cache-item": item.id },
      h("div", { className: "qr-cache-text" }, item.text),
      item.checkNotes.length ? h("div", { className: "qr-cache-check" }, item.checkNotes.join("；")) : null,
      h("div", { className: "qr-cache-meta" },
        `${item.sourceTopic.title} · ${new Date(item.createdAt).toLocaleString()}${item.usedAt ? " · 已发过" : ""}${item.sessionOnly ? " · 未入缓存" : ""}`),
      h("div", { className: "qr-cache-actions" },
        item.usedAt
          ? h("button", { type: "button", "data-action": "post-unmark", disabled: props.pendingFill,
              onClick: () => props.onAction("post-unmark", item.id) }, "放回可选")
          : h("button", { type: "button", className: "qr-fill", "data-action": "post-fill", disabled: props.pendingFill,
              onClick: () => props.onAction("post-fill", item.id) }, "填入发帖框"),
        h("button", { type: "button", "data-action": "post-delete", disabled: props.pendingFill,
          onClick: () => props.onAction("post-delete", item.id) }, "删除")
      )
    ));
    return h("aside", { id: PANEL_ID, hidden: props.hidden, "aria-busy": String(props.generating || props.pendingFill) },
      h("div", { className: "qr-header" },
        h("strong", null, `${postMode ? "快速发帖" : "快速回复"} · ${props.version}`),
        h("button", { type: "button", title: "关闭", "data-action": "close", onClick: () => props.onAction("close") }, "×")
      ),
      h("div", { className: `qr-status${props.statusError ? " error" : ""}`, "data-role": "status", role: "status" }, props.status),
      postMode ? h(React.Fragment, null,
        h("button", { type: "button", className: "qr-primary", "data-action": "post-batch", disabled: props.generating || props.pendingFill,
          onClick: () => props.onAction("post-batch") }, props.generating ? "生成中，请稍候…" : "生成新一批（热榜 5 选 1）"),
        props.postBatch?.selectedTopic ? h("div", { className: "qr-reason" },
          `本批话题：${props.postBatch.selectedTopic.title}（决策选定）${props.postBatch.evicted ? ` · 已自动清理 ${props.postBatch.evicted} 条` : ""}`) : null,
        h("div", { className: "qr-cache-head" },
          h("span", null, `候选缓存池 · ${props.postCache.length} 条`),
          h("button", { type: "button", "data-action": "post-clear", disabled: props.pendingFill || !props.postCache.length,
            onClick: () => props.onAction("post-clear") }, "清空缓存")
        ),
        h("div", { className: "qr-candidates", "data-role": "cache" }, cacheNodes.length ? cacheNodes : h("div", { className: "qr-reason" }, "暂无缓存候选。生成新一批后，未使用的候选会保留到下次。"))
      ) : h(React.Fragment, null,
        h("button", { type: "button", className: "qr-primary", "data-action": "generate",
          disabled: props.generating || props.pendingFill || !!props.countdown || props.sending,
          onClick: () => props.onAction("generate") }, props.generating ? "生成中，请稍候…" : "生成并填入回复"),
        props.countdown ? h("div", { className: "qr-countdown", "data-role": "countdown" },
          h("div", { className: "qr-countdown-head" },
            h("span", null, "即将发送公开回复"),
            h("strong", { "data-role": "countdown-seconds" }, String(props.countdown.seconds))),
          h("div", { className: "qr-countdown-bar" }, h("i", { style: { width: `${props.countdown.progress * 100}%` } })),
          h("div", { className: "qr-countdown-text" }, props.countdown.text),
          h("small", null, "点击其他候选会替换并立即发送"),
          h("div", { className: "qr-countdown-actions" },
            h("button", { type: "button", className: "qr-send-now", "data-action": "send-now", onClick: () => props.onAction("send-now") }, "立即发送"),
            h("button", { type: "button", className: "qr-cancel-send", "data-action": "cancel-send", onClick: () => props.onAction("cancel-send") }, "取消发送"))
        ) : null,
        h("div", { className: "qr-candidates", "data-role": "candidates" }, candidateNodes),
        h("button", { type: "button", className: "qr-fill", "data-action": "fill", hidden: fillHidden, disabled: fillDisabled,
          onClick: () => props.onAction("fill") }, "回填输入框")
      ),
      h("button", { type: "button", className: "qr-diagnostics", "data-action": "diagnostics", hidden: !props.statusError,
        onClick: () => props.onAction("diagnostics") }, "复制排查信息")
    );
  }

  async function generate({ trigger = "manual" } = {}) {
    if (pendingFill || countdown || sendConfirmation) return;
    const current = ++generation;
    source = null;
    state = { candidates: [], decision: null, mode: "" };
    renderPanel();
    let response;
    try {
      const context = autoLike.enrichContext(readContext());
      if (editorText(context.editor).trim()) throw new Error("输入框已有草稿，请处理草稿后重新生成");
      source = { url: location.href, kind: context.kind, key: contextKey(context), editor: context.editor,
        target: context.target, dialog: context.dialog, textNode: context.textNode, targetLinks: context.targetLinks,
        draft: editorText(context.editor) };
      setGenerating(true);
      setStatus(trigger === "auto" ? "已打开回复，正在自动生成回复并选择合适内容…" : "正在生成回复并选择合适内容，请稍候…");
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
    autoLike.configure(response.autoLikeAfterReply === true);
    // Only the trusted reply-button trigger sends; the panel button always fills only.
    const autoSend = trigger === "auto" && response.oneClickReply === true && source.kind === "public-reply";
    if (autoSend && !isValidCountdownSeconds(response.oneClickCountdownSeconds)) return setStatus(COUNTDOWN_INVALID_TEXT, true);
    state = { candidates: response.candidates, decision: response.decision, selectedId: response.decision.selectedId, mode: response.mode };
    renderPanel();
    if (state.decision.reviewRequired) return setStatus(autoSend ? "百炼未选择合适回复，未发送，请人工起草" : "百炼未选择合适回复，请人工起草", true);
    setStatus("已生成，百炼已选择候选");
    fillSelected({ send: autoSend ? { mode: "countdown", seconds: response.oneClickCountdownSeconds } : null });
  }

  // ---- quick-post batch flow: topics fetch -> decision -> 5 posts -> cache ----

  async function generateBatch() {
    if (pendingFill) return;
    const current = ++generation;
    source = null;
    renderPanel();
    let response;
    try {
      const context = readComposeContext();
      if (editorText(context.editor).trim()) throw new Error("发帖框已有草稿，请处理草稿后重新生成");
      source = { url: location.href, kind: "original-post", key: contextKey(context), editor: context.editor,
        target: context.target, dialog: context.dialog, textNode: null, targetLinks: [],
        draft: editorText(context.editor) };
      setGenerating(true);
      setStatus("正在获取热榜话题、决策并生成帖文，请稍候…");
      response = await chrome.runtime.sendMessage({ type: "GENERATE_POST_BATCH" });
    } catch (error) {
      if (current !== generation) return;
      if (isInvalidContext(error)) return invalidate(INVALID_CONTEXT_TEXT);
      return setStatus(error instanceof Error ? error.message : "生成失败", true);
    } finally {
      if (current === generation) setGenerating(false);
    }
    if (current !== generation) return;
    if (!sourceIsCurrent()) return setStatus("发帖框已变化，请重新生成", true);
    if (!response?.ok) return setStatus(response?.error || "生成失败", true);
    if (response.rejected) {
      postBatch = null;
      renderPanel();
      return setStatus("决策拒选：5 条话题均不合适（__none__），未生成帖文；可稍后重新生成", true);
    }
    postBatch = { selectedTopic: response.selectedTopic, evicted: response.evicted };
    if (response.cacheError) {
      // The batch is usable this session but must never be presented as cached.
      postCache = response.candidates.map((candidate) => ({ id: candidate.id, text: candidate.text,
        checkNotes: candidate.checkNotes, sourceTopic: response.selectedTopic, batchId: "session",
        createdAt: Date.now(), sessionOnly: true }));
      renderPanel();
      return setStatus(`${response.cacheError}。本批候选仅本次可用（标注“未入缓存”），填入后不保留到下次`, true);
    }
    postCache = response.cache;
    let text = `本批话题：${response.selectedTopic.title}（决策选定）。已生成 ${response.candidates.length} 条帖文并入缓存池（共 ${response.cache.length} 条），每次选 1 条填入。`;
    if (response.evicted) text += ` 缓存已满，已自动清理 ${response.evicted} 条（先已发过的，再最旧的）。`;
    setStatus(text);
    renderPanel();
  }

  function ensurePostSource() {
    if (source?.kind === "original-post" && sourceIsCurrent()) return true;
    try {
      const context = readComposeContext();
      if (editorText(context.editor).trim()) return false; // Never overwrite a non-empty draft.
      source = { url: location.href, kind: "original-post", key: contextKey(context), editor: context.editor,
        target: context.target, dialog: context.dialog, textNode: null, targetLinks: [], draft: "" };
      return true;
    } catch {
      return false;
    }
  }

  async function fillPostItem(itemId) {
    const item = postCache.find((entry) => entry.id === itemId);
    if (!item) return setStatus("缓存条目不存在", true);
    if (item.usedAt) return setStatus("该条已标记“已发过”，可点“放回可选”后再使用", true);
    if (pendingFill) return;
    if (!ensurePostSource()) return setStatus("发帖框已有草稿或目标变化；请处理草稿后重试", true);
    if (source.owned && source.draft === item.text) return setStatus("已填入此条，无需重复填入；请检查后手动点击发帖");
    return fillCandidate(item);
  }

  async function onPostFilled(item) {
    if (item.sessionOnly) {
      postFilledId = item.id;
      renderPanel();
      return;
    }
    try {
      if (postFilledId && postFilledId !== item.id) {
        const restored = await chrome.runtime.sendMessage({ type: "POST_CACHE_OP", op: "unmark", id: postFilledId });
        if (!restored?.ok) throw new Error(restored?.error || "放回候选失败");
      }
      const marked = await chrome.runtime.sendMessage({ type: "POST_CACHE_OP", op: "mark", id: item.id });
      if (!marked?.ok) throw new Error(marked?.error || "标记候选失败");
      postFilledId = item.id;
      postCache = marked.items;
    } catch (error) {
      return setStatus(`候选计账失败：${error instanceof Error ? error.message : error}；草稿已填入，请自行核对`, true);
    }
    renderPanel();
  }

  async function postCacheOp(op, id) {
    if (pendingFill) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: "POST_CACHE_OP", op, id });
      if (!response?.ok) throw new Error(response?.error || "缓存操作失败");
      postCache = response.items;
      if (op === "clear") postFilledId = null;
      if (op === "unmark" && postFilledId === id) postFilledId = null;
      if (op === "delete" && postFilledId === id) postFilledId = null;
      renderPanel();
      setStatus(op === "clear" ? "已清空候选缓存池" : op === "delete" ? "已删除 1 条缓存候选" : "已放回可选列表（草稿文本仍留在发帖框，由你处理）");
    } catch (error) {
      return setStatus(`缓存操作失败：${error instanceof Error ? error.message : error}`, true);
    }
  }

  async function loadPostCache() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "LIST_POST_CACHE" });
      if (!response?.ok) throw new Error(response?.error || "缓存读取失败");
      postCache = response.items;
      setStatus(`发帖模式：从 xzhishu 热榜取 5 条话题、决策定 1 条，生成帖文入缓存池。当前缓存 ${postCache.length} 条，每次选 1 条填入，发帖由你人工点击。`);
    } catch (error) {
      return setStatus(error instanceof Error ? error.message : "缓存读取失败", true);
    }
    renderPanel();
  }

  /**
   * Owns the one-shot send -> original post -> like workflow.
   * The host only supplies context reading and status reporting; DOM polling,
   * navigation persistence, and like-state verification stay inside this module.
   */
  function createAutoLikeController({ getSource, readContext, isReplyRoute, setStatus, onSendConfirmed }) {
    let enabled = false;
    let settingResolved = false;
    let operation = null;
    let replyLaunch = null;

    function log(stage, details = {}) {
      // 调试日志按用户授权输出原始链接，其他业务数据仍不写入日志。
      console.info("[x-quick-reply][auto-like]", stage, details);
    }

    return {
      configure,
      isEnabled: () => enabled,
      isPending: () => !!operation,
      captureReplyLaunch,
      enrichContext,
      handleSendClick,
      restore,
      handleRouteChange,
      cancel: (removeMarker = false) => clearOperation(removeMarker),
      dispose: () => clearOperation()
    };

    function captureReplyLaunch(node) {
      const replyButton = node instanceof Element ? node.closest('[data-testid="reply"]') : null;
      const tweet = replyButton?.closest('[data-testid="tweet"]');
      if (!tweet) return;
      const statusUrl = [...tweet.querySelectorAll('a[href]')].map((anchor) => anchor.getAttribute("href"))
        .map(canonicalStatusUrl).find(Boolean);
      if (!statusUrl) return;
      replyLaunch = { statusUrl, capturedAt: Date.now() };
      log("reply-launch-captured", { statusUrl });
    }

    function enrichContext(context) {
      if (context.kind !== "public-reply" || !replyLaunch?.statusUrl) return context;
      return { ...context, targetLinks: [...new Set([...(context.targetLinks || []), replyLaunch.statusUrl])] };
    }

    function configure(value) {
      enabled = value === true;
      // The worker response is the current saved snapshot for this generation.
      // Mark it resolved before the synthetic send click so one-click reply and
      // auto-like share exactly one confirmation workflow.
      settingResolved = true;
    }

    function handleSendClick(node) {
      const button = findSendButton(node);
      if (operation || !isReplyRoute() || !isEnabledSendButton(button)) return;
      log("send-click-captured", { settingResolved, enabled });
      const likeSource = resolveLikeSource(button);
      if (!likeSource) return;
      const targetLinks = likeSource.targetLinks || [];
      log("source-resolved", {
        sourceOwned: likeSource.owned === true,
        targetAttached: !!likeSource.target?.isConnected,
        targetLinkCount: targetLinks.length,
        statusLinkCount: targetLinks.filter((href) => !!statusIdFromHref(href)).length,
        canonicalStatusLinkCount: targetLinks.filter((href) => !!canonicalStatusUrl(href)).length,
        targetLinkHrefs: targetLinks,
        canonicalStatusLinks: targetLinks.map(canonicalStatusUrl).filter(Boolean)
      });
      if (settingResolved) return startIfEnabled(likeSource);

      // StorageArea methods must retain their receiver; calling get detached from
      // chrome.storage.local can fail in Chrome even when the method exists.
      const storage = chrome.storage?.local;
      if (!storage || typeof storage.get !== "function") {
        return setStatus("读取自动点赞设置失败：chrome.storage.local.get 不可用", true);
      }
      Promise.resolve(storage.get({ autoLikeAfterReply: false })).then((settings) => {
        settingResolved = true;
        if (typeof settings.autoLikeAfterReply !== "boolean") {
          return setStatus("自动点赞开关设置无效，请重新保存扩展设置", true);
        }
        enabled = settings.autoLikeAfterReply;
        log("setting-read", { enabled });
        startIfEnabled(likeSource);
      }).catch((error) => setStatus(`读取自动点赞设置失败：${error.message}`, true));
    }

    function resolveLikeSource(button) {
      const current = getSource();
      if (current?.owned && current.kind === "public-reply") {
        return current.dialog?.contains(button) ? current : null;
      }
      try {
        const context = readContext();
        if (context.kind !== "public-reply" || !context.dialog?.contains(button)) return null;
        const enriched = enrichContext(context);
        return { url: location.href, kind: enriched.kind, editor: enriched.editor, target: enriched.target,
          dialog: enriched.dialog, targetLinks: enriched.targetLinks };
      } catch {
        return null;
      }
    }

    function startIfEnabled(likeSource) {
      if (!enabled || likeSource.url !== location.href) {
        log("operation-skipped", { enabled, sameRoute: likeSource.url === location.href });
        return;
      }
      operation = { source: likeSource, clicked: false, sendConfirmed: false, targetLogged: false,
        likeLogged: false, confirmationDeadline: Date.now() + SEND_CONFIRMATION_TIMEOUT_MS,
        likeReadyAt: null, deadline: null, timer: null };
      log("operation-started", { confirmationTimeoutMs: SEND_CONFIRMATION_TIMEOUT_MS,
        likeDelayRangeMs: [LIKE_DELAY_MIN_MS, LIKE_DELAY_MAX_MS] });
      setStatus("已点击发送，正在确认回复并点赞原帖…");
      startChecking();
    }

    function restore() {
      let marker;
      try {
        const raw = sessionStorage.getItem(PENDING_LIKE_KEY);
        if (!raw) return;
        marker = JSON.parse(raw);
      } catch (error) {
        clearPendingLikeMarker();
        return setStatus(`读取原帖点赞任务失败：${error.message}`, true);
      }
      if (!marker || marker.schema !== "quick-reply.like.v1" || typeof marker.url !== "string"
        || !Number.isInteger(marker.createdAt) || Date.now() - marker.createdAt > PENDING_LIKE_MAX_AGE) {
        clearPendingLikeMarker();
        return;
      }
      const targetUrl = canonicalStatusUrl(marker.url);
      if (!targetUrl || statusIdFromHref(location.href) !== statusIdFromHref(targetUrl)) return;
      operation = { source: { url: location.href, kind: "public-reply", target: null, editor: null,
        targetLinks: [targetUrl] }, clicked: false, sendConfirmed: true, targetLogged: false,
        likeLogged: false, likeReadyAt: Date.now(), deadline: Date.now() + LIKE_TARGET_TIMEOUT_MS,
        timer: null, navigationStarted: true };
      log("operation-restored", { timeoutMs: LIKE_TARGET_TIMEOUT_MS });
      setStatus("已打开原帖，正在确认点赞按钮…");
      startChecking();
    }

    function handleRouteChange() {
      if (operation) operation.source.url = location.href;
    }

    function startChecking() {
      operation.timer = setInterval(check, 100);
      check();
    }

    function check() {
      const current = getSource();
      if (!operation || (current && operation.source !== current)) return clearOperation();
      const editorGone = !operation.source.editor?.isConnected;
      const editorCleared = operation.source.editor?.isConnected && !editorText(operation.source.editor).trim();
      // 清空或卸载编辑器才算页面确认发送；不能因为发送按钮被点击就提前点赞。
      if (!editorGone && !editorCleared) {
        if (Date.now() >= operation.confirmationDeadline) return finish(false, "发送未确认，未自动点赞；未重试");
        return;
      }
      if (!operation.sendConfirmed) {
        operation.sendConfirmed = true;
        const delayMs = randomLikeDelayMs();
        operation.likeReadyAt = Date.now() + delayMs;
        operation.deadline = operation.likeReadyAt + LIKE_TARGET_TIMEOUT_MS;
        log("reply-send-confirmed", { editorGone, editorCleared, delayMs, likeReadyAt: operation.likeReadyAt });
        onSendConfirmed();
        setStatus("回复已发送，稍后确认点赞原帖…");
      }
      // Keep a variable, human-like pause between the confirmed reply and the
      // like action. The target is resolved only after the pause so a missing
      // target cannot trigger an immediate navigation/click sequence.
      if (Date.now() < operation.likeReadyAt) return;
      const target = findLikeTarget(operation.source);
      const targetUrl = findTargetStatusUrl(operation.source);
      if (!targetUrl) return finish(false, "回复已发送，但没有可靠的原帖链接；未自动跳转或点赞");
      if (!target && !operation.navigationStarted) {
        log("target-not-in-current-page", { hasTargetLink: true });
        return navigateToTarget(targetUrl);
      }
      if (!target) {
        if (Date.now() >= operation.deadline) return finish(false, "已打开原帖，但未找到目标帖子；未自动重试");
        return;
      }
      if (!operation.targetLogged) {
        operation.targetLogged = true;
        log("target-found", { navigationStarted: !!operation.navigationStarted });
      }
      const like = findLikeButton(target);
      if (!like) {
        if (Date.now() >= operation.deadline) return finish(false, "已打开原帖，但未找到点赞按钮；未自动重试");
        return;
      }
      if (!operation.likeLogged) {
        operation.likeLogged = true;
        log("like-button-found", {
          dataTestId: like.getAttribute("data-testid"),
          ariaState: likeLabelState(like.getAttribute("aria-label")),
          alreadyLiked: isLiked(like)
        });
      }
      if (isLiked(like)) return finish(true, "回复已发送，目标帖子此前已点赞");
      if (!operation.clicked) {
        // 只允许点击一次；点击后必须从 DOM 状态确认已点赞。
        log("like-click-before", {
          dataTestId: like.getAttribute("data-testid"),
          ariaState: likeLabelState(like.getAttribute("aria-label"))
        });
        operation.clicked = true;
        like.click();
        log("like-click-dispatched", {
          dataTestId: like.getAttribute("data-testid"),
          ariaState: likeLabelState(like.getAttribute("aria-label")),
          liked: isLiked(like)
        });
      }
      if (isLiked(like)) return finish(true, "回复已发送，已自动点赞目标帖子");
      if (Date.now() >= operation.deadline) return finish(false, "已尝试点赞，但页面未确认成功；未自动重试");
    }

    function findLikeTarget(operationSource) {
      if (operationSource.target?.isConnected) return operationSource.target;
      const statusIds = [...new Set((operationSource.targetLinks || []).map(statusIdFromHref).filter(Boolean))];
      if (!statusIds.length) return null;
      return [...document.querySelectorAll('[data-testid="tweet"]')].find((post) =>
        statusIds.some((id) => [...post.querySelectorAll('a[href]')]
          .some((anchor) => statusIdFromHref(anchor.getAttribute("href")) === id)));
    }

    function findTargetStatusUrl(operationSource) {
      return (operationSource.targetLinks || []).map(canonicalStatusUrl).find(Boolean) || null;
    }

    function navigateToTarget(targetUrl) {
      operation.navigationStarted = true;
      try {
        // 完整导航会销毁当前 content script，先保存脱敏 URL 供原帖页恢复。
        sessionStorage.setItem(PENDING_LIKE_KEY, JSON.stringify({ schema: "quick-reply.like.v1",
          url: targetUrl, createdAt: Date.now() }));
        setStatus("回复已发送，正在打开原帖确认点赞…");
        location.assign(targetUrl);
        return true;
      } catch (error) {
        operation.navigationStarted = false;
        return finish(false, `打开原帖失败：${error.message}`);
      }
    }

    function findLikeButton(target) {
      const selector = '[data-testid="like"], [data-testid="unlike"], [data-testid*="like"], [aria-label], [role="button"]';
      return [...target.querySelectorAll(selector)].filter(isLikeControl)
        .find((button) => visible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true") || null;
    }

    function randomLikeDelayMs() {
      return LIKE_DELAY_MIN_MS + Math.floor(Math.random() * (LIKE_DELAY_MAX_MS - LIKE_DELAY_MIN_MS + 1));
    }

    function isLiked(button) {
      return button?.getAttribute("data-testid") === "unlike" || button?.getAttribute("aria-pressed") === "true"
        || ["liked", "取消喜欢", "已喜欢"].includes(likeLabelState(button?.getAttribute("aria-label")));
    }

    function isLikeControl(button) {
      const testId = button?.getAttribute("data-testid") || "";
      return /^(?:un)?like(?:button)?$/i.test(testId) || !!likeLabelState(button?.getAttribute("aria-label"));
    }

    function likeLabelState(label) {
      // 点赞数量可能位于 aria-label 前缀；只读取末尾状态词。
      const match = String(label || "").trim().match(/(?:^|[.。:：]\s*)(Like|Liked|喜欢|已喜欢|取消喜欢)\s*$/i);
      return match?.[1]?.toLowerCase() || null;
    }

    function findSendButton(node) {
      return node instanceof Element ? node.closest('[data-testid^="tweetButton"]') : null;
    }

    function isEnabledSendButton(button) {
      return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    }

    function statusIdFromHref(href) {
      return String(href || "").match(/\/status\/(\d+)(?:[/?#]|$)/)?.[1] || null;
    }

    function canonicalStatusUrl(href) {
      try {
        const url = new URL(href, location.origin);
        if (!["x.com", "twitter.com"].includes(url.hostname) || !statusIdFromHref(url.href)) return null;
        url.search = "";
        url.hash = "";
        return url.href;
      } catch {
        return null;
      }
    }

    function finish(success, message) {
      log("operation-finished", { success, message });
      clearOperation(true);
      setStatus(message, !success);
    }

    function clearOperation(removeMarker = false) {
      if (operation?.timer) clearInterval(operation.timer);
      if (removeMarker) clearPendingLikeMarker();
      operation = null;
    }

    function clearPendingLikeMarker() {
      try {
        sessionStorage.removeItem(PENDING_LIKE_KEY);
      } catch {
        // 清理失败不会伪造点赞成功；标记会在下次恢复时按时效校验。
      }
    }
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

  async function fillSelected({ send = null } = {}) {
    const selected = state.candidates.find((candidate) => candidate.id === state.selectedId);
    if (!selected) return setStatus("请先选择候选回复", true);
    return fillCandidate(selected, send);
  }

  async function fillCandidate(selected, send = null) {
    if (pendingFill) return;
    pendingSend = null;
    if (!sourceIsCurrent()) return invalidate("会话或草稿已变化，请重新生成");
    const editor = source.editor;
    if (!editor) return setStatus("没有找到消息输入框，请点击输入区域后重试", true);
    if (source.owned && source.draft === selected.text) return setStatus("已回填此候选，无需重复填入；请检查后手动发送");
    const operation = { source, text: selected.text, candidate: selected, timer: null };
    pendingSend = send;
    pendingFill = operation;
    renderPanel();
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
        const selectCurrentEditorContents = () => {
          const range = document.createRange();
          range.selectNodeContents(editor);
          selection.removeAllRanges(); selection.addRange(range);
        };
        selectCurrentEditorContents();
        // Let controlled editors observe the full replacement selection.
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        // Recreate the range after the controlled editor's synchronous update.
        selectCurrentEditorContents();
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        if (!sourceIsCurrent()) throw new Error("选择输入区域时目标或草稿发生变化");
        // Draft-style controlled editors keep the authoritative selection in
        // framework state. A synthetic key event lets them delete that
        // selection through their normal editing path before we paste the
        // replacement. Synthetic events have no browser default action, so a
        // missing handler is surfaced as a failure instead of silently
        // appending to the existing draft.
        const clear = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Backspace",
          code: "Backspace",
          which: 8,
          keyCode: 8
        });
        editor.dispatchEvent(clear);
        if (!clear.defaultPrevented) throw new Error("当前编辑器未接收清空事件");
        // Controlled editors commit the deletion in their framework update
        // after the key event returns. Wait for that render before checking
        // the cleared DOM or dispatching the replacement paste.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (editorText(editor) !== "") throw new Error("当前编辑器未清空输入框");
        selectCurrentEditorContents();
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
        const clipboard = new DataTransfer();
        clipboard.setData("text/plain", selected.text);
        const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard });
        editor.dispatchEvent(paste);
        // A synthetic paste has no native default insertion. The site's
        // editor must handle it once; never combine it with DOM mutation.
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
      const send = pendingSend;
      pendingSend = null;
      pendingFill = null;
      renderPanel();
      setGenerating(false);
      if (source.kind === "original-post") {
        setStatus("已填入发帖框草稿（未发送）；请检查后手动点击发帖按钮");
        onPostFilled(operation.candidate);
        return;
      }
      if (send?.mode === "countdown") return startCountdown(send.seconds);
      if (send?.mode === "immediate") return sendSelectedReply();
      setStatus(autoLike.isEnabled() && source.kind === "public-reply"
        ? "已回填输入框，可切换候选后再次回填；请检查后手动发送，发送成功后将打开原帖并自动点赞"
        : "已回填输入框，可切换候选后再次回填；请检查后手动发送");
    }, 150);
  }

  function sendSelectedReply() {
    if (!source || source.kind !== "public-reply") return setStatus("一键发送仅支持公开帖子回复，请手动发送", true);
    if (!sourceIsCurrent(source.draft)) return invalidate("一键发送前会话或草稿已变化，未发送");
    const buttons = [...(source.dialog?.querySelectorAll('[data-testid^="tweetButton"]') || [])]
      .filter(button => visible(button) && isEnabledSendButton(button));
    if (buttons.length !== 1) return invalidate(buttons.length
      ? "一键发送失败：检测到多个可用回复按钮，未发送"
      : "一键发送失败：没有找到可用回复按钮，未发送");
    try {
      setStatus("已通过核验，正在点击回复按钮…");
      buttons[0].click();
    } catch (error) {
      return invalidate(`一键发送失败：${error.message}`);
    }
    // When auto-like is enabled its existing controller owns the same send
    // confirmation and the post-send workflow. Do not create a second poller.
    if (autoLike.isPending()) return;
    startSendConfirmation();
  }

  function startCountdown(seconds) {
    clearCountdown();
    const total = seconds * 1000;
    countdown = { source, text: source.draft, total, deadline: Date.now() + total, timer: null };
    countdown.timer = setInterval(checkCountdown, COUNTDOWN_TICK_MS);
    checkCountdown();
  }

  // Hidden tabs keep counting against the deadline and still send when it passes.
  function checkCountdown() {
    if (!countdown) return;
    if (source !== countdown.source || !sourceIsCurrent(countdown.text)) {
      return invalidate("已取消自动发送（回复弹窗、目标或草稿已变化），未发送");
    }
    const remaining = countdown.deadline - Date.now();
    if (remaining <= 0) return sendCountdownNow();
    const seconds = Math.ceil(remaining / 1000);
    ui.countdown = { seconds, progress: remaining / countdown.total, text: countdown.text };
    setStatus(`将在 ${seconds} 秒后发送，可取消`);
  }

  function sendCountdownNow() {
    if (!countdown) return;
    clearCountdown();
    sendSelectedReply();
  }

  function cancelCountdown() {
    if (!countdown) return;
    clearCountdown();
    setStatus("已取消自动发送，草稿已保留，请手动检查后发送");
  }

  function clearCountdown() {
    if (countdown?.timer) clearInterval(countdown.timer);
    countdown = null;
    ui.countdown = null;
    renderPanel();
  }

  function startSendConfirmation() {
    clearSendConfirmation();
    sendConfirmation = { source, deadline: Date.now() + SEND_CONFIRMATION_TIMEOUT_MS, timer: null };
    setStatus("已点击回复，正在等待 X 确认发送…");
    sendConfirmation.timer = setInterval(checkSendConfirmation, 100);
    checkSendConfirmation();
  }

  function checkSendConfirmation() {
    if (!sendConfirmation) return;
    const editor = sendConfirmation.source?.editor;
    const confirmed = !editor?.isConnected || (editor.isConnected && !editorText(editor).trim());
    if (confirmed) {
      clearSendConfirmation();
      releaseSentReply();
      setStatus("回复已发送，页面已确认");
      return;
    }
    if (Date.now() >= sendConfirmation.deadline) {
      clearSendConfirmation();
      invalidate("一键发送未确认，草稿已保留，未自动重试");
    }
  }

  // A confirmed send completes this reply. Release it so later navigation is
  // not reported as interrupted work and the next reply starts from a clean state.
  function releaseSentReply() {
    generation++;
    source = null;
    state = { candidates: [], decision: null, mode: "" };
    renderPanel();
  }

  function clearSendConfirmation() {
    if (sendConfirmation?.timer) clearInterval(sendConfirmation.timer);
    sendConfirmation = null;
  }

  function isEnabledSendButton(button) {
    return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
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
  function hasVisibleComposeDialog() {
    return [...document.querySelectorAll('[role="dialog"]')].some((dialog) => {
      if (!visible(dialog)) return false;
      const editors = [...dialog.querySelectorAll('[data-testid^="tweetTextarea_"][contenteditable="true"][role="textbox"]')].filter(visible);
      const posts = [...dialog.querySelectorAll('[data-testid="tweet"]')].filter(visible);
      return editors.length >= 1 && posts.length === 0;
    });
  }
  function isComposeRoute() {
    return location.pathname === "/compose/post" || hasVisibleComposeDialog();
  }
  function hasVisibleTargetReplyDialog() {
    return [...document.querySelectorAll('[role="dialog"]')].some((dialog) => {
      if (!visible(dialog)) return false;
      const editors = [...dialog.querySelectorAll('[data-testid^="tweetTextarea_"][contenteditable="true"][role="textbox"]')].filter(visible);
      const posts = [...dialog.querySelectorAll('[data-testid="tweet"]')].filter(visible);
      return editors.length >= 1 && posts.length >= 1;
    });
  }
  function isComposeScene() {
    if (isConversation() || hasVisibleTargetReplyDialog()) return false;
    try { readComposeContext(); return true; } catch { return false; }
  }
  function visible(node) { return node.getClientRects().length && !node.closest('[aria-hidden="true"]'); }
  function readContext() {
    return isConversation() ? readDirectMessageContext() : readPublicReplyContext();
  }

  function readDirectMessageContext() {
    const editor = findDmEditor();
    if (!editor) throw new Error("读取失败：没有找到唯一的私信输入框");
    const messages = readConversation(editor);
    if (!messages.length) throw new Error("读取失败：没有读到当前私信消息");
    return { kind: "direct-message", messages, editor,
      target: editor.closest('[data-testid="DMConversation"], [data-testid="DmActivityViewport"]') };
  }

  function readPublicReplyContext() {
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
    // X reply previews can render the timestamp/status link outside the tweet
    // wrapper. The dialog has already been validated to contain exactly one
    // target tweet, so collect status links from that same dialog without using
    // the author profile link as a substitute.
    const targetLinks = [...new Set([
      ...target.querySelectorAll('a[href]'),
      ...dialog.querySelectorAll('a[href*="/status/"]')
    ])].map(a => a.getAttribute('href'));
    return { kind: "public-reply", messages: [{ role: "them", text: text.trim() }], editor, target, dialog, textNode: texts[0], targetLinks };
  }

  function readComposeContext() {
    const onComposePage = location.pathname === "/compose/post";
    if (!onComposePage && !hasVisibleComposeDialog()) throw new Error("请打开 /compose/post 或发帖弹窗后使用发帖模式");
    const editors = [...document.querySelectorAll('[data-testid^="tweetTextarea_"][contenteditable="true"][role="textbox"]')]
      .filter((node) => visible(node) && (onComposePage || node.closest('[role="dialog"]')));
    if (!editors.length) throw new Error("读取失败：没有找到发帖输入框，请打开发帖弹窗或 /compose/post");
    if (editors.length !== 1) throw new Error("读取失败：检测到多个发帖输入框，无法确定目标");
    const editor = editors[0];
    let dialog = editor.closest('[role="dialog"]');
    if (dialog) {
      while (dialog.parentElement?.closest('[role="dialog"]')) dialog = dialog.parentElement.closest('[role="dialog"]');
      const posts = [...dialog.querySelectorAll('[data-testid="tweet"]')].filter(visible);
      if (posts.length) throw new Error("读取失败：当前弹窗含目标帖子（回复弹窗），发帖模式只支持发帖框");
    }
    return { kind: "original-post", editor, dialog, target: dialog || editor };
  }
  function contextKey(context) {
    return JSON.stringify({ kind: context.kind, messages: context.messages, targetLinks: context.targetLinks });
  }
  function sourceIsCurrent(expectedDraft = source?.draft) {
    if (!source || source.url !== location.href) return false;
    try {
      const context = source.kind === "original-post" ? readComposeContext() : autoLike.enrichContext(readContext());
      return source.key === contextKey(context)
        && source.editor === context.editor
        && source.target === context.target
        && source.dialog === context.dialog
        && (source.kind === "original-post" || source.textNode === context.textNode)
        && expectedDraft === editorText(context.editor);
    } catch {
      return false;
    } // Caller reports stale/invalid context and stops all filling.
  }
  function invalidate(message, error = true) {
    generation++;
    clearTimeout(pendingFill?.timer);
    pendingFill = null;
    pendingSend = null;
    clearCountdown();
    clearSendConfirmation();
    autoLike.cancel(true);
    source = null;
    state = { candidates: [], decision: null, mode: "" };
    setGenerating(false);
    renderPanel();
    setStatus(message, error);
  }

  function setGenerating(busy) {
    ui.generating = busy;
    renderPanel();
  }

  function setStatus(text, error = false) {
    ui.status = text;
    ui.statusError = error;
    renderPanel();
  }

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
        // Work started on the new URL (an auto generation can start before this
        // poll notices X's /compose/post navigation) belongs to the new page.
        const startedHere = source?.url === location.href;
        const hadWork = source !== null;
        const wasPost = source?.kind === "original-post";
        href = location.href;
        dismissed = false;
        if (isComposeScene()) loadPostCache();
        // X commonly closes the reply modal and changes back to the timeline
        // immediately after a successful send. Preserve the one-shot like
        // confirmation across that expected transition; the target is still
        // checked by node identity or its captured status ID before clicking.
        if (autoLike.isPending()) {
          autoLike.handleRouteChange();
        } else if (sendConfirmation) {
          // A successful X send can close the modal and change the SPA route;
          // keep the one-shot confirmation alive until the editor disappears.
          sendConfirmation.source.url = location.href;
          checkSendConfirmation();
        } else if (startedHere) {
          // Keep the current work; nothing from an older page is pending.
        } else if (countdown) {
          invalidate("已取消自动发送（页面已切换），未发送");
        } else {
          invalidate(hadWork ? (wasPost ? "页面已切换，旧发帖任务已停止。请重新生成。" : "页面已切换，旧回复已停止。请点击下方按钮重新生成。") : READY_TEXT, hadWork);
        }
      }
      consumeAutoTrigger();
      ui.routeHidden = !(isConversation() || isComposeRoute() || (isReplyRoute() && [...document.querySelectorAll('[role="dialog"]')].some(visible)));
      renderPanel();
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
