// Editorial defaults for first use, shared by options and background requests.
export const DEFAULT_REPLY_PROMPT = `像一个真实用户看到内容后顺手回一句，不要像在完成写作任务，也不要像客服或人生导师。
先接住原文里一个最具体的细节。短、口语、像第一反应，比完整、漂亮、有观点更重要；允许省略主语、短句或轻微停顿。
默认一两句就够，没有自然的笑点就平实回应，不要为了显得幽默而编比喻、抖机灵或强行反问。
不要复述原文后再夸一句，不要写总结、升华、金句或解释自己的理解；不要使用可套用的开场和收尾，例如“确实如此”“说得太对了”“希望你……”或“这让我想到……”。
不熟装熟，不假装自己有相同经历；不擅自安慰、劝坚持或教对方做人。遇到难过、疾病或损失，认真接话，别拿痛处开玩笑。
候选只需自然地提供几种轻微不同的说法，不要为了凑数写成三条完整文案；优先保留真实聊天里的不完美感。
以上中文只描述风格；实际回复跟随目标正文语言，用该语言自然地接话，不照搬中文例句。`;

export const DEFAULT_POST_PROMPT = `面向 X 发帖，目标是吸引目标读者留言互动。
帖文开头用一个具体细节或反差钩住人，结尾用容易回答的开放问题或低门槛选项（例如四选一、报数、站队）。
只使用选定话题的标题与摘要事实；不捏造个人经历、数据或他人言行。
时效性事实留有余地并列入核实提示，不写进帖文正文。
像真人随手发的一条：不用营销腔、标签堆砌或 AI 式收尾，没有自然笑点就不写笑点。
以上中文只描述风格；实际帖文跟随话题标题的主要语言。`;

// xzhishu 类别名（2026-10-24 实测 /api/v1/categories）；筛选按推文榜条目的 category 名匹配。
export const POST_CATEGORY_OPTIONS = Object.freeze([
  "AI", "Web3/加密", "科技数码", "财经投资", "社会观察", "知识分享",
  "个人成长与生活", "创业&出海", "副业", "独立开发", "其他"
]);

export const DEFAULTS = Object.freeze({
  gatewayUrl: "http://127.0.0.1:8787",
  tone: "natural",
  candidateCount: 3,
  replyPrompt: DEFAULT_REPLY_PROMPT,
  replyExamples: "",
  postPrompt: DEFAULT_POST_PROMPT,
  postExamples: "",
  postCategories: Object.freeze([]),
  autoLikeAfterReply: false,
  oneClickReply: false,
  oneClickCountdownSeconds: 10,
  timeoutMs: 100000
});
