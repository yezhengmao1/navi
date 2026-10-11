#!/usr/bin/env python3
"""Read-only OKX regular orders. Python 3.11+, standard library only."""
import argparse
import base64
import calendar
import hashlib
import hmac
import json
import re
import sys
import time
import tomllib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, HTTPRedirectHandler, build_opener

UTC = timezone.utc
CONFIG_PATH = Path.home() / '.navi/config.toml'
TYPES = ('SPOT', 'MARGIN', 'SWAP', 'FUTURES', 'OPTION')
PATHS = ('/api/v5/trade/orders-pending', '/api/v5/trade/orders-history',
         '/api/v5/trade/orders-history-archive')


ACCOUNT_PATHS = ('/api/v5/account/positions', '/api/v5/account/balance')


class OKXError(Exception):
    pass


def months_ago(now, months):
    index = now.year * 12 + now.month - 1 - months
    year, month = divmod(index, 12)
    month += 1
    return now.replace(year=year, month=month,
                       day=min(now.day, calendar.monthrange(year, month)[1]))


def parse_datetime(value):
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise OKXError('时间格式无效，请使用 ISO 8601，例如 2026-10-01T00:00:00+08:00。') from None
    if dt.tzinfo is None:
        raise OKXError('起止时间必须带时区，例如 Z 或 +08:00。')
    return dt.astimezone(UTC)


def time_window(args, now):
    if args.start or args.end:
        if args.since:
            raise OKXError('--since 不能与 --start/--end 混用。')
        if not args.start:
            raise OKXError('--end 需要同时指定 --start。')
        start = parse_datetime(args.start)
        end = parse_datetime(args.end) if args.end else now
    else:
        value = args.since or '1mo'
        match = re.fullmatch(r'~?(\d+)(m|h|d|w|mo)', value)
        if not match or int(match[1]) <= 0:
            raise OKXError('时间范围应为 ~10h、14d、2w 或 1mo（m 为分钟，mo 为日历月）。')
        count, unit = int(match[1]), match[2]
        try:
            start = (months_ago(now, count) if unit == 'mo' else
                     now - timedelta(seconds=count * {'m': 60, 'h': 3600, 'd': 86400, 'w': 604800}[unit]))
        except (ValueError, OverflowError):
            raise OKXError('时间范围过大。') from None
        end = now
    if start >= end:
        raise OKXError('开始时间必须早于结束时间。')
    if end > now:
        raise OKXError('结束时间不能晚于现在。')
    if start < months_ago(now, 3):
        raise OKXError('查询起点超过 OKX 常规历史订单近 3 个月范围；请缩短范围或从 OKX 导出历史记录。')
    return start, end


def load_config(path=CONFIG_PATH):
    try:
        with path.open('rb') as f:
            cfg = tomllib.load(f).get('okx', {})
    except FileNotFoundError:
        raise OKXError('请在 ~/.navi/config.toml 配置 [okx] 的 api_key、secret_key、passphrase。') from None
    except (OSError, tomllib.TOMLDecodeError):
        raise OKXError('无法读取 Navi 配置或 TOML 格式无效。') from None
    if not isinstance(cfg, dict) or any(not isinstance(cfg.get(k), str) or not cfg[k].strip()
                                      for k in ('api_key', 'secret_key', 'passphrase')):
        raise OKXError('[okx] 缺少 api_key、secret_key 或 passphrase。')
    # Restrict credential destinations; never accept an arbitrary URL.
    host = cfg.get('base_url', 'https://www.okx.com')
    if host not in ('https://www.okx.com', 'https://us.okx.com', 'https://eea.okx.com'):
        raise OKXError('[okx].base_url 必须是支持的 OKX 官方 HTTPS 地址，详见 SKILL.md。')
    if not isinstance(cfg.get('simulated', False), bool):
        raise OKXError('[okx].simulated 必须为 true 或 false。')
    return {**cfg, 'base_url': host}


