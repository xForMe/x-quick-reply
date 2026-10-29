import { DEFAULTS, DEFAULT_REPLY_PROMPT, DEFAULT_POST_PROMPT, POST_CATEGORY_OPTIONS, migrateSettings } from "./settings.js";

document.addEventListener("DOMContentLoaded", () => {
  if (!globalThis.React || !globalThis.ReactDOM) throw new Error("React runtime 未加载，无法初始化扩展设置");
  ReactDOM.render(React.createElement(Options), document.getElementById("app"));
});

const h = React.createElement;
const TONE_OPTIONS = [["natural", "自然"], ["concise", "简洁"], ["polite", "礼貌"], ["professional", "专业"]];

function Icon({ name, size = 24 }) {
  const paths = {
    brand: [h("path", { key: "p1", d: "M5 15.5 12 4l7 11.5M8 11h8M7 16h10" })],
    general: [h("path", { key: "p1", d: "M4 7h16M4 12h16M4 17h16" }), h("circle", { key: "c1", cx: 8, cy: 7, r: 1.5, fill: "currentColor" }), h("circle", { key: "c2", cx: 15, cy: 12, r: 1.5, fill: "currentColor" }), h("circle", { key: "c3", cx: 10, cy: 17, r: 1.5, fill: "currentColor" })],
    reply: [h("path", { key: "p1", d: "M20 11.5a7.5 7.5 0 0 1-8 7.5 8.7 8.7 0 0 1-4.2-1.1L4 19l1.3-3.1A7.3 7.3 0 0 1 4.5 12 7.5 7.5 0 0 1 12 4.5c4.1 0 7.5 3.1 8 7Z" })],
    post: [h("path", { key: "p1", d: "m5 19 1.3-4.6L16.8 4a2.1 2.1 0 0 1 3 3L9.3 17.4 5 19Z" }), h("path", { key: "p2", d: "m14.8 6 3.2 3.2" })],
    settings: [h("path", { key: "p1", d: "M12 3v4m0 10v4M4.9 4.9l2.8 2.8m8.6 8.6 2.8 2.8M3 12h4m10 0h4M4.9 19.1l2.8-2.8m8.6-8.6 2.8-2.8" })],
    warning: [h("path", { key: "p1", d: "M12 3 21 20H3L12 3Z" }), h("path", { key: "p2", d: "M12 9v5m0 3v.1" })]
  };
  return h("svg", { "aria-hidden": "true", width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, paths[name]);
}

function Options() {
  const [form, setForm] = React.useState({ ...DEFAULTS });
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState({});
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [tab, setTab] = React.useState("general");

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const settings = migrateSettings({ ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) });
        if (!active) return;
        setForm(settings);
        setStatus("");
        setError(false);
        setFieldErrors({});
      } catch (loadError) {
        if (!active) return;
        setError(true);
        setLoadFailed(true);
        setStatus(`读取设置失败：${loadError.message}`);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const update = (key, value) => {
    setForm(previous => ({ ...previous, [key]: value }));
    setDirty(true);
    setFieldErrors(previous => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  };

  function report(text, isError = false, field = "") {
    setStatus(text);
    setError(isError);
    if (isError && field) setFieldErrors(previous => ({ ...previous, [field]: text }));
  }

  function validate() {
    const gatewayUrl = form.gatewayUrl.trim();
    const replyPrompt = form.replyPrompt.trim();
    const replyExamples = form.replyExamples.trim();
    const postPrompt = form.postPrompt.trim();
    const postExamples = form.postExamples.trim();
    const postCategories = Array.isArray(form.postCategories) ? form.postCategories : [];
    const candidateCount = Number(form.candidateCount);
    const oneClickCountdownSeconds = Number(form.oneClickCountdownSeconds);
    const fail = (field, message) => { report(message, true, field); return null; };
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(gatewayUrl)) return fail("gatewayUrl", "仅支持 http://localhost 或 http://127.0.0.1");
    if (!Number.isInteger(candidateCount) || candidateCount < 2 || candidateCount > 5) return fail("candidateCount", "候选数量必须是 2–5 的整数");
    if (!["natural", "concise", "polite", "professional"].includes(form.tone)) return fail("tone", "默认语气无效");
    if (!replyPrompt || replyPrompt.length > 3000) return fail("replyPrompt", "整体回复提示词必须为 1–3000 字符");
    if (replyExamples.length > 3000) return fail("replyExamples", "我的回复示例不能超过 3000 字符");
    if (!postPrompt || postPrompt.length > 3000) return fail("postPrompt", "发帖提示词必须为 1–3000 字符");
    if (postExamples.length > 3000) return fail("postExamples", "我的发帖示例不能超过 3000 字符");
    if (postCategories.length > 15 || postCategories.some((name) => typeof name !== "string" || !name.trim() || name.length > 40)) return fail("postCategories", "发帖类别选择无效");
    if (!/^\d+$/.test(String(form.oneClickCountdownSeconds).trim()) || oneClickCountdownSeconds < 3 || oneClickCountdownSeconds > 60) return fail("oneClickCountdownSeconds", "发送前倒计时必须是 3–60 秒的整数");
    if (typeof form.autoLikeAfterReply !== "boolean" || typeof form.oneClickReply !== "boolean") return fail("replyBehavior", "回复开关设置无效，请重新勾选后保存");
    return { gatewayUrl, replyPrompt, replyExamples, postPrompt, postExamples, postCategories, candidateCount, oneClickCountdownSeconds };
  }

  async function save() {
    setFieldErrors({});
    const values = validate();
    if (!values) return;
    setSaving(true);
    try {
      await chrome.storage.local.set({ gatewayUrl: values.gatewayUrl, tone: form.tone, candidateCount: values.candidateCount, replyPrompt: values.replyPrompt, replyExamples: values.replyExamples,
        postPrompt: values.postPrompt, postExamples: values.postExamples, postCategories: values.postCategories, autoLikeAfterReply: form.autoLikeAfterReply, oneClickReply: form.oneClickReply, oneClickCountdownSeconds: values.oneClickCountdownSeconds });
      setForm(previous => ({ ...previous, ...values }));
      setDirty(false);
      report("已保存，下次生成生效。");
    } catch (saveError) {
      report(`保存设置失败：${saveError.message}`, true);
    } finally {
      setSaving(false);
    }
  }

  const disabled = loading || saving;
  const statusKind = loading ? "loading" : error ? "error" : saving ? "loading" : status ? "success" : "";
  const tabMeta = {
    general: ["连接与通用", "先确认本地网关，再统一设置回复和发帖的默认语气。模型密钥只保留在网关配置中。"],
    reply: ["回复设置", "控制候选数量、口吻参考和公开回复行为。"],
    post: ["发帖设置", "控制发帖助手的提示词、示例和热榜类别筛选。"]
  };
  const [pageTitle, pageLead] = tabMeta[tab];

  const field = (id, label, input, help, counter = "") => h("div", { className: "field", key: id },
    h("label", { htmlFor: id }, label), input,
    help ? h("small", { className: "field-help", id: `${id}Help` }, help) : null,
    counter ? h("div", { className: "counter" }, h("span", null, counter), h("span", null, `${String(form[id] || "").length} / 3000`)) : null,
    fieldErrors[id] ? h("span", { className: "field-error", role: "alert" }, fieldErrors[id]) : null
  );
  const inputProps = (id, extra = {}) => ({ id, className: `field-control ${extra.className || "input"}`, disabled, "aria-invalid": String(Boolean(fieldErrors[id])), ...extra });
  const tabButton = (key, label, iconName) => h("button", { key, id: `tab${key[0].toUpperCase()}${key.slice(1)}`, type: "button", role: "tab", "aria-selected": String(tab === key), "aria-controls": `panel-${key}`, onClick: () => setTab(key) }, h(Icon, { name: iconName, size: 18 }), label);
  const toggle = (id, label, checked, onChange) => h("label", { className: "switch" }, h("input", { id, type: "checkbox", checked, disabled, "aria-label": label, onChange: event => onChange(event.target.checked) }), h("span", { className: "toggle", "aria-hidden": "true", "aria-checked": String(checked) }));
  const warning = (children) => h("div", { className: "callout" }, h(Icon, { name: "warning", size: 18 }), h("span", null, children));
  const sectionHead = (title, copy, iconName, badge) => h("div", { className: "section-head" }, h("div", null, h("h2", null, title), h("p", null, copy)), badge || h(Icon, { name: iconName, size: 24 }));

  return h("div", { className: "settings-shell" },
    h("aside", { className: "settings-sidebar", "aria-label": "设置分区" },
      h("div", { className: "brand" }, h("span", { className: "brand-mark" }, h(Icon, { name: "brand", size: 18 })), "快速回复"),
      h("div", { className: "sidebar-eyebrow" }, "设置"),
      h("nav", { className: "settings-nav", role: "tablist", "aria-label": "设置分区" }, tabButton("general", "连接与通用", "general"), tabButton("reply", "回复设置", "reply"), tabButton("post", "发帖设置", "post")),
      h("div", { className: "sidebar-foot" }, "本地设置 · 只在你点击保存后生效")
    ),
    h("main", { className: "settings-main" },
      h("header", { className: "settings-topbar" }, h("div", null, h("div", { className: "kicker" }, "QUICK REPLY SETTINGS"), h("h1", null, pageTitle), h("p", { className: "settings-lead" }, pageLead)), h("div", { className: `status-pill ${statusKind}` }, h("span", { className: "status-dot", "aria-hidden": "true" }), h("span", null, loading ? "读取中" : error ? "读取失败" : dirty ? "待保存" : status ? "已保存" : "设置已加载"))),
      h("div", { className: "settings-content" },
        h("div", { id: "status", role: error ? "alert" : "status", className: `settings-alert ${statusKind}`, hidden: !loading && !status }, loading ? "正在读取本地设置…表单暂不可编辑。" : status),
        h("section", { id: "panel-general", role: "tabpanel", "aria-labelledby": "tabGeneral", className: "settings-section", hidden: tab !== "general" },
          sectionHead("连接与默认偏好", "这些设置会同时影响回复和发帖。", "settings"),
          h("div", { className: "section-body" }, h("div", { className: "grid-2" },
            field("gatewayUrl", "本地网关 URL", h("input", inputProps("gatewayUrl", { value: form.gatewayUrl, placeholder: "http://127.0.0.1:8787", onChange: event => update("gatewayUrl", event.target.value) })), "只支持 localhost 或 127.0.0.1，可带端口。"),
            field("tone", "默认语气", h("select", inputProps("tone", { className: "select", value: form.tone, onChange: event => update("tone", event.target.value) }), TONE_OPTIONS.map(([value, label]) => h("option", { key: value, value }, label))), "回复与发帖共用。具体语言跟随目标正文。")
          ))
        ),
        h("section", { id: "panel-reply", role: "tabpanel", "aria-labelledby": "tabReply", className: "settings-section", hidden: tab !== "reply" },
          sectionHead("回复偏好", "控制候选数量、口吻参考和公开回复行为。", "reply", h("span", { className: "status-pill", style: { color: "var(--primary-strong)", background: "var(--primary-soft)", borderColor: "#d9c9ff" } }, "回复")),
          h("div", { className: "section-body" },
            h("div", { className: "grid-2" },
              field("candidateCount", "候选数量", h("input", inputProps("candidateCount", { type: "number", min: 2, max: 5, value: form.candidateCount, onChange: event => update("candidateCount", event.target.value) })), "生成 2–5 条候选，保存时严格校验。"),
              h("div", { className: "field" }, h("label", null, "我的回复示例", h("span", { style: { fontWeight: 400, color: "var(--muted)" } }, "（可选）")), h("div", { className: "empty-state" }, h("strong", null, form.replyExamples.trim() ? "已添加示例" : "还没有示例"), form.replyExamples.trim() ? "示例会作为口吻参考，不会替代当前帖子事实。" : "添加 3–10 条你自己写过的回复，模型会用它学习口吻。"))
            ),
            h("div", { className: "subsection" }, field("replyPrompt", "整体回复提示词", h("textarea", inputProps("replyPrompt", { className: "textarea", maxLength: 3000, value: form.replyPrompt, "aria-describedby": "replyPromptHelp", onChange: event => update("replyPrompt", event.target.value) })), "生成和百炼筛选共用。可写语气、接话方式和不想出现的表达。", "最多 3000 字符。")),
            h("div", { className: "subsection" }, field("replyExamples", "我的回复示例（可选）", h("textarea", inputProps("replyExamples", { className: "textarea short", maxLength: 3000, value: form.replyExamples, placeholder: "每行一条你自己写过的自然回复，建议 3–10 条", "aria-describedby": "replyExamplesHelp", onChange: event => update("replyExamples", event.target.value) })), "不会替代当前帖子事实，也不会强制回复语言。示例会发送给生成模型和百炼；不要填写密钥、Cookie、私信正文或敏感资料。", "最多 3000 字符。")),
            h("div", { className: "subsection" },
              h("h3", { style: { margin: "0 0 12px", fontSize: "14px" } }, "发送行为"),
              h("div", { className: "row" }, h("div", null, h("h3", null, "发送公开回复后自动点赞"), h("p", null, "仅在页面确认公开回复发送成功后打开原帖并点赞；默认关闭，点赞失败不会重试。")), toggle("autoLikeAfterReply", "发送公开回复后自动点赞", form.autoLikeAfterReply === true, value => update("autoLikeAfterReply", value))),
              h("div", { className: "row" }, h("div", null, h("h3", null, "一键回复"), h("p", null, "只有你点击帖子的“回复”按钮才触发；私信、直接打开链接和面板主按钮不自动发送。")), toggle("oneClickReply", "一键回复", form.oneClickReply === true, value => update("oneClickReply", value))),
              h("div", { className: "row" }, h("div", null, h("h3", null, "发送前倒计时"), h("p", null, "倒计时期间可取消；修改草稿、关闭弹窗或切换页面会保留草稿并停止发送。")), h("div", { style: { width: "120px" } }, h("input", { id: "oneClickCountdownSeconds", className: "input field-control", type: "number", min: 3, max: 60, step: 1, value: form.oneClickCountdownSeconds, disabled: disabled || form.oneClickReply !== true, "aria-invalid": String(Boolean(fieldErrors.oneClickCountdownSeconds)), onChange: event => update("oneClickCountdownSeconds", event.target.value) }), h("small", { className: "field-help" }, "3–60 秒"), fieldErrors.oneClickCountdownSeconds ? h("span", { className: "field-error", role: "alert" }, fieldErrors.oneClickCountdownSeconds) : null))
            ),
            warning("请在 X 页面确认草稿和目标后再发送。设置页不会自动发布内容。"),
            h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: "18px" } }, h("button", { id: "resetPrompt", className: "restore-button", type: "button", disabled, onClick: () => { update("replyPrompt", DEFAULT_REPLY_PROMPT); report("已恢复默认回复提示词，请点击保存。"); } }, "恢复默认回复提示词"))
          )
        ),
        h("section", { id: "panel-post", role: "tabpanel", "aria-labelledby": "tabPost", className: "settings-section", hidden: tab !== "post" },
          sectionHead("发帖偏好", "控制发帖助手的提示词、示例和热榜类别筛选。", "post", h("span", { className: "status-pill", style: { color: "var(--cyan)", background: "var(--cyan-soft)", borderColor: "#bce7ee" } }, "发帖")),
          h("div", { className: "section-body" },
            field("postPrompt", "发帖提示词", h("textarea", inputProps("postPrompt", { className: "textarea", maxLength: 3000, value: form.postPrompt, "aria-describedby": "postPromptHelp", onChange: event => update("postPrompt", event.target.value) })), "默认先把参考原文改写成你自己的帖子，再组织提问和互动；不会写成“那个帖子说”的转述。可继续补充语气或不想出现的表达。", "最多 3000 字符。"),
            h("div", { className: "subsection" }, field("postExamples", "我的发帖示例（可选）", h("textarea", inputProps("postExamples", { className: "textarea short", maxLength: 3000, value: form.postExamples, placeholder: "粘贴 3–10 条你自己发过的帖子，保留原来的换行和标点", "aria-describedby": "postExamplesHelp", onChange: event => update("postExamples", event.target.value) })), "示例优先用于学习句式、分行、口语标点和追问节奏，不复制事实；不要填写密钥或敏感资料。", "最多 3000 字符。")),
            h("fieldset", { className: "field subsection", style: { border: 0, paddingRight: 0, paddingLeft: 0 } }, h("legend", null, "获取类别", h("span", { style: { fontWeight: 400, color: "var(--muted)" } }, "（不选 = 全部）")), h("div", { id: "postCategories", className: "categories" }, POST_CATEGORY_OPTIONS.map(name => h("label", { key: name, className: "category" }, h("input", { type: "checkbox", checked: (form.postCategories || []).includes(name), disabled, onChange: event => update("postCategories", event.target.checked ? [...(form.postCategories || []), name] : (form.postCategories || []).filter(entry => entry !== name)) }), name))), h("small", { className: "field-help" }, "按热榜条目的类别筛选；类别字段缺失时会明确报错。")),
            warning("发帖助手只回填草稿，仍由你人工检查并点击 X 的发帖按钮。"),
            h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: "18px" } }, h("button", { id: "resetPostPrompt", className: "restore-button", type: "button", disabled, onClick: () => { update("postPrompt", DEFAULT_POST_PROMPT); report("已恢复默认发帖提示词，请点击保存。"); } }, "恢复默认发帖提示词"))
          )
        )
      )
    ),
    h("div", { className: "save-bar" }, h("div", { className: "save-bar-inner" }, h("div", { className: "save-copy" }, h("strong", null, saving ? "正在保存…" : dirty ? "有未保存更改" : status && !error ? "已保存" : "设置尚未保存"), h("span", null, error ? "修正错误后再试。" : "保存后下次生成生效。")), h("div", { className: "save-actions" }, h("button", { id: "reset", className: "button", type: "button", disabled, onClick: () => { setForm(previous => ({ ...previous, ...DEFAULTS })); setDirty(true); setFieldErrors({}); report("已恢复当前设置默认值，请点击保存。"); } }, "恢复当前默认值"), h("button", { id: "save", className: "button primary", type: "button", disabled: loading || saving || loadFailed, onClick: save }, saving ? "保存中…" : "保存设置"))))
  );
}
