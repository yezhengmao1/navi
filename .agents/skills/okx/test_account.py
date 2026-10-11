import io
import json
import unittest
from unittest.mock import Mock, patch

import okx


class AccountTests(unittest.TestCase):
    @patch('okx.Client')
    @patch('okx.load_config', return_value={'simulated': False})
    def test_snapshot(self, config, client):
        client.return_value.get.side_effect = [[], [{'details': []}]]
        with patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(okx.main(['account', '--json']), 0)
        result = json.loads(out.getvalue())
        self.assertEqual(result['positions'], [])
        self.assertEqual(result['balances'], [{'details': []}])
        self.assertEqual(client.return_value.get.call_count, 2)

    @patch('okx.load_config')
    def test_reject_history(self, config):
        with patch('sys.stderr', new_callable=io.StringIO):
            self.assertEqual(okx.main(['account', '--since', '1mo']), 1)
        config.assert_not_called()

    @patch('okx.Client')
    @patch('okx.load_config', return_value={})
    def test_failure_not_empty(self, config, client):
        client.return_value.get.side_effect = [[], okx.OKXError('failed')]
        with patch('sys.stdout', new_callable=io.StringIO) as out, patch('sys.stderr', new_callable=io.StringIO):
            self.assertEqual(okx.main(['account']), 1)
        self.assertEqual(out.getvalue(), '')

    def test_account_get_path(self):
        cfg = dict(api_key='key', secret_key='secret', passphrase='pass', base_url='https://www.okx.com')
        for path in okx.ACCOUNT_PATHS:
            client = okx.Client(cfg)
            client.opener = Mock()
            client.opener.open.return_value = io.BytesIO(b'{"code":"0","data":[]}')
            self.assertEqual(client.get(path, {}), [])
            req = client.opener.open.call_args.args[0]
            self.assertEqual(req.full_url, cfg['base_url'] + path)
            self.assertEqual(req.method, 'GET')
            headers = {k.lower(): v for k, v in req.header_items()}
            self.assertEqual(headers['ok-access-sign'], okx.signature('secret', headers['ok-access-timestamp'], path))
