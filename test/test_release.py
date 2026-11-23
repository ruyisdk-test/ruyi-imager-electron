import importlib.util
import json
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError


spec = importlib.util.spec_from_file_location('catalog', Path(__file__).resolve().parents[1] / 'scripts/build-catalog.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class ReleaseSearch(unittest.TestCase):
    today = date(2026, 1, 2)

    def search(self, local_days=None, published=()):
        dates = []

        def fetch(url):
            tag = url.rsplit('/', 1)[1]
            dates.append(tag)
            if tag in published:
                return json.dumps({'tag_name': tag})
            raise HTTPError(url, 404, 'not found', {}, None)

        local = None if local_days is None else self.today - timedelta(days=local_days)
        with patch.object(catalog, 'fetch', fetch):
            result = catalog.find_release(self.today, local)
        return result, list(dict.fromkeys(dates))

    def test_current_cache_needs_no_requests(self):
        self.assertEqual(self.search(0), (None, []))

    def test_only_query_dates_newer_than_cache(self):
        self.assertEqual(self.search(3), (None, ['20260102', '20260101', '20251231']))

    def test_first_release_wins(self):
        result, dates = self.search(8, ['20260101', '20251231'])
        self.assertEqual(result['tag_name'], '20260101')
        self.assertEqual(dates, ['20260102', '20260101'])

    def test_old_cache_and_empty_window(self):
        result, dates = self.search(40)
        self.assertIsNone(result)
        self.assertEqual(len(dates), 31)
        self.assertEqual(dates[-1], '20251203')
        with self.assertRaisesRegex(RuntimeError, 'No dated packages-index release'):
            self.search()
