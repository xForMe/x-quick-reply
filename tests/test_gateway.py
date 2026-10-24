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
                     post_json, validate_endpoint, validate_request)


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


if __name__ == '__main__':
    unittest.main()
