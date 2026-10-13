import json
from pathlib import Path
import tempfile
import unittest

from core import Library, open_score


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.library = Library(self.temp.name)
        self.path = str(Path(self.temp.name) / 'Björk 100%.gp5')

    def record(self, **metadata):
        return {'schema_version': 1, 'path': self.path, 'status': 'ok',
                'metadata': {'title': '100% song', 'format': 'GP5', **metadata}}

    def write(self, records):
        source = Path(self.temp.name) / 'input.jsonl'
        source.write_text('\n'.join(json.dumps(record) for record in records), encoding='utf-8')
        return source

    def test_upsert_persistence_and_literal_search(self):
        self.library.import_jsonl(self.write([self.record(artist='Björk')]))
        self.library.import_jsonl(self.write([self.record(artist='Updated')]))
        reopened = Library(self.temp.name)
        self.assertEqual(len(reopened.query()), 1)
        self.assertEqual(reopened.query(search='100%')[0]['artist'], 'Updated')
        self.assertEqual(reopened.query(search='100_'), [])
        self.assertEqual(reopened.query(format='GP'), [])

    def test_numeric_sort_and_error_replacement(self):
        first = self.record(initial_tempo=120)
        second = self.record(initial_tempo=80)
        second['path'] = str(Path(self.temp.name) / 'other.gp5')
        self.library.import_jsonl(self.write([first, second]))
        self.assertEqual([row['tempo'] for row in self.library.query(sort='tempo')], [80, 120])
        failure = {'schema_version': 1, 'path': self.path, 'status': 'error', 'error': 'Broken score'}
        self.library.import_jsonl(self.write([failure]))
        row = self.library.query(status='error')[0]
        self.assertIsNone(row['tempo'])
        self.assertEqual(json.loads(row['record'])['error'], 'Broken score')

    def test_malformed_import_rolls_back(self):
        invalid = self.record()
        invalid['schema_version'] = 2
        with self.assertRaisesRegex(ValueError, 'Line 2'):
            self.library.import_jsonl(self.write([self.record(), invalid]))
        self.assertEqual(self.library.query(), [])

    def test_invalid_sort_and_missing_file(self):
        with self.assertRaises(ValueError):
            self.library.query(sort='title; DROP TABLE scores')
        with self.assertRaises(FileNotFoundError):
            open_score(self.path)


if __name__ == '__main__':
    unittest.main()
