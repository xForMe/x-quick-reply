import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gateway import (GatewayError, Models, Settings, SCHEMA, make_server,
                     parse_hot_topics, post_json, validate_endpoint,
                     validate_post_generate_request, validate_request)


def request():
    return {"schemaVersion": SCHEMA, "kind": "direct-message", "messages": [{"role": "them", "text": "明天下午方便聊吗？"}],
            "tone": "natural", "candidateCount": 2, "language": "auto", "replyPrompt": "轻松幽默，像日常聊天，不硬抖机灵。", "replyExamples": ""}


def candidates():
    return [{"id": "c1", "text": "你想几点聊？我先确认一下时间。"},
            {"id": "c2", "text": "明天下午几点比较适合你？"}]


def answer(choice="c2"):
    return {"model": "decision-model-preview", "answers": {"best_reply": {
        "type": "choice", "choice": choice, "confidence": 0.6,
        "probabilities": {"c1": 0.25, "c2": 0.65, "__none__": 0.1}}}}


def settings():
    return Settings("https://generator.example/v1", "my-model", "generation-secret",
                    "bailian", "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone",
                    "decision-secret")


class ModelTests(unittest.TestCase):
    def test_overall_prompt_and_policy_are_shared_by_both_stages(self):
        calls = []
        def transport(url, key, payload, timeout, stage):
            calls.append(payload)
            if stage == "生成":
                return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({
                    "candidates": [{"text": c["text"]} for c in candidates()]})}}]}
            return answer()
        models = Models(settings(), transport)
        value = {**request(), "replyPrompt": "  轻松接话，不用表情，不说加油。  ",
                 "replyExamples": "  先忙你的，晚点再说。  "}
        generated = models.generate(value)
        models.decide({**value, "candidates": generated["candidates"]})
        self.assertIn(models.policy, calls[0]["messages"][0]["content"])
        self.assertIn(models.policy, calls[1]["questions"]["best_reply"]["instructions"])
        expected = value["replyPrompt"].strip()
        self.assertEqual(json.loads(calls[0]["messages"][1]["content"])["replyPrompt"], expected)
        self.assertEqual(calls[1]["state"]["replyPrompt"], expected)
        self.assertEqual(json.loads(calls[0]["messages"][1]["content"])["replyExamples"], "先忙你的，晚点再说。")
        self.assertEqual(calls[1]["state"]["replyExamples"], "先忙你的，晚点再说。")
        self.assertIn("用户过去写过的回复示例", calls[0]["messages"][0]["content"])
        self.assertIn("用户过去写过的回复示例", calls[1]["questions"]["best_reply"]["instructions"])
        self.assertEqual(generated["meta"]["promptVersion"], "reply-policy.v3")

    def test_missing_or_invalid_overall_prompt_is_not_replaced_by_a_default(self):
        for reply_prompt in [None, "", " ", 123, "字" * 3001]:
            with self.subTest(reply_prompt=str(reply_prompt)[:20]), self.assertRaisesRegex(GatewayError, "replyPrompt"):
                validate_request({**request(), "replyPrompt": reply_prompt})
        value = request()
        value.pop("replyPrompt")
        with self.assertRaisesRegex(GatewayError, "replyPrompt"):
            validate_request(value)

    def test_reply_examples_are_optional_but_bounded_and_preserved(self):
        self.assertEqual(validate_request(request())["replyExamples"], "")
        value = validate_request({**request(), "replyExamples": "  随手回一句。  "})
        self.assertEqual(value["replyExamples"], "随手回一句。")
        for examples in [None, 12, "字" * 3001]:
            with self.subTest(examples=str(examples)[:20]), self.assertRaisesRegex(GatewayError, "replyExamples"):
                validate_request({**request(), "replyExamples": examples})

    def test_unreadable_shared_policy_stops_instead_of_using_old_instructions(self):
        with patch.object(Path, "read_text", side_effect=OSError("unreadable")):
            with self.assertRaisesRegex(GatewayError, "无法读取共同回复规则"):
                Models(settings(), lambda *a: self.fail("unexpected network"))

    def test_duplicate_texts_are_rejected_without_filtering_or_regenerating(self):
        items = [{"id": "c1", "text": "重复候选"}, {"id": "c2", "text": "重复候选"}]
        calls = []
        def transport(*args):
            calls.append(args[-1])
            return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({
                "candidates": [{"text": item["text"]} for item in items]})}}]}
        with self.assertRaisesRegex(GatewayError, "候选回复重复"):
            Models(settings(), transport).generate(request())
        self.assertEqual(calls, ["生成"])
        with self.assertRaisesRegex(GatewayError, "候选回复重复"):
            Models(settings(), lambda *a: self.fail("unexpected network")).decide({**request(), "candidates": items})

    def test_chinese_post_with_english_candidates_is_rejected_without_decision_call(self):
        english = [{"id": "c1", "text": "Start with an easy trail."},
                   {"id": "c2", "text": "Check the weather before you go."}]
        value = {**request(), "kind": "public-reply"}
        calls = []
        def transport(*args):
            calls.append(args[-1])
            return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({
                "candidates": [{"text": item["text"]} for item in english]})}}]}
        with self.assertRaisesRegex(GatewayError, "文字体系不符"):
            Models(settings(), transport).generate(value)
        self.assertEqual(calls, ["生成"])
        with self.assertRaisesRegex(GatewayError, "文字体系不符"):
            Models(settings(), lambda *args: self.fail("must stop before decision")).decide(
                {**value, "candidates": english})

    def test_english_post_with_only_chinese_replies_is_rejected(self):
        value = {**request(), "kind": "public-reply",
                 "messages": [{"role": "them", "text": "Any advice for my first weekend hike?"}]}
        with self.assertRaisesRegex(GatewayError, "文字体系不符"):
            Models(settings(), lambda *args: self.fail("must stop before decision")).decide(
                {**value, "candidates": candidates()})

    def test_chinese_replies_can_keep_product_names_and_links(self):
        value = {**request(), "kind": "public-reply",
                 "messages": [{"role": "them", "text": "最近开始学习编程，用什么工具比较好？https://example.com/verylongenglishurl"}]}
        items = [{"id": "c1", "text": "可以试试 ChatGPT 和 VS Code。"},
                 {"id": "c2", "text": "先用 Python 练习基础语法如何？"}]
        result = Models(settings(), lambda *a: answer()).decide({**value, "candidates": items})
        self.assertFalse(result["reviewRequired"])

    def test_reply_language_policy_uses_source_instead_of_page_locale(self):
        value = {**request(), "kind": "public-reply"}
        value.pop("language")
        self.assertEqual(validate_request(value)["language"], "auto")
        for locale in ["en", "zh-CN", ""]:
            with self.subTest(locale=locale), self.assertRaisesRegex(GatewayError, "auto"):
                validate_request({**value, "language": locale})

    def test_public_reply_context_reaches_both_models(self):
        calls = []
        def transport(url, key, payload, timeout, stage):
            calls.append(payload)
            if stage == "生成":
                return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({
                    "candidates": [{"text": c["text"]} for c in candidates()]})}}]}
            return answer()
        models = Models(settings(), transport)
        value = {**request(), "kind": "public-reply"}
        generated = models.generate(value)
        models.decide({**value, "candidates": generated["candidates"]})
        self.assertIn("公开帖子", calls[0]["messages"][0]["content"])
        self.assertEqual(json.loads(calls[0]["messages"][1]["content"])["kind"], "public-reply")
        self.assertIn("公开帖子", calls[1]["questions"]["best_reply"]["instructions"])
        self.assertEqual(calls[1]["state"]["kind"], "public-reply")

    def test_missing_or_invalid_context_kind_is_rejected(self):
        for kind in [None, "post", ""]:
            with self.assertRaisesRegex(GatewayError, "kind"):
                validate_request({**request(), "kind": kind})

    def test_public_reply_rejects_multiple_targets_or_overlong_candidates(self):
        with self.assertRaisesRegex(GatewayError, "唯一"):
            validate_request({**request(), "kind": "public-reply", "messages": request()["messages"] * 2})
        items = [{"id": "c1", "text": "字" * 281}, candidates()[1]]
        with self.assertRaisesRegex(GatewayError, "280"):
            Models(settings(), lambda *a: self.fail("must reject before network")).decide(
                {**request(), "kind": "public-reply", "candidates": items})

    def test_generation_and_decision_use_separate_contracts_and_credentials(self):
        calls = []
        def transport(url, key, payload, timeout, stage):
            calls.append((url, key, payload, stage))
            if stage == "生成":
                return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({
                    "candidates": [{"text": c["text"]} for c in candidates()]})}}]}
            return answer()
        models = Models(settings(), transport)
        generated = models.generate(request())
        decided = models.decide({**request(), "candidates": generated["candidates"]})
        self.assertEqual(decided["selectedId"], "c2")
        self.assertEqual(decided["confidence"], 0.6)
        self.assertNotIn("score", decided)
        self.assertNotIn("reason", decided)
        self.assertEqual(calls[0][0], "https://generator.example/v1/chat/completions")
        self.assertEqual(calls[0][1], "generation-secret")
        self.assertEqual(calls[1][1], "decision-secret")
        self.assertEqual(calls[1][2]["questions"]["best_reply"]["type"], "choice")
        self.assertIn("__none__", calls[1][2]["questions"]["best_reply"]["criteria"])

    def test_abstain_has_no_selected_text(self):
        result = Models(settings(), lambda *a: answer("__none__")).decide({**request(), "candidates": candidates()})
        self.assertIsNone(result["selectedId"])
        self.assertTrue(result["reviewRequired"])

    def test_invalid_decision_does_not_fallback(self):
        for field, value in [("choice", "c99"), ("confidence", "0.9"), ("confidence", float("nan")),
                             ("probabilities", {"c1": 0.5, "c2": 0.5})]:
            with self.subTest(field=field, value=value):
                result = answer()
                result["answers"]["best_reply"][field] = value
                with self.assertRaises(GatewayError):
                    Models(settings(), lambda *a: result).decide({**request(), "candidates": candidates()})

    def test_missing_generation_fails_without_network(self):
        def no_network(*a):
            self.fail("unexpected network")
        with self.assertRaisesRegex(GatewayError, "LLM_BASE_URL.*LLM_MODEL.*LLM_API_KEY"):
            Models(Settings(), no_network).generate(request())

    def test_bad_or_truncated_generation_fails(self):
        for content, finish in [('not json', 'stop'), ('{"candidates":[]}', 'stop'),
                                ('{"candidates":[{"text":"x"}]}', 'length')]:
            with self.subTest(content=content):
                transport = lambda *a: {"choices": [{"finish_reason": finish, "message": {"content": content}}]}
                with self.assertRaises(GatewayError):
                    Models(settings(), transport).generate(request())

    def test_limits_enforced_server_side(self):
        value = request()
        value["messages"] = [{"role": "them", "text": "字"*800} for _ in range(11)]
        with self.assertRaisesRegex(GatewayError, "8,000"):
            validate_request(value)

    def test_markdown_wrapped_json_is_rejected_without_repair(self):
        content = '```json\n' + json.dumps({'candidates': [{'text': c['text']} for c in candidates()]}) + '\n```'
        response = {'choices': [{'finish_reason': 'stop', 'message': {'content': content}}]}
        with self.assertRaisesRegex(GatewayError, 'JSON 无效'):
            Models(settings(), lambda *a: response).generate(request())

    def test_no_untrusted_decision_endpoint_or_plain_http(self):
        for url in ["https://attacker.example/compatible-mode/v1/systemone",
                    "http://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone",
                    "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone?key=secret"]:
            with self.subTest(url=url), self.assertRaises(GatewayError):
                validate_endpoint(url, decision=True)


