"""Process boundary checks for cli.main. Fabricated inputs only."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cli


class CliTests(unittest.TestCase):
    def never(self, *_):
        raise AssertionError('disabled mode must not read stdin')

    def test_default_is_disabled_without_reading_stdin_or_importing_the_adapter(self):
        with patch('builtins.open', side_effect=AssertionError('no file IO')):
            code, out = cli.main([], self.never)
        self.assertEqual((code, out['state']), (0, 'DISABLED'))
        self.assertIs(out['publicationReady'], False)
        self.assertIs(out['productionEnabled'], False)

    def test_only_the_exact_enable_argument_is_accepted(self):
        for argv in (['--enable'], ['--enabled', 'x'], ['--enabled=1'], ['--node=/bin/true'], ['--scope', 'f' * 64]):
            code, out = cli.main(argv, self.never)
            self.assertEqual((code, out['state'], out['code']), (2, 'REFUSED', 'OFFLINE_ARGUMENT'))

    def test_request_size_and_shape_are_refused_with_fixed_codes(self):
        for blob in (b'', b'x' * (cli.MAX_REQUEST + 1), 'not bytes'):
            code, out = cli.main(['--enabled'], lambda _n, b=blob: b)
            self.assertEqual((code, out['code']), (1, 'OFFLINE_REQUEST_SIZE'))
        code, out = cli.main(['--enabled'], lambda _n: b'{"a":1,"a":2}')
        self.assertEqual((code, out['state'], out['code']), (1, 'REFUSED', 'OFFLINE_DUPLICATE_JSON_KEY'))
        code, out = cli.main(['--enabled'], lambda _n: b'[]')
        self.assertEqual((code, out['state']), (1, 'REFUSED'))

    def test_unexpected_errors_never_leak_paths_or_messages(self):
        with patch('adapter.performance_assembly.prepare_offline_performance', side_effect=OSError('/private/path/secret')):
            code, out = cli.main(['--enabled'], lambda _n: b'{}')
        self.assertEqual((code, out['code']), (1, 'OFFLINE_REFUSED'))
        self.assertNotIn('private', json.dumps(out))

    def test_a_result_that_claims_readiness_is_refused(self):
        base = dict(state='OFFLINE_COMPLETE_ORIGINAL_CANDIDATE', original={'a': 1}, originalLibraryIdentityPending=True,
                    uploads=0, publications=0, **{name: False for name in cli.FALSE_FLAGS})
        for change in (dict(publicationReady=True), dict(sourceOriginVerified=True), dict(productionEnabled=True),
                       dict(originalLibraryIdentityPending=False), dict(publications=1), dict(state='OTHER')):
            with patch('adapter.performance_assembly.prepare_offline_performance', return_value={**base, **change}):
                code, out = cli.main(['--enabled'], lambda _n: b'{}')
            self.assertEqual((code, out['code']), (1, 'OFFLINE_RESULT_CONTRACT'), change)
        with patch('adapter.performance_assembly.prepare_offline_performance', return_value=base):
            code, out = cli.main(['--enabled'], lambda _n: b'{}')
        self.assertEqual((code, out['state']), (0, 'OFFLINE_COMPLETE_ORIGINAL_CANDIDATE'))
        for name in cli.FALSE_FLAGS:
            self.assertIs(out[name], False)


if __name__ == '__main__':
    unittest.main()
