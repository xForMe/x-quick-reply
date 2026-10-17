"""Explicit live evaluation using synthetic posts; never run by unittest discovery.

Run manually from the repository: python -X utf8 code/quick-reply/tests/evaluate_prompts.py
Uses the configured providers once per sample. Stops on first failure, no retries.
Persists only these synthetic inputs/outputs in the evaluation document.
"""
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from gateway import GatewayError, Models, Settings, SCHEMA, PROMPT_VERSION


def main():
    settings_text = (ROOT / "extension/src/settings.js").read_text(encoding="utf-8")
    prompt = re.search(r"DEFAULT_REPLY_PROMPT = `([^`]+)`", settings_text).group(1)
    models = Models(Settings.load())
    samples = [
        ("日常吐槽", "开通会员20天了，每天认真发内容，结果阅读量像在躲着我。"),
        ("严肃情境", "这两天家里人生病住院，脑子一团乱，实在没心情更新了。"),
        ("英文日常", "Bought a standing desk to be healthier. Now I just stand while eating snacks.")
    ]
    records = []
    failure = None
    for label, text in samples + [("通用套话拒选", samples[0][1])]:
        value = {"schemaVersion": SCHEMA, "kind": "public-reply", "messages": [{"role": "them", "text": text}],
                 "tone": "natural", "candidateCount": 3, "language": "auto", "replyPrompt": prompt}
        record = {"sample": label, "target": text}
        records.append(record)
        try:
            started = time.monotonic()
            if label == "通用套话拒选":
                # Explicit negative test inputs; never substitute for generated replies.
                value.update(candidateCount=2, candidates=[
                    {"id": "c1", "text": "说得太对了，保持热爱，一切都会好起来的。"},
                    {"id": "c2", "text": "感谢分享，这真的很有启发。"}])
                record["candidates"] = value["candidates"]
                record["decision"] = models.decide(value)
                if not record["decision"]["reviewRequired"]:
                    raise GatewayError("负样本验收失败：百炼未拒绝全部通用套话")
            else:
                generated = models.generate(value)
                record.update(candidates=generated["candidates"], generation=generated["meta"])
                record["decision"] = models.decide({**value, "candidates": generated["candidates"]})
                if label == "日常吐槽":
                    chosen = next((c["text"] for c in record["candidates"] if c["id"] == record["decision"]["selectedId"]), "")
                    if any(term in chosen for term in ["按天续费", "按天扣费", "每天扣费"]):
                        raise GatewayError("事实负样本验收失败：回复编造了会员计费周期")
            record["totalMs"] = round((time.monotonic() - started) * 1000)
        except GatewayError as error:
            record["error"] = str(error)
            failure = str(error)
        print(json.dumps(record, ensure_ascii=False), flush=True)
        if failure:
            break
    report = ROOT.parents[1] / "doc/quick-reply/提示词样本验证.md"
    text = "# 整体提示词样本验证\n\n"
    text += datetime.now().isoformat(timespec="seconds") + "：所有输入均为合成文本，使用实际配置服务，无重试、替代模型、真实聊天读取或自动发送。\n\n"
    text += f"生成模型：{models.settings.llm_model}；共同规则版本：{PROMPT_VERSION}。\n\n"
    text += "这是有限样本的模型实际输出，供人工审阅；协议通过不代表风格、事实和幽默质量全部合格。\n\n"
    text += "```json\n" + json.dumps(records, ensure_ascii=False, indent=2) + "\n```\n"
    report.write_text(text, encoding="utf-8")
    if failure:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