def signature(secret, timestamp, request_path):
    payload = (timestamp + 'GET' + request_path).encode()
    return base64.b64encode(hmac.new(secret.encode(), payload, hashlib.sha256).digest()).decode()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward credentials to a redirect target.


class Client:
    def __init__(self, cfg):
        self.cfg = cfg
        self.opener = build_opener(NoRedirect())

    def get(self, path, params):
        if path not in PATHS + ACCOUNT_PATHS:
            raise OKXError('只允许查询订单、当前持仓和交易账户余额的只读接口。')
        request_path = path + ('?' + urlencode(params) if params else '')
        for attempt in range(4):
            timestamp = datetime.now(UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            headers = {
                'OK-ACCESS-KEY': self.cfg['api_key'],
                'OK-ACCESS-SIGN': signature(self.cfg['secret_key'], timestamp, request_path),
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': self.cfg['passphrase'],
                'User-Agent': 'navi-okx-readonly/1.0',
            }
            if self.cfg.get('simulated', False):
                headers['x-simulated-trading'] = '1'
            try:
                req = Request(self.cfg['base_url'] + request_path, headers=headers, method='GET')
                with self.opener.open(req, timeout=30) as response:
                    body = json.load(response)
            except HTTPError as exc:
                if (exc.code == 429 or exc.code >= 500) and attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                raise OKXError(f'OKX HTTP {exc.code}；请检查网络、区域域名及 API 只读权限。') from None
            except (URLError, TimeoutError, OSError):
                if attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                raise OKXError('OKX 网络请求失败（已重试），未返回完整结果。') from None
            except (ValueError, UnicodeError):
                raise OKXError('OKX 返回了无效 JSON。') from None
            if not isinstance(body, dict):
                raise OKXError('OKX 响应格式不正确。')
            code = str(body.get('code', ''))
            if code == '50011' and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            if code != '0':
                safe_code = code if re.fullmatch(r'\d{1,10}', code) else 'unknown'
                raise OKXError(f'OKX API 错误 {safe_code}；请检查凭证、IP 白名单、账户区域和系统时钟。')
            if not isinstance(body.get('data'), list):
                raise OKXError('OKX 响应缺少数据列表。')
            return body['data']
        raise OKXError('OKX 请求重试失败。')


def pages(client, path, params):
    cursor = None
    seen = set()
    while True:
        query = {**params, 'limit': '100'}
        if cursor:
            query['after'] = cursor
        rows = client.get(path, query)
        if not rows:
            return
        for row in rows:
            if not isinstance(row, dict) or not row.get('ordId') or not str(row.get('cTime', '')).isdigit():
                raise OKXError('订单响应缺少有效 ordId/cTime。')
        yield rows
        # Request until an empty page; do not assume short pages mean EOF.
        cursor = rows[-1]['ordId']
        if cursor in seen:
            raise OKXError('OKX 分页游标未前进，无法保证结果完整。')
        seen.add(cursor)
        time.sleep(0.12)


def fetch_orders(client, start, end, inst_types, inst_id=None):
    begin_ms, end_ms = int(start.timestamp() * 1000), int(end.timestamp() * 1000)
    result = {}
    for inst_type in inst_types:
        base = {'instType': inst_type}
        if inst_id:
            base['instId'] = inst_id
        # Archive covers three months; recent history additionally retains recent
        # unfilled canceled orders (only two hours on OKX). Pending has no time filter.
        for path in (PATHS[0], PATHS[2], PATHS[1]):
            params = dict(base)
            if path != PATHS[0]:
                history_begin = begin_ms
                if path == PATHS[1]:
                    history_begin = max(begin_ms, int((datetime.now(UTC) - timedelta(days=7)).timestamp() * 1000))
                if history_begin >= end_ms:
                    continue
                params.update(begin=str(history_begin), end=str(end_ms - 1))
            for rows in pages(client, path, params):
                for row in rows:
                    if begin_ms <= int(row['cTime']) < end_ms:
                        key = (row.get('instType', inst_type), row['ordId'])
                        old = result.get(key)
                        if old is None or int(row.get('uTime') or 0) >= int(old.get('uTime') or 0):
                            result[key] = row
    return sorted(result.values(), key=lambda r: (int(r['cTime']), r['ordId']), reverse=True)


def parser():
    p = argparse.ArgumentParser(description='只读查询 OKX 常规订单；默认从现在往回一个日历月。')
    p.add_argument('command', nargs='?', choices=['orders', 'account'], default='orders')
    p.add_argument('--since', help='~10h / 14d / 2w / 1mo；默认 1mo')
    p.add_argument('--start', help='ISO 8601 起始时间，必须带时区，含此时刻')
    p.add_argument('--end', help='ISO 8601 结束时间，必须带时区，不含此时刻；默认现在')
    p.add_argument('--inst-type', choices=TYPES, action='append', help='可重复；默认所有常规产品类型')
    p.add_argument('--inst-id', help='交易对/合约，例如 BTC-USDT；需同时指定一个 --inst-type')
    p.add_argument('--json', action='store_true', help='输出含查询范围、说明和原始订单字段的 JSON')
    return p


WARNINGS = [
    '按 cTime（创建时间）筛选，区间为 [start, end)，不是按成交/更新时间筛选。',
    '包含当前未完成订单与 API 可返回的历史订单；不含策略/算法委托，非成交明细。',
    'OKX 历史订单最多近 3 个月；未成交即撤销订单通常仅保留 2 小时，空结果不代表从未下单。',
    '多页查询不是账户快照；查询期间订单状态可能变化。数量单位依产品而异，不跨币种加总金额。',
]


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.command == 'account':
            if any((args.since, args.start, args.end, args.inst_type, args.inst_id)):
                raise OKXError('account 查询当前全账户持仓和余额，不接受历史时间或产品筛选参数。')
            cfg = load_config()
            client = Client(cfg)
            started = datetime.now(UTC).isoformat()
            positions = client.get(ACCOUNT_PATHS[0], {})
            balances = client.get(ACCOUNT_PATHS[1], {})
            output = {'query_started_at': started,
                      'queried_at': datetime.now(UTC).isoformat(),
                      'simulated': cfg.get('simulated', False),
                      'positions': positions, 'balances': balances,
                      'warnings': ['持仓与余额分别查询，不是原子快照。',
                                   '余额仅为交易账户，不含资金账户、理财或其他账户。']}
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return 0
        now = datetime.now(UTC)
        start, end = time_window(args, now)
        inst_types = list(dict.fromkeys(args.inst_type or TYPES))
        if args.inst_id and len(inst_types) != 1:
            raise OKXError('--inst-id 需要同时指定唯一的 --inst-type。')
        cfg = load_config()
        orders = fetch_orders(Client(cfg), start, end, inst_types, args.inst_id)
        output = {'start': start.isoformat(), 'end': end.isoformat(), 'time_field': 'cTime',
                  'simulated': cfg.get('simulated', False), 'inst_types': inst_types,
                  'inst_id': args.inst_id, 'count': len(orders), 'warnings': WARNINGS, 'orders': orders}
        if args.json:
            print(json.dumps(output, ensure_ascii=False, indent=2))
        else:
            print(f"{output['start']} ≤ 创建时间 < {output['end']} | {len(orders)} 条 | "
                  + ('模拟盘' if output['simulated'] else '实盘'))
            print('创建时间(UTC)\t产品\t方向\t状态\t委托量\t累计成交量\t均价\t订单ID')
            for row in orders:
                created = datetime.fromtimestamp(int(row['cTime']) / 1000, UTC).isoformat()
                print('\t'.join([created] + [str(row.get(k, '')) for k in
                      ('instId', 'side', 'state', 'sz', 'accFillSz', 'avgPx', 'ordId')]))
            for warning in WARNINGS:
                print('说明：' + warning)
        return 0
    except OKXError as exc:
        print(f'错误：{exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
