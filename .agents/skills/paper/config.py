"""读 ~/.navi/config.toml，解析 [paper]/[zotero]，构造 PaperQA Settings 与缓存路径。

配置统一在 ~/.navi/config.toml：
    [paper]
    cache     = "~/.navi/paper-cache"
    api_key   = "sk-..."                       # SiliconFlow key
    base_url  = "https://api.siliconflow.cn/v1"
    llm       = "zai-org/GLM-5.2"
    embedding = "Qwen/Qwen3-Embedding-8B"

    [zotero]
    api_key = "..."                            # Zotero Web API key
    user_id = "..."
    webdav_url      = "https://.../zotero/"     # 附件 zip 走 WebDAV
    webdav_user     = "..."
    webdav_password = "..."
"""

import os
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # py<3.11
    import tomli as tomllib  # type: ignore

from paperqa import Settings

CONFIG_PATH = Path("~/.navi/config.toml").expanduser()


def _load_toml():
    with open(CONFIG_PATH, "rb") as f:
        return tomllib.load(f)


def load() -> dict:
    if not CONFIG_PATH.exists():
        raise SystemExit(
            f"未找到 {CONFIG_PATH}，请添加 [paper] 段（cache / api_key）。"
        )
    data = _load_toml()
    paper = data.get("paper") or {}
    if not paper.get("api_key"):
        raise SystemExit("config.toml 缺少 [paper].api_key（SiliconFlow key）。")
    cache = Path(os.path.expanduser(paper.get("cache", "~/.navi/paper-cache")))
    return {
        "cache": cache,
        "pdf_dir": cache / "pdfs",
        "index_dir": cache / "index",
        "manifest": cache / "manifest.json",
        "pqa_manifest": cache / "paperqa_manifest.csv",
        "api_key": paper["api_key"],
        "base_url": paper.get("base_url", "https://api.siliconflow.cn/v1"),
        "llm": paper.get("llm", "zai-org/GLM-5.2"),
        "embedding": paper.get("embedding", "Qwen/Qwen3-Embedding-8B"),
        # 每批嵌入的文本数。高维向量（如 Qwen3-Embedding-8B 4096 维）批量过大时
        # SiliconFlow 的响应体会被截断（~1MB）→ JSON 解析失败而整次建索引中断；
        # 故默认压到 4（每响应 ~260KB，远低于截断点），可在 [paper] 调。
        "embedding_batch": int(paper.get("embedding_batch", 4)),
        "concurrency": int(paper.get("concurrency", 4)),
        "zotero": data.get("zotero") or {},
    }


def ensure_dirs(cfg: dict) -> None:
    cfg["pdf_dir"].mkdir(parents=True, exist_ok=True)
    cfg["index_dir"].mkdir(parents=True, exist_ok=True)


def paperqa_settings(cfg: dict):
    base, key = cfg["base_url"], cfg["api_key"]
    os.environ["OPENAI_API_KEY"] = key
    os.environ["OPENAI_BASE_URL"] = base
    os.environ["OPENAI_API_BASE"] = base
    kw_llm = {"api_base": base, "api_key": key}
    kw_embed = {"api_base": base, "api_key": key, "encoding_format": "float"}
    llm = f"openai/{cfg['llm']}"
    return Settings(
        llm=llm,
        summary_llm=llm,
        llm_config={"kwargs": kw_llm},
        summary_llm_config={"kwargs": kw_llm},
        embedding=f"openai/{cfg['embedding']}",
        embedding_config={"batch_size": cfg["embedding_batch"], "kwargs": kw_embed},
        parsing={"multimodal": "off", "use_doc_details": False},
        agent={
            "agent_llm": llm,
            "agent_llm_config": {"kwargs": kw_llm},
            "agent_type": "fake",
            "index": {
                "name": "navi-paper",
                "paper_directory": str(cfg["pdf_dir"]),
                "index_directory": str(cfg["index_dir"]),
                "manifest_file": str(cfg["pqa_manifest"]),
                "sync_with_paper_directory": True,
                "recurse_subdirectories": False,
                "concurrency": cfg["concurrency"],
            },
        },
    )
