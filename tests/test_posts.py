"""quick-post endpoints: one post per topic with an optional recommendation.

Topic lists, tweets payloads and model responses below are test doubles;
they never replace live xzhishu or model verification.
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gateway import (GatewayError, Models, Settings, parse_hot_tweets,
                     validate_post_generate_request)


def settings():
    return Settings("https://generator.example/v1", "my-model", "generation-secret",
                    "bailian", "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone",
                    "decision-secret")


def topics():
    return [
        {"id": "t1", "rank": 1, "title": "话题一", "summary": "摘要一。",
         "tags": ["a"], "repliesCount": 10},
        {"id": "t2", "rank": 2, "title": "话题二", "summary": "摘要二。",
         "tags": ["b"], "repliesCount": 20},
    ]


def post_items(count=2):
    return [{"topicId": f"t{i+1}", "text": f"帖文{i+1}：你会怎么选？四选一。",
             "checkNotes": ["发布前核实：机制属实"]} for i in range(count)]


def post_request():
    return {"schemaVersion": "quick-post.v1", "kind": "original-post",
            "topics": topics(), "language": "auto", "tone": "natural",
            "postPrompt": "吸引大家留言互动，结尾用低门槛问题。", "postExamples": ""}


def post_decision(choice="c1"):
    return {"model": "decision-model-preview", "answers": {"best_post": {
        "type": "choice", "choice": choice, "confidence": 0.7,
        "probabilities": {"c1": 0.5, "c2": 0.3, "__none__": 0.2}}}}


class PostModelTests(unittest.TestCase):
    def models(self, transport=None, fetch=None):
        calls = []

        def default_transport(*args):
            calls.append(args)
            return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({
                "candidates": post_items(len(args[2].get("topics", topics())))})}}]}
        return Models(settings(), transport or default_transport,
                      fetch or (lambda timeout, source, categories=(): topics())), calls

    def test_generation_writes_exactly_one_post_per_topic(self):
        models, calls = self.models()
        result = models.posts_generate(post_request())
        self.assertEqual(len(result["candidates"]), 2)
        self.assertEqual([item["topicId"] for item in result["candidates"]], ["t1", "t2"])
        self.assertEqual(result["candidates"][0]["id"], "c1")
        self.assertEqual(result["meta"]["promptVersion"], "post-policy.v2")
        self.assertIn(models.post_policy, calls[0][2]["messages"][0]["content"])
        self.assertIn("直接问一个具体问题", calls[0][2]["messages"][0]["content"])
        self.assertIn("不要为了互动硬加", calls[0][2]["messages"][0]["content"])
        body = json.loads(calls[0][2]["messages"][1]["content"])
        self.assertEqual([t["id"] for t in body["topics"]], ["t1", "t2"])

    def test_user_post_examples_teach_style_without_becoming_facts(self):
        models, calls = self.models()
        request = {**post_request(), "postExamples": "有没有觉得这个价格有点贵啊\n\n大家怎么觉得？？？"}
        models.posts_generate(request)
        system = calls[0][2]["messages"][0]["content"]
        self.assertIn("句式、分行、口语标点、追问节奏", system)
        self.assertIn("不能照抄其中的内容、人物、经历", system)

    def test_generation_rejects_missing_or_duplicated_topic_coverage(self):
        def run(items):
            def transport(*args):
                return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({
                    "candidates": items})}}]}
            Models(settings(), transport, lambda timeout, source, categories=(): topics()).posts_generate(post_request())
        for items, pattern in [
            (post_items(1), "一致"),
            (post_items()[:1] + [{"topicId": "t1", "text": "重复覆盖", "checkNotes": []}], "topicId"),
            (post_items()[:1] + [{"topicId": "t9", "text": "未知话题", "checkNotes": []}], "topicId"),
            ([dict(post_items()[0], text="字" * 281)] + post_items()[1:], "1–280"),
        ]:
            with self.subTest(pattern=pattern), self.assertRaisesRegex(GatewayError, pattern):
                run(items)

    def test_generate_request_requires_a_topic_list(self):
        for bad in [{}, {**post_request(), "topics": []},
                    {**post_request(), "topics": [dict(topics()[0], title="")]}]:
            with self.subTest(bad=str(bad)[:60]), self.assertRaises(GatewayError) as caught:
                validate_post_generate_request(bad)
            self.assertEqual(caught.exception.status, 400)

    def test_decision_recommends_one_post_or_abstains(self):
        seen = {}

        def transport(url, key, payload, timeout, stage):
            seen["instructions"] = payload["questions"]["best_post"]["instructions"]
            seen["criteria"] = set(payload["questions"]["best_post"]["criteria"])
            return post_decision("c2")
        models, _ = self.models(transport=transport)
        result = models.posts_decide({**post_request(), "candidates": post_items()})
        self.assertIn(models.post_policy, seen["instructions"])
        self.assertEqual(seen["criteria"], {"c1", "c2", "__none__"})
        self.assertEqual(result["selectedId"], "c2")
        self.assertFalse(result["reviewRequired"])

        def reject(*args):
            return post_decision("__none__")
        models, _ = self.models(transport=reject)
        abstain = models.posts_decide({**post_request(), "candidates": post_items()})
        self.assertIsNone(abstain["selectedId"])
        self.assertTrue(abstain["reviewRequired"])

    def test_decision_rejects_malformed_payloads_without_model_call(self):
        models, calls = self.models(transport=lambda *a: self.fail("unexpected model call"))
        for bad in [{**post_request(), "candidates": []},
                    {**post_request(), "candidates": post_items(1)}]:
            with self.subTest(bad=str(bad)[:60]), self.assertRaises(GatewayError):
                models.posts_decide(bad)
        self.assertEqual(calls, [])


class TweetBoardTests(unittest.TestCase):
    def tweets_payload(self):
        return {"updatedAt": 1, "items": [
            {"id": "w1", "contentType": "note_tweet", "rank": 1, "category": "AI",
             "content": "一条很热的推文正文，讲的是大家都在聊的事。", "comments": 836},
            {"id": "w2", "contentType": "article", "rank": 2, "category": "社会观察",
             "articleTitle": "长文标题", "articlePreview": "长文预览片段。", "comments": 12},
            {"id": "w3", "contentType": "normal", "rank": 3, "category": "其他",
             "content": "第三条推文。", "comments": 5},
        ]}

    def test_hot_tweets_are_normalized_into_topic_shape(self):
        got = parse_hot_tweets(self.tweets_payload())
        self.assertEqual([t["id"] for t in got], ["w1", "w2", "w3"])
        self.assertEqual(got[0]["title"], "一条很热的推文正文，讲的是大家都在聊的事。")
        self.assertEqual(got[0]["repliesCount"], 836)
        self.assertEqual(got[0]["tags"], ["AI"])
        self.assertEqual(got[1]["title"], "长文标题")
        self.assertIn("长文预览片段。", got[1]["summary"])

    def test_explicit_category_selection_filters_before_taking_five(self):
        got = parse_hot_tweets(self.tweets_payload(), categories={"AI", "其他"})
        self.assertEqual([t["id"] for t in got], ["w1", "w3"])
        with self.assertRaisesRegex(GatewayError, "类别"):
            parse_hot_tweets(self.tweets_payload(), categories={"不存在的类别"})

    def test_empty_or_invalid_tweets_board_stops_with_its_stage(self):
        for bad in [{}, {"items": []}, {"items": [{"id": "w1", "rank": 1, "content": "", "comments": 0}]},
                    {"items": [{"id": "w1", "rank": 1, "content": "正文", "comments": -3}]}]:
            with self.subTest(bad=str(bad)[:60]), self.assertRaises(GatewayError) as caught:
                parse_hot_tweets(bad)
            self.assertIn("topics.fetch.parse", str(caught.exception))

    def test_topics_board_rejects_category_filtering_explicitly(self):
        seen = []

        def fetch(timeout, source, categories=()):
            seen.append((source, tuple(categories)))
            return topics()
        models = Models(settings(), lambda *a: self.fail("unexpected model call"), fetch)
        with self.assertRaisesRegex(GatewayError, "类别筛选"):
            models.topics_fetch({"schemaVersion": "quick-post.v1", "kind": "original-post",
                                 "source": "topics", "categories": ["AI"]})
        result = models.topics_fetch({"schemaVersion": "quick-post.v1", "kind": "original-post",
                                      "source": "tweets", "categories": ["AI", "AI"]})
        self.assertEqual(result["source"], "xzhishu-tweets-hot")
        self.assertEqual(seen[-1], ("tweets", ("AI",)))
        with self.assertRaisesRegex(GatewayError, "source"):
            models.topics_fetch({"schemaVersion": "quick-post.v1", "kind": "original-post", "source": "blogs"})


if __name__ == "__main__":
    unittest.main()
