"""
_common.py — SwanLab 工具的共享管线（非工具）。

只负责：读配置、注入凭证、构造 swanlab.Api、统一错误/输出纪律。
不含任何业务逻辑——每个真正的「工具」是 tools/ 下一个单一职责的脚本。

配置读取自 ~/.navi/config.toml 的 [swanlab] 段（字段名对应 SwanLab 官方环境变量）：

    [swanlab]
    api_host = "http://host:port/api"   # SWANLAB_API_HOST；SwanLab 云可留空
    web_host = "http://host:port"       # SWANLAB_WEB_HOST；可留空
    api_key  = "xxxx"                    # SWANLAB_API_KEY
    username = "your-name"              # 默认 workspace，可选
    project  = "your-project"           # 默认项目，可选
"""
import contextlib
import io
import json
import os
import sys

CONFIG_PATH = os.path.expanduser("~/.navi/config.toml")

# 配置字段 -> SwanLab 官方环境变量
ENV_MAP = {
    "api_host": "SWANLAB_API_HOST",
    "web_host": "SWANLAB_WEB_HOST",
    "api_key": "SWANLAB_API_KEY",
}


def eprint(*a, **k):
    print(*a, file=sys.stderr, **k)


def emit(obj):
    """把裸数据以 JSON 写到 stdout。"""
    print(json.dumps(obj, ensure_ascii=False, default=str))


def die(msg, code=2):
    print(json.dumps({"error": msg}, ensure_ascii=False))
    sys.exit(code)


@contextlib.contextmanager
def quiet():
    """把 SwanLab 的 print/横幅吞进 stderr，保持 stdout 干净。"""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            yield
        finally:
            txt = buf.getvalue()
            if txt.strip():
                eprint(txt.rstrip())


def _load_config():
    try:
        import tomllib
    except ModuleNotFoundError:  # py<3.11
        import tomli as tomllib  # type: ignore
    if not os.path.exists(CONFIG_PATH):
        die(f"未找到配置文件 {CONFIG_PATH}，请创建并填写 [swanlab] 段（api_host / api_key）。")
    with open(CONFIG_PATH, "rb") as f:
        data = tomllib.load(f)
    cfg = data.get("swanlab")
    if not cfg:
        die("config.toml 中缺少 [swanlab] 段，请填写 api_host / api_key。")
    if not cfg.get("api_key"):
        die("[swanlab] 缺少 api_key。")
    return cfg


def _get_api(cfg):
    """通过 SwanLab 官方环境变量注入凭证再构造 Api()，与 shell 中 export 行为一致，
    由 SDK 自身处理 /api 归一化与 web_host 推导。环境变量须在 import swanlab 前设置。"""
    for field, env in ENV_MAP.items():
        val = (cfg.get(field) or "").strip()
        if val:
            os.environ[env] = val
    with quiet():
        import swanlab

        return swanlab.Api()


@contextlib.contextmanager
def session():
    """统一入口：产出 (cfg, api)，并把所有异常收敛成单行 JSON 错误。"""
    try:
        cfg = _load_config()
        api = _get_api(cfg)  # swanlab.Api 构造即校验鉴权
        yield cfg, api
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        die(f"{type(e).__name__}: {e}")


def add_path_args(ap):
    ap.add_argument("--path", help="username/project/run_id")
    ap.add_argument("--username")
    ap.add_argument("--project")
    ap.add_argument("--exp", help="run_id")


def resolve_path(api, cfg, args):
    """组装 'username/project/run_id'。优先 --path，否则用 --username/--project/--exp + 配置默认。"""
    if getattr(args, "path", None):
        return args.path
    username = getattr(args, "username", None) or cfg.get("username") or api.username
    project = getattr(args, "project", None) or cfg.get("project")
    exp = getattr(args, "exp", None)
    if not (username and project and exp):
        die("需要完整实验路径：用 --path username/project/run_id，或同时给出 --username/--project/--exp。")
    return f"{username}/{project}/{exp}"


def exp_brief(exp):
    """从 Experiment 对象抽取可 JSON 化的元信息，原样透传。"""
    out = {}
    for attr in ("name", "state", "run_id", "url", "description", "group",
                 "job_type", "created_at", "finished_at"):
        try:
            val = getattr(exp, attr)
        except Exception:
            continue
        if val is not None:
            out[attr] = val
    return out
