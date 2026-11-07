"""Regression checks for general terms, app scope, localization and link placement."""
import hashlib
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from localize_site import LOCALES, ROUTES, dictionary, route_url

TERMS_ROUTES = ['/terms-of-use/', '/apps/pix-graph/terms-of-use/', '/apps/pix-moments/terms-of-use/']
WEBSITE_PRIVACY_ROUTE = '/platform-privacy/'
APPS = {'pix-graph': ('PixGraph', 293), 'pix-moments': ('Pix-Moments', 295)}


class Document(HTMLParser):
    def __init__(self, path):
        super().__init__(convert_charrefs=True)
        self.raw = path.read_text(encoding='utf-8')
        self.tags, self.ids, self.links = [], [], []
        self.main_tags, self.main_links, self.main_text, self.footer_links = [], [], [], []
        self.footer_tags, self.footer_text = [], []
        self.in_main = self.in_footer = False
        self.feed(self.raw)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'main':
            self.in_main = True
        if tag == 'footer':
            self.in_footer = True
        self.tags.append((tag, attrs))
        if self.in_main:
            self.main_tags.append((tag, attrs))
        if self.in_footer:
            self.footer_tags.append((tag, attrs))
        if 'id' in attrs:
            self.ids.append(attrs['id'])
        if tag == 'a':
            self.links.append(attrs)
            if self.in_main:
                self.main_links.append(attrs)
            if self.in_footer:
                self.footer_links.append(attrs)

    def handle_endtag(self, tag):
        if tag == 'main':
            self.in_main = False
        if tag == 'footer':
            self.in_footer = False

    def handle_data(self, value):
        if self.in_main:
            self.main_text.append(value)
        if self.in_footer:
            self.footer_text.append(value)


def document(code, route):
    path = ROOT / route_url(code, route).lstrip('/')
    if route.endswith('/'):
        path /= 'index.html'
    return Document(path)


class TermsOfUseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.privacy_hashes = {p: hashlib.sha256(p.read_bytes()).hexdigest()
                              for p in (ROOT / 'privacy').glob('*.html')}
        subprocess.run([sys.executable, str(ROOT / 'tools/build_site.py')],
                       cwd=ROOT, check=True, capture_output=True, text=True)

    def test_complete_translations_and_legal_design_in_all_languages(self):
        self.assertEqual(len(LOCALES), 19)
        for locale in LOCALES:
            code = locale['code']
            strings = dictionary(code)
            for route in TERMS_ROUTES:
                with self.subTest(locale=code, route=route):
                    doc = document(code, route)
                    content = ''.join(doc.main_text)
                    html = next(a for tag, a in doc.tags if tag == 'html')
                    self.assertEqual(html['lang'], locale['tag'])
                    self.assertEqual(html['dir'], locale.get('dir', 'ltr'))
                    self.assertEqual(html['data-route'], route)
                    self.assertEqual(len(doc.ids), len(set(doc.ids)))
                    self.assertTrue(any(a.get('class') == 'legal-page' for _, a in doc.main_tags))
                    self.assertTrue(any(a.get('class') == 'legal-meta' for _, a in doc.main_tags))
                    expected = [307, 308, 309, 314, 315, 316, 317, 301, 303] if route == TERMS_ROUTES[0] else [310, 311, 312, 313, 287, 291, 297, 303]
                    for key in expected:
                        self.assertIn(strings[str(key)], content)
                    if code != 'en':
                        for key in [309, 311, 312, 313, 314, 315, 316, 317]:
                            self.assertNotEqual(strings[str(key)], dictionary('en')[str(key)])

    def test_one_general_footer_link_and_no_application_links(self):
        for locale in LOCALES:
            code = locale['code']
            for route in ROUTES:
                with self.subTest(locale=code, route=route):
                    links = document(code, route).footer_links
                    general = [a for a in links if a['href'] == route_url(code, '/terms-of-use/')]
                    self.assertEqual(len(general), 1)
                    internal_paths = [urlsplit(a['href']).path for a in links if not urlsplit(a['href']).netloc]
                    self.assertFalse(any('/privacy/' in path or '/apps/' in path for path in internal_paths))

    def test_site_footer_and_cookie_control_are_shared_by_every_public_page(self):
        for locale in LOCALES:
            code = locale['code']
            expected = [route_url(code, path) for path in (
                '/platform-privacy/', '/terms-of-use/', '/cookie-policy/',
            )]
            for route in ROUTES:
                with self.subTest(locale=code, route=route):
                    doc = document(code, route)
                    self.assertEqual([link['href'] for link in doc.footer_links], expected)
                    controls = [attrs for tag, attrs in doc.footer_tags
                                if tag == 'button' and 'data-cookie-manage' in attrs]
                    self.assertEqual(len(controls), 1)
                    self.assertEqual(controls[0]['type'], 'button')
                    self.assertIn('cookie-dialog', doc.ids)

    def test_contact_has_no_application_policy_directory(self):
        for locale in LOCALES:
            with self.subTest(locale=locale['code']):
                doc = document(locale['code'], '/contact/')
                self.assertFalse(any(attrs.get('class') == 'contact-policy-panel'
                                     for _, attrs in doc.main_tags))
                self.assertFalse(any('/privacy/' in link['href']
                                     for link in doc.main_links))

    def test_application_privacy_pages_keep_the_common_website_footer(self):
        for path in (ROOT / 'privacy').glob('*.html'):
            with self.subTest(path=path.name):
                doc = Document(path)
                self.assertEqual([link['href'] for link in doc.footer_links], [
                    '/platform-privacy/', '/terms-of-use/', '/cookie-policy/',
                ])
                self.assertEqual(sum(tag == 'footer' for tag, _ in doc.tags), 1)
                self.assertTrue(any(tag == 'button' and 'data-cookie-manage' in attrs
                                    for tag, attrs in doc.footer_tags))
                self.assertIn('cookie-dialog', doc.ids)

    def test_website_privacy_is_public_linked_and_localized(self):
        canonical_base = 'https://pix-kit.com'
        sitemap_urls = {node.text for node in ET.parse(ROOT / 'sitemap.xml').findall('.//{*}loc')}
        for locale in LOCALES:
            code = locale['code']
            local_route = route_url(code, WEBSITE_PRIVACY_ROUTE)
            with self.subTest(locale=code):
                for route in ROUTES:
                    footer = document(code, route).footer_links
                    self.assertEqual(sum(link['href'] == local_route for link in footer), 1, route)
                policy = document(code, WEBSITE_PRIVACY_ROUTE)
                strings = dictionary(code)
                page_text = ''.join(policy.main_text)
                self.assertIn(strings['065'], page_text)
                for key in range(331, 342):
                    self.assertIn(strings[str(key)], page_text)
                    if code != 'en':
                        self.assertNotEqual(strings[str(key)], dictionary('en')[str(key)])
                self.assertIn('Google', page_text)
                self.assertIn('Supabase', page_text)
                self.assertIn('info@pix-kit.com', page_text)
                self.assertIn(route_url(code, '/cookie-policy/'),
                              [link['href'] for link in policy.main_links])
                html = next(attrs for tag, attrs in policy.tags if tag == 'html')
                self.assertEqual(html['lang'], locale['tag'])
                self.assertEqual(html['dir'], locale.get('dir', 'ltr'))
                self.assertEqual(html['data-route'], WEBSITE_PRIVACY_ROUTE)
                expected_url = canonical_base + local_route
                self.assertIn(expected_url, sitemap_urls)
                self.assertIn(('link', {'rel': 'canonical', 'href': expected_url}), policy.tags)
                choices = {link['data-locale-choice']: urlsplit(link['href']).path
                           for link in policy.links if 'data-locale-choice' in link}
                self.assertEqual(choices, {entry['code']: route_url(entry['code'], WEBSITE_PRIVACY_ROUTE)
                                           for entry in LOCALES})

    def test_app_detail_privacy_links_point_to_their_own_terms(self):
        for locale in LOCALES:
            code = locale['code']
            for slug in APPS:
                with self.subTest(locale=code, app=slug):
                    doc = document(code, f'/apps/{slug}/')
                    count = 0
                    for index, link in enumerate(doc.main_links):
                        if link['href'] == f'/privacy/{slug}.html':
                            self.assertEqual(doc.main_links[index + 1]['href'], route_url(code, f'/apps/{slug}/terms-of-use/'))
                            count += 1
                    self.assertEqual(count, 2)
            homepage = document(code, '/')
            for slug in APPS:
                index = next(i for i, a in enumerate(homepage.main_links) if a['href'] == f'/privacy/{slug}.html')
                self.assertEqual(homepage.main_links[index + 1]['href'], route_url(code, f'/apps/{slug}/terms-of-use/'))
            self.assertFalse(any('/terms-of-use/' in a['href'] for a in document(code, '/contact/').main_links))

    def test_general_scope_and_app_specific_scope_remain_separate(self):
        for locale in LOCALES:
            code = locale['code']
            general = document(code, TERMS_ROUTES[0])
            general_text = ''.join(general.main_text)
            for app_name, _ in APPS.values():
                self.assertNotIn(app_name, general_text)
            for feature in ['Premium', 'CSV', 'GIF', 'Google Drive']:
                self.assertNotIn(feature, general_text)
            for slug, (name, paragraph) in APPS.items():
                doc = document(code, f'/apps/{slug}/terms-of-use/')
                content = ''.join(doc.main_text)
                self.assertIn(dictionary(code)[str(paragraph)], content)
                self.assertIn(dictionary(code)['313'], content)
                for other_slug, (other_name, _) in APPS.items():
                    if other_slug != slug:
                        self.assertNotIn(other_name, content)
                self.assertIn('id="general-terms-notice"', doc.raw)
                self.assertLess(doc.raw.index('id="general-terms-notice"'), doc.raw.index('id="premium"'))
                general_links = [a['href'] for a in doc.main_links if '/terms-of-use/' in a['href']]
                self.assertEqual(general_links, [route_url(code, '/terms-of-use/')])
                privacy_links = [a['href'] for a in doc.main_links if '/privacy/' in a['href']]
                self.assertEqual(privacy_links, [f'/privacy/{slug}.html'])
                self.assertTrue(any(a['href'] == 'https://support.google.com/googleplay/answer/2479637' for a in doc.main_links))

    def test_language_choices_canonicals_and_sitemap(self):
        urls = {n.text for n in ET.parse(ROOT / 'sitemap.xml').findall('.//{*}loc')}
        for locale in LOCALES:
            for route in TERMS_ROUTES:
                doc = document(locale['code'], route)
                url = 'https://pix-kit.com' + route_url(locale['code'], route)
                self.assertIn(url, urls)
                canonical = [a['href'] for tag, a in doc.tags if tag == 'link' and a.get('rel') == 'canonical']
                self.assertEqual(canonical, [url])
                choices = {a['data-locale-choice']: urlsplit(a['href']).path for a in doc.links if 'data-locale-choice' in a}
                self.assertEqual(choices, {l['code']: route_url(l['code'], route) for l in LOCALES})

    def test_all_legal_link_targets_and_fragments_resolve(self):
        for locale in LOCALES:
            for route in TERMS_ROUTES:
                doc = document(locale['code'], route)
                for link in doc.links:
                    url = urlsplit(link['href'])
                    if url.scheme or url.netloc:
                        continue
                    target = ROOT / (url.path or route_url(locale['code'], route)).lstrip('/')
                    if str(target).endswith('/') or target.is_dir():
                        target /= 'index.html'
                    self.assertTrue(target.is_file(), (locale['code'], route, link['href']))
                    if url.fragment:
                        self.assertIn(url.fragment, Document(target).ids)

    def test_application_privacy_files_are_preserved(self):
        self.assertEqual(len(self.privacy_hashes), 6)
        for path, digest in self.privacy_hashes.items():
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)

    def test_footer_has_one_copyright_paragraph_and_keeps_play_credit_with_badges(self):
        badge_routes = {'/', *(f'/apps/{slug}/' for slug in APPS)}
        for locale in LOCALES:
            code = locale['code']
            strings = dictionary(code)
            for route in ROUTES:
                with self.subTest(locale=code, route=route):
                    doc = document(code, route)
                    self.assertEqual(sum(tag == 'p' for tag, _ in doc.footer_tags), 1)
                    footer = ''.join(doc.footer_text)
                    self.assertIn('© 2026 Pix-kit · ' + strings['179'], footer)
                    for key in ('111', '231', '275'):
                        self.assertNotIn(strings[key], footer)
                    self.assertNotIn('Nihon Essentials Hub G.K.', footer)
                    play_credits = [attrs for _, attrs in doc.main_tags
                                    if attrs.get('class') == 'play-attribution']
                    self.assertEqual(len(play_credits), int(route in badge_routes))
                    if play_credits:
                        self.assertIn(strings['111'], ''.join(doc.main_text))

    def test_cookie_policy_includes_the_eighth_analytics_section(self):
        for locale in LOCALES:
            doc = document(locale['code'], '/cookie-policy/')
            self.assertEqual(sum(tag == 'section' for tag, _ in doc.main_tags), 8)
            self.assertNotIn(dictionary(locale['code'])['275'], ''.join(doc.main_text))

    def test_brand_badge_has_one_inline_label_and_no_redundant_buttons(self):
        for locale in LOCALES:
            for route in TERMS_ROUTES:
                doc = document(locale['code'], route)
                self.assertRegex(doc.raw, r'<div class="legal-badge"><span class="legal-mark"[^>]*></span><span data-brand-letters>')
                self.assertFalse(any(tag == 'nav' and a.get('class') == 'legal-links' for tag, a in doc.main_tags))


if __name__ == '__main__':
    unittest.main()