class ConfigurationTests(unittest.TestCase):
    def test_direct_configuration_and_environment_precedence(self):
        with tempfile.TemporaryDirectory() as folder:
            env = Path(folder)/'.env'
            env.write_text('DECISION_PROVIDER=bailian\nDASHSCOPE_API_KEY=decision-only\n'
                           'BAILIAN_SYSTEMONE_URL=https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone\n'
                           'LLM_BASE_URL=https://generator.example/v1\nLLM_MODEL=chosen-model\n'
                           'LLM_API_KEY=generation-only\n', encoding='utf-8')
            with patch.dict(os.environ, {}, clear=True):
                config = Settings.load(env)
                self.assertEqual(config.decision_key, 'decision-only')
                self.assertEqual(config.llm_key, 'generation-only')
                self.assertEqual(config.llm_model, 'chosen-model')
                self.assertFalse(config.missing('生成'))
                self.assertFalse(config.missing('决策'))
            with patch.dict(os.environ, {'LLM_MODEL': 'process-model'}, clear=True):
                self.assertEqual(Settings.load(env).llm_model, 'process-model')

    def test_token_plan_never_uses_ordinary_or_anthropic_key(self):
        with tempfile.TemporaryDirectory() as folder:
            env = Path(folder)/'.env'
            env.write_text('DECISION_PROVIDER=bailian-token-plan\nDASHSCOPE_API_KEY=wrong\n'
                           'ANTHROPIC_AUTH_TOKEN=also-wrong\n', encoding='utf-8')
            with patch.dict(os.environ, {}, clear=True):
                config = Settings.load(env)
                self.assertFalse(config.decision_key)
                self.assertIn('BAILIAN_TOKEN_PLAN_API_KEY', config.missing('决策'))


