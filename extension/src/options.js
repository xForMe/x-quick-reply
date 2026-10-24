import { DEFAULTS, DEFAULT_REPLY_PROMPT, DEFAULT_POST_PROMPT, POST_CATEGORY_OPTIONS } from "./settings.js";

document.addEventListener("DOMContentLoaded", () => {
  if (!globalThis.React || !globalThis.ReactDOM) throw new Error("React runtime 未加载，无法初始化扩展设置");
  ReactDOM.render(React.createElement(Options), document.getElementById("app"));
});

function Options() {
  const h = React.createElement;
  const [form, setForm] = React.useState({ ...DEFAULTS });
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState(false);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  // 回复与发帖分开展示在两个 Tab 中；两个面板都渲染，用 hidden 切换，互不混排。
  const [tab, setTab] = React.useState("reply");

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
        if (!active) return;
        setForm(settings);
        setStatus("");
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

  const update = (key, value) => setForm(previous => ({ ...previous, [key]: value }));

  async function save() {
    const gatewayUrl = form.gatewayUrl.trim();
    const replyPrompt = form.replyPrompt.trim();
    const replyExamples = form.replyExamples.trim();
    const postPrompt = form.postPrompt.trim();
    const postExamples = form.postExamples.trim();
    const postCategories = Array.isArray(form.postCategories) ? form.postCategories : [];
    const candidateCount = Number(form.candidateCount);
    const oneClickCountdownSeconds = Number(form.oneClickCountdownSeconds);
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(gatewayUrl)) return report("仅支持 http://localhost 或 http://127.0.0.1", true);
    if (!Number.isInteger(candidateCount) || candidateCount < 2 || candidateCount > 5) return report("候选数量必须是 2–5 的整数", true);
    if (!["natural", "concise", "polite", "professional"].includes(form.tone)) return report("默认语气无效", true);
    if (!replyPrompt || replyPrompt.length > 3000) return report("整体回复提示词必须为 1–3000 字符", true);
    if (replyExamples.length > 3000) return report("我的回复示例不能超过 3000 字符", true);
    if (!postPrompt || postPrompt.length > 3000) return report("发帖提示词必须为 1–3000 字符", true);
    if (postExamples.length > 3000) return report("我的发帖示例不能超过 3000 字符", true);
    if (postCategories.length > 15 || postCategories.some((name) => typeof name !== "string" || !name.trim() || name.length > 40)) {
      return report("发帖类别选择无效", true);
    }
    if (!/^\d+$/.test(String(form.oneClickCountdownSeconds).trim()) || oneClickCountdownSeconds < 3 || oneClickCountdownSeconds > 60) {
      return report("发送前倒计时必须是 3–60 的整数秒", true);
    }
    setSaving(true);
    try {
      if (typeof form.autoLikeAfterReply !== "boolean" || typeof form.oneClickReply !== "boolean") return report("回复开关设置无效，请重新勾选后保存", true);
      await chrome.storage.local.set({ gatewayUrl, tone: form.tone, candidateCount, replyPrompt, replyExamples,
        postPrompt, postExamples, postCategories, autoLikeAfterReply: form.autoLikeAfterReply, oneClickReply: form.oneClickReply, oneClickCountdownSeconds });
      setForm(previous => ({ ...previous, gatewayUrl, candidateCount, replyPrompt, replyExamples, postPrompt, postExamples, postCategories, oneClickCountdownSeconds }));
      report("已保存，下次生成生效。");
    } catch (saveError) {
      report(`保存设置失败：${saveError.message}`, true);
    } finally {
      setSaving(false);
    }
  }

  function report(text, isError = false) {
    setStatus(text);
    setError(isError);
  }

  const field = (label, input, help) => h(React.Fragment, { key: label }, h("label", null, label), input, help ? h("small", null, help) : null);
  const tabButton = (id, key, label) => h("button", {
    id, type: "button", role: "tab", "aria-selected": String(tab === key),
    className: tab === key ? "tab selected" : "tab", onClick: () => setTab(key)
  }, label);
  return h("main", null,
    h("h1", null, "扩展设置 · 回复 / 发帖"),
    h("p", null, "回复与发帖是两个独立功能，设置分两个标签维护。大模型生成候选，阿里云百炼选择。请先启动本地网关；模型密钥仅在网关配置。"),
    field("本地网关 URL", h("input", { id: "gatewayUrl", value: form.gatewayUrl, placeholder: "http://127.0.0.1:8787", disabled: loading || saving,
      onChange: event => update("gatewayUrl", event.target.value) })),
    field("默认语气", h("select", { id: "tone", value: form.tone, disabled: loading || saving, onChange: event => update("tone", event.target.value) },
      h("option", { value: "natural" }, "自然"), h("option", { value: "concise" }, "简洁"), h("option", { value: "polite" }, "礼貌"), h("option", { value: "professional" }, "专业")),
      "回复与发帖共用的默认语气。"),
    h("div", { className: "tabs", role: "tablist" }, tabButton("tabReply", "reply", "回复"), tabButton("tabPost", "post", "发帖")),
    h("div", { id: "panel-reply", role: "tabpanel", hidden: tab !== "reply" },
      field("候选数量（2–5）", h("input", { id: "candidateCount", type: "number", min: 2, max: 5, value: form.candidateCount, disabled: loading || saving,
        onChange: event => update("candidateCount", event.target.value) })),
      field("整体回复提示词", h("textarea", { id: "replyPrompt", maxLength: 3000, value: form.replyPrompt, disabled: loading || saving,
        "aria-describedby": "promptHelp", onChange: event => update("replyPrompt", event.target.value) }),
        "生成和百炼筛选共用。可写语气、偏好的接话方式和不想出现的表达，最多 3000 字符。默认轻松幽默；严肃话题优先得体。不要填写密钥或隐私资料。"),
      field("我的回复示例（可选）", h("textarea", { id: "replyExamples", maxLength: 3000, value: form.replyExamples, disabled: loading || saving,
        "aria-describedby": "examplesHelp", placeholder: "每行一条你自己写过的自然回复，建议 3–10 条", onChange: event => update("replyExamples", event.target.value) }),
        "只用于学习你的口吻，不会替代当前帖子事实或强制回复语言。示例会发送给生成模型和百炼；不要填写密钥、Cookie、私信正文或敏感资料。"),
      h("label", null, h("input", { id: "autoLikeAfterReply", type: "checkbox", checked: form.autoLikeAfterReply === true, disabled: loading || saving,
        onChange: event => update("autoLikeAfterReply", event.target.checked) }), " 发送公开回复后打开原帖并自动点赞"),
      h("small", null, "仅在你实际点击 X 的发送按钮、且发送结果得到页面确认后执行；私信不适用。默认关闭，点赞失败不会重试。"),
      h("label", null, h("input", { id: "oneClickReply", type: "checkbox", checked: form.oneClickReply === true, disabled: loading || saving,
        onChange: event => update("oneClickReply", event.target.checked) }), " 一键回复：点击帖子“回复”后自动生成，并在倒计时后发送公开回复"),
      field("发送前倒计时（3–60 秒）", h("input", { id: "oneClickCountdownSeconds", type: "number", min: 3, max: 60, step: 1, value: form.oneClickCountdownSeconds,
        disabled: loading || saving || form.oneClickReply !== true, onChange: event => update("oneClickCountdownSeconds", event.target.value) })),
      h("small", null, "默认关闭。只有你点击 X 帖子上的“回复”按钮才会触发：自动生成、按百炼选中的候选回填，倒计时结束后点击一次 X 回复按钮。倒计时期间可取消或立即发送，点其他候选会替换并立即发送；修改草稿、关闭弹窗或切换页面会取消。直接打开回复链接、面板主按钮和私信都不会自动发送。发送确认失败不重试。"),
      h("button", { id: "resetPrompt", type: "button", disabled: loading || saving, onClick: () => { update("replyPrompt", DEFAULT_REPLY_PROMPT); report("已恢复默认提示词，请点击保存。"); } }, "恢复默认提示词"),
      h("small", null, "恢复只修改上方文本，点击“保存”后生效。")
    ),
    h("div", { id: "panel-post", role: "tabpanel", hidden: tab !== "post" },
      field("发帖提示词", h("textarea", { id: "postPrompt", maxLength: 3000, value: form.postPrompt, disabled: loading || saving,
        "aria-describedby": "postPromptHelp", onChange: event => update("postPrompt", event.target.value) }),
        "发帖助手的帖文生成共用。可写互动钩子偏好、语气和不想出现的表达，最多 3000 字符。话题来自 xzhishu 热榜（第三方数据源，接口失效时明确报错）。不要填写密钥或隐私资料。"),
      field("我的发帖示例（可选）", h("textarea", { id: "postExamples", maxLength: 3000, value: form.postExamples, disabled: loading || saving,
        placeholder: "每行一条你自己发过的帖子，建议 3–10 条", onChange: event => update("postExamples", event.target.value) }),
        "只用于学习你的口吻，不会替代话题事实或强制帖文语言。示例会发送给生成模型；不要填写密钥或敏感资料。"),
      field("获取类别（可多选；不选＝全部）", h("div", { id: "postCategories" },
        POST_CATEGORY_OPTIONS.map((name) => h("label", { key: name, className: "cat" },
          h("input", { type: "checkbox", checked: (form.postCategories || []).includes(name), disabled: loading || saving,
            onChange: event => update("postCategories", event.target.checked
              ? [...(form.postCategories || []), name]
              : (form.postCategories || []).filter((entry) => entry !== name)) }), " " + name))),
        "按 xzhishu 推文榜条目的类别筛选（11 类，2026-10-24 实测）。仅热门推文榜支持；热门话题榜没有类别字段，勾选后用话题榜会明确报错。"),
      h("button", { id: "resetPostPrompt", type: "button", disabled: loading || saving, onClick: () => { update("postPrompt", DEFAULT_POST_PROMPT); report("已恢复默认发帖提示词，请点击保存。"); } }, "恢复默认发帖提示词"),
      h("small", null, "发帖只回填草稿，由你人工点击发帖；候选缓存保存在扩展本地存储。")
    ),
    h("button", { id: "save", type: "button", disabled: loading || saving || loadFailed, onClick: save }, saving ? "保存中…" : "保存"),
    h("span", { id: "status", role: "status", className: error ? "error" : "" }, status)
  );
}
