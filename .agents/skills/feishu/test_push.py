import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("push.py")
SPEC = importlib.util.spec_from_file_location("feishu_push", MODULE_PATH)
assert SPEC and SPEC.loader
push = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(push)


class NormalizeLarkMdTest(unittest.TestCase):
    def test_converts_atx_headings(self):
        content = "# 一级\n\n## 总览\n### 任务 ###\n正文\n"

        self.assertEqual(
            push.normalize_lark_md(content),
            "**一级**\n\n**总览**\n**任务**\n正文\n",
        )

    def test_preserves_fenced_code(self):
        content = "## 标题\n```markdown\n### 示例\n```\n"

        self.assertEqual(
            push.normalize_lark_md(content),
            "**标题**\n```markdown\n### 示例\n```\n",
        )

    def test_plain_text_payload_is_unchanged(self):
        content = "## 原样文本"

        payload = push.build_payload({"content": content})

        self.assertEqual(payload["content"]["text"], content)

    def test_card_payload_uses_normalized_content(self):
        payload = push.build_payload(
            {"title": "巡检", "content": "## 总览\n### 任务"}
        )

        self.assertEqual(
            payload["card"]["elements"][0]["text"]["content"],
            "**总览**\n**任务**",
        )


if __name__ == "__main__":
    unittest.main()