class HttpTests(unittest.TestCase):
    def test_duplicate_gateway_on_same_port_is_rejected(self):
        with self.assertRaises(OSError):
            duplicate = make_server(Models(Settings()), self.server.server_port)
            duplicate.server_close()

    def setUp(self):
        self.server = make_server(Models(Settings()), 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_browser_origin_rejected_before_model_call(self):
        req = urllib.request.Request(self.base+'/v1/replies/generate', data=b'{}', headers={
            'Origin': 'https://attacker.example', 'Content-Type': 'application/json', 'X-Quick-Reply': 'v1'})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req)
        self.assertEqual(caught.exception.code, 403)
        self.assertIsNone(caught.exception.headers.get('Access-Control-Allow-Origin'))

    def test_extension_receives_sanitized_missing_config_error(self):
        req = urllib.request.Request(self.base+'/v1/replies/generate', data=json.dumps(request()).encode(), headers={
            'Origin': 'chrome-extension://'+'a'*32, 'Content-Type': 'application/json', 'X-Quick-Reply': 'v1'})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req)
        self.assertEqual(caught.exception.code, 503)
        self.assertIn('LLM_MODEL', json.load(caught.exception)['error'])

    def test_upstream_errors_do_not_echo_secret_response(self):
        error = urllib.error.HTTPError('https://example.invalid', 401, 'secret response', {}, None)
        with patch('urllib.request.OpenerDirector.open', side_effect=error):
            with self.assertRaisesRegex(GatewayError, '生成接口失败：HTTP 401') as caught:
                post_json('https://example.invalid', 'top-secret', {}, 1, '生成')
            self.assertNotIn('secret', str(caught.exception))


