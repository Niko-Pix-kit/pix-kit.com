"""Verify consent coverage and disclosures in the published static pages."""
import json
import sys
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from localize_site import ROUTES

I18N = ROOT / 'data/i18n'
LOCALES = json.loads((I18N / 'locales.json').read_text())
TRANSLATIONS = json.loads((I18N / 'analytics.json').read_text())


class ConsentDocument(HTMLParser):
    def __init__(self, path):
        super().__init__()
        self.tags = []
        self.raw = path.read_text(encoding='utf-8')
        self.feed(self.raw)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


class AnalyticsTests(unittest.TestCase):
    def test_all_published_pages_load_the_first_party_gate_in_order(self):
        pages = [path for path in ROOT.rglob('*.html')
                 if not any(part.startswith('.') or part == 'node_modules'
                            for part in path.relative_to(ROOT).parts)]
        self.assertEqual(len(pages), len(LOCALES) * len(ROUTES) + 6)
        for path in pages:
            with self.subTest(path=path.relative_to(ROOT)):
                doc = ConsentDocument(path)
                scripts = [urlsplit(attrs['src']) for tag, attrs in doc.tags
                           if tag == 'script' and 'src' in attrs]
                self.assertTrue(all(not src.scheme and not src.netloc for src in scripts))
                names = [src.path for src in scripts]
                consent = names.index('/assets/js/consent.js')
                analytics = names.index('/assets/js/analytics.js')
                self.assertEqual(names.count('/assets/js/analytics.js'), 1)
                self.assertLess(consent, analytics)
                if '/assets/js/language.js' in names:
                    self.assertLess(consent, names.index('/assets/js/language.js'))
                    self.assertLess(names.index('/assets/js/language.js'), analytics)
                choices = {attrs['id']: attrs for tag, attrs in doc.tags
                           if tag == 'input' and attrs.get('type') == 'checkbox'}
                for choice in ('cookie-preferences', 'cookie-analytics'):
                    self.assertIn(choice, choices)
                    self.assertNotIn('checked', choices[choice])
                self.assertTrue(any(tag == 'button' and 'data-cookie-manage' in attrs
                                    for tag, attrs in doc.tags))
                self.assertNotIn('googletagmanager.com', doc.raw)

    def test_every_cookie_policy_contains_the_localized_disclosure(self):
        self.assertEqual(set(TRANSLATIONS), {locale['code'] for locale in LOCALES})
        for locale in TRANSLATIONS:
            with self.subTest(locale=locale):
                self.assertEqual(set(TRANSLATIONS[locale]), set(TRANSLATIONS['en']))
                directory = ROOT if locale == 'en' else ROOT / locale
                doc = ConsentDocument(directory / 'cookie-policy/index.html')
                self.assertIn(TRANSLATIONS[locale]['330'], doc.raw)
                self.assertIn('https://policies.google.com/privacy', doc.raw)
                self.assertIn('_ga_Y3KP2PKKS3', doc.raw)
                if locale != 'en':
                    self.assertNotIn(TRANSLATIONS['en']['330'], doc.raw)
