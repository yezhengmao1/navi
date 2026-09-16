import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import paper


class AskTests(unittest.TestCase):
    def test_ask_passes_configured_agent_type(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf_dir = Path(tmp)
            (pdf_dir / "paper.pdf").touch()
            settings = SimpleNamespace(
                agent=SimpleNamespace(agent_type="fake"),
            )
            cfg = {"pdf_dir": pdf_dir}
            response = SimpleNamespace(
                session=SimpleNamespace(formatted_answer="answer")
            )

            with (
                patch.object(paper.config, "paperqa_settings", return_value=settings),
                patch.object(
                    paper, "_install_lmi_select_tool_compat"
                ) as install_compat,
                patch.object(
                    paper, "agent_query", AsyncMock(return_value=response)
                ) as query,
                patch("builtins.print"),
            ):
                asyncio.run(paper.cmd_ask(cfg, question="question"))
            install_compat.assert_called_once_with()

            query.assert_awaited_once_with(
                query="question", settings=settings, agent_type="fake"
            )

    def test_installs_known_lmi_aviary_compatibility_fix(self):
        from lmi import LiteLLMModel

        original = LiteLLMModel.select_tool
        versions = {"fhlmi": "1.0.5", "fhaviary": "0.35.0"}
        try:
            with patch.object(
                paper, "package_version", side_effect=versions.__getitem__
            ):
                paper._install_lmi_select_tool_compat()

            self.assertTrue(LiteLLMModel.select_tool._navi_compat)
        finally:
            LiteLLMModel.select_tool = original


if __name__ == "__main__":
    unittest.main()