class PostModelTests(unittest.TestCase):
    """quick-post endpoints. Topic lists and model responses below are test doubles."""

    def topics(self):
        return [{"id": "t1", "rank": 1, "title": "A股跌破3600点资金出逃", "summary": "资金出逃，市场信心受挫。",
                 "tags": ["A股"], "repliesCount": 1053},
                {"id": "t2", "rank": 2, "title": "币安推出 Agentic Wallet 功能", "summary": "配置 AI 技能获取代币奖励。",
                 "tags": ["币安", "Agent ID"], "repliesCount": 626}]

    def fetch_request(self):
        return {"schemaVersion": "quick-post.v1", "kind": "original-post"}

    def post_request(self):
        return {"schemaVersion": "quick-post.v1", "kind": "original-post",
                "selectedTopic": {"id": "t2", "title": "币安推出 Agentic Wallet 功能",
                                  "summary": "用户通过创建 Agent ID 并配置 AI 技能获取代币奖励。"},
                "language": "auto", "tone": "natural",
                "postPrompt": "吸引大家留言互动，结尾用低门槛问题。", "postExamples": ""}

    def topic_answer(self, choice="t2"):
        return {"model": "decision-model-preview", "answers": {"best_topic": {
            "type": "choice", "choice": choice, "confidence": 0.7,
            "probabilities": {"t1": 0.1, "t2": 0.7, "__none__": 0.2}}}}

    def post_items(self):
        return [{"text": f"帖文{i}：你会把钱交给 AI 打理到哪一步？四选一。",
                 "checkNotes": ["发布前核实：奖励机制属实"]} for i in range(1, 6)]

    def models(self, transport=None, fetch=None):
        calls = []
        def default_transport(*args):
            calls.append(args)
            return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({
                "candidates": self.post_items()})}}]}
        return Models(settings(), transport or default_transport,
                      fetch or (lambda timeout: self.topics())), calls

    def test_fetch_returns_top_topics_from_the_only_data_source(self):
        models, _ = self.models(fetch=lambda timeout: parse_hot_topics(
            {"topics": [{"rank": i, **{k: v for k, v in t.items() if k != "rank"}} for i, t in enumerate(self.topics(), 1)]}))
        result = models.topics_fetch(self.fetch_request())
        self.assertEqual(result["schemaVersion"], "quick-post.v1")
        self.assertEqual(result["source"], "xzhishu-topics-hot")
        self.assertEqual([t["id"] for t in result["topics"]], ["t1", "t2"])

    def test_fetch_response_shape_is_strict_and_zero_items_stop(self):
        for bad in [{}, {"topics": []}, {"topics": [{"id": "t1", "title": "缺字段"}]},
                    {"topics": [dict(self.topics()[0], summary=123)]},
                    {"topics": [dict(self.topics()[0], repliesCount=-1)]},
                    {"topics": [self.topics()[0], self.topics()[0]]}]:
            with self.subTest(bad=str(bad)[:60]), self.assertRaises(GatewayError) as caught:
                parse_hot_topics(bad)
            self.assertIn("topics.fetch.parse", str(caught.exception))

    def test_fetch_request_rejects_wrong_schema_or_kind(self):
        models, _ = self.models()
        for bad in [{}, {"schemaVersion": "quick-reply.v2", "kind": "original-post"},
                    {"schemaVersion": "quick-post.v1", "kind": "public-reply"}]:
            with self.subTest(bad=str(bad)), self.assertRaises(GatewayError) as caught:
                models.topics_fetch(bad)
            self.assertEqual(caught.exception.status, 400)

    def test_topics_decide_uses_choice_and_preserves_abstention(self):
        seen = {}
        def transport(url, key, payload, timeout, stage):
            seen["instructions"] = payload["questions"]["best_topic"]["instructions"]
            seen["criteria"] = set(payload["questions"]["best_topic"]["criteria"])
            return self.topic_answer()
        models, _ = self.models(transport=transport)
        result = models.topics_decide({**self.fetch_request(), "topics": self.topics()})
        self.assertIn(models.post_policy, seen["instructions"])
        self.assertEqual(seen["criteria"], {"t1", "t2", "__none__"})
        self.assertEqual(result["selectedId"], "t2")
        self.assertFalse(result["reviewRequired"])

        def reject(*args):
            return self.topic_answer(choice="__none__")
        models, _ = self.models(transport=reject)
        abstain = models.topics_decide({**self.fetch_request(), "topics": self.topics()})
        self.assertIsNone(abstain["selectedId"])
        self.assertTrue(abstain["reviewRequired"])

    def test_topics_decide_rejects_invalid_payloads_without_model_call(self):
        models, calls = self.models(transport=lambda *a: self.fail("unexpected model call"))
        for bad in [{**self.fetch_request(), "topics": []},
                    {**self.fetch_request(), "topics": [dict(self.topics()[0], title="")]},
                    {**self.fetch_request(), "topics": [self.topics()[0], self.topics()[0]]}]:
            with self.subTest(bad=str(bad)[:60]), self.assertRaises(GatewayError) as caught:
                models.topics_decide(bad)
            self.assertEqual(caught.exception.status, 400)
        self.assertEqual(calls, [])

    def test_posts_generate_returns_five_candidates_with_check_notes(self):
        models, calls = self.models()
        result = models.posts_generate(self.post_request())
        self.assertEqual(result["schemaVersion"], "quick-post.v1")
        self.assertEqual(len(result["candidates"]), 5)
        self.assertEqual(result["candidates"][0]["id"], "c1")
        self.assertEqual(result["candidates"][0]["checkNotes"], ["发布前核实：奖励机制属实"])
        self.assertEqual(result["meta"]["promptVersion"], "post-policy.v1")
        self.assertIn(models.post_policy, calls[0][2]["messages"][0]["content"])
        body = json.loads(calls[0][2]["messages"][1]["content"])
        self.assertEqual(body["selectedTopic"]["id"], "t2")
        self.assertEqual(body["postPrompt"], "吸引大家留言互动，结尾用低门槛问题。")

    def test_posts_generate_rejects_bad_shapes_without_partial_output(self):
        def run(items):
            def transport(*args):
                return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({
                    "candidates": items})}}]}
            Models(settings(), transport, lambda timeout: self.topics()).posts_generate(self.post_request())
        for items, pattern in [(self.post_items()[:4], "恰好为 5"),
                               (self.post_items()[:1] + [{"text": "字" * 281, "checkNotes": []}] + self.post_items()[2:], "1–280"),
                               (self.post_items()[:1] + [{"text": self.post_items()[0]["text"], "checkNotes": []}] + self.post_items()[2:], "重复"),
                               (self.post_items()[:1] + [{"text": "合法帖文", "checkNotes": ["字" * 121]}] + self.post_items()[2:], "1–120")]:
            with self.subTest(pattern=pattern), self.assertRaisesRegex(GatewayError, pattern):
                run(items)

    def test_posts_generate_request_is_strict(self):
        for bad in [{}, {**self.post_request(), "postPrompt": ""},
                    {**self.post_request(), "selectedTopic": {"id": "t2", "title": "标题"}},
                    {**self.post_request(), "language": "zh-CN"},
                    {**self.post_request(), "postExamples": "字" * 3001}]:
            with self.subTest(bad=str(bad)[:60]), self.assertRaises(GatewayError) as caught:
                validate_post_generate_request(bad)
            self.assertEqual(caught.exception.status, 400)

    def test_unreadable_post_policy_stops_instead_of_builtin_text(self):
        real = Path.read_text
        def broken(self, *args, **kwargs):
            if self.name == "post-policy.md":
                raise OSError("unreadable")
            return real(self, *args, **kwargs)
        with patch.object(Path, "read_text", broken):
            with self.assertRaisesRegex(GatewayError, "无法读取共同发帖规则"):
                Models(settings(), lambda *a: self.fail("unexpected network"))

    def test_fetch_failure_propagates_its_stage_and_skips_decision(self):
        def broken_fetch(timeout):
            raise GatewayError("话题榜单获取失败（阶段 topics.fetch）：HTTP 404", 502)
        models, calls = self.models(fetch=broken_fetch,
                                    transport=lambda *a: self.fail("must stop before model call"))
        with self.assertRaisesRegex(GatewayError, "topics.fetch"):
            models.topics_fetch(self.fetch_request())
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
