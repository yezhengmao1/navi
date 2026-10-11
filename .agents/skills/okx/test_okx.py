import base64
import hashlib
import hmac
import io
import json
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError

import okx


class WindowTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 3, 31, 12, tzinfo=okx.UTC)

    def window(self, *args):
        return okx.time_window(okx.parser().parse_args(list(args)), self.now)

    def test_default_calendar_month(self):
        start, end = self.window()
        self.assertEqual(start, datetime(2026, 2, 28, 12, tzinfo=okx.UTC))
        self.assertEqual(end, self.now)
        self.assertEqual(okx.months_ago(datetime(2024, 3, 31, tzinfo=okx.UTC), 1).day, 29)
        self.assertEqual(okx.months_ago(datetime(2026, 1, 31, tzinfo=okx.UTC), 1).year, 2025)

    def test_relative(self):
        for text, delta in [('~10h', timedelta(hours=10)), ('2w', timedelta(days=14)),
                            ('30m', timedelta(minutes=30)), ('30d', timedelta(days=30))]:
            self.assertEqual(self.window('--since', text)[0], self.now - delta)

    def test_explicit_timezone(self):
        start, end = self.window('--start', '2026-03-01T08:00:00+08:00', '--end', '2026-03-02T00:00:00Z')
        self.assertEqual(start, datetime(2026, 3, 1, tzinfo=okx.UTC))
        self.assertEqual(end.day, 2)

    def test_invalid(self):
        cases = [('--since', '0h'), ('--since', 'garbage'), ('--since', '4mo'),
                 ('--end', '2026-03-01T00:00:00Z'), ('--start', '2026-03-01'),
                 ('--start', '2026-04-01T00:00:00Z'),
                 ('--since', '1h', '--start', '2026-03-01T00:00:00Z'),
                 ('--start', '2026-03-02T00:00:00Z', '--end', '2026-03-01T00:00:00Z')]
        for args in cases:
            with self.subTest(args=args), self.assertRaises(okx.OKXError):
                self.window(*args)


class ConfigAndClientTests(unittest.TestCase):
    def test_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'config.toml'
            with self.assertRaises(okx.OKXError):
                okx.load_config(path)
            config = '[okx]\napi_key="key"\nsecret_key="secret"\npassphrase="pass"\n'
            path.write_text(config)
            self.assertEqual(okx.load_config(path)['base_url'], 'https://www.okx.com')
            for extra in ['base_url="https://evil.example"', 'simulated="false"']:
                path.write_text(config + extra)
                with self.assertRaises(okx.OKXError):
                    okx.load_config(path)
            path.write_text('[okx]\napi_key="key"')
            with self.assertRaises(okx.OKXError):
                okx.load_config(path)

    def client(self):
        return okx.Client(dict(api_key='key', secret_key='secret', passphrase='pass',
                               base_url='https://www.okx.com', simulated=True))

    def test_signature_query_and_headers(self):
        client = self.client()
        response = io.BytesIO(json.dumps({'code': '0', 'data': []}).encode())
        client.opener = Mock()
        client.opener.open.return_value = response
        self.assertEqual(client.get(okx.PATHS[0], {'instType': 'SPOT', 'instId': 'BTC-USDT'}), [])
        req = client.opener.open.call_args.args[0]
        headers = {k.lower(): v for k, v in req.header_items()}
        request_path = '/api/v5/trade/orders-pending?instType=SPOT&instId=BTC-USDT'
        self.assertEqual(req.full_url, 'https://www.okx.com' + request_path)
        self.assertEqual(req.method, 'GET')
        expected = base64.b64encode(hmac.new(b'secret',
            (headers['ok-access-timestamp'] + 'GET' + request_path).encode(), hashlib.sha256).digest()).decode()
        self.assertEqual(headers['ok-access-sign'], expected)
        self.assertEqual(headers['x-simulated-trading'], '1')
        with self.assertRaises(okx.OKXError):
            client.get('/api/v5/trade/order', {})

    @patch('okx.time.sleep')
    def test_retry_and_safe_error(self, sleep):
        client = self.client()
        client.opener = Mock()
        client.opener.open.side_effect = [HTTPError('url', 429, 'private', {}, None),
            io.BytesIO(b'{"code":"0","data":[]}')]
        self.assertEqual(client.get(okx.PATHS[0], {}), [])
        self.assertEqual(sleep.call_count, 1)
        client.opener.open.side_effect = None
        client.opener.open.return_value = io.BytesIO(b'{"code":"50113","msg":"secret"}')
        with self.assertRaises(okx.OKXError) as error:
            client.get(okx.PATHS[0], {})
        self.assertNotIn('secret', str(error.exception))
        self.assertIsNone(okx.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.example'))


class OrdersTests(unittest.TestCase):
    @patch('okx.time.sleep')
    def test_pagination_short_pages(self, sleep):
        client = Mock()
        client.get.side_effect = [[{'ordId': '2', 'cTime': '2'}],
                                  [{'ordId': '1', 'cTime': '1'}], []]
        self.assertEqual(len(list(okx.pages(client, okx.PATHS[0], {}))), 2)
        self.assertEqual(client.get.call_args_list[1].args[1]['after'], '2')
        self.assertEqual(client.get.call_args_list[2].args[1]['after'], '1')

    @patch('okx.time.sleep')
    def test_cursor_loop(self, sleep):
        client = Mock()
        client.get.return_value = [{'ordId': '1', 'cTime': '1'}]
        with self.assertRaises(okx.OKXError):
            list(okx.pages(client, okx.PATHS[0], {}))

    @patch('okx.time.sleep')
    def test_merge_boundaries_and_newest_state(self, sleep):
        end = datetime.now(okx.UTC)
        start = end - timedelta(hours=10)
        begin, finish = int(start.timestamp() * 1000), int(end.timestamp() * 1000)
        def row(id, created, updated, state='filled'):
            return dict(ordId=id, cTime=str(created), uTime=str(updated), state=state, instType='SPOT')
        client = Mock()
        def get(path, params):
            if 'after' in params:
                return []
            if path == okx.PATHS[0]:
                self.assertNotIn('begin', params)
                return [row('1', begin, 1, 'live'), row('old', begin - 1, 1)]
            self.assertEqual(params['end'], str(finish - 1))
            return [row('1', begin, 2), row('2', begin + 1, 2), row('end', finish, 2)]
        client.get.side_effect = get
        result = okx.fetch_orders(client, start, end, ['SPOT'], 'BTC-USDT')
        self.assertEqual([r['ordId'] for r in result], ['2', '1'])
        self.assertEqual(result[1]['state'], 'filled')
        for call in client.get.call_args_list:
            self.assertEqual(call.args[1]['instId'], 'BTC-USDT')

    @patch('okx.load_config')
    def test_invalid_filter_does_not_load_credentials(self, config):
        with patch('sys.stderr', new_callable=io.StringIO):
            self.assertEqual(okx.main(['--inst-id', 'BTC-USDT']), 1)
        config.assert_not_called()

    @patch('okx.fetch_orders', side_effect=okx.OKXError('failure'))
    @patch('okx.load_config', return_value={})
    def test_failure_no_partial_json(self, config, fetch):
        with patch('sys.stdout', new_callable=io.StringIO) as out, patch('sys.stderr', new_callable=io.StringIO):
            self.assertEqual(okx.main(['--json']), 1)
            self.assertEqual(out.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
