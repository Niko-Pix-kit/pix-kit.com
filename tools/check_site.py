#!/usr/bin/env python3
"""Check generated routes, metadata, language links and external-link behavior."""
import json
import re
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from localize_site import BASE, LOCALES, ROUTES, ROOT, route_url, sitemap_entries


class Document(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.elements = []
        self.schemas = []
        self.schema_active = False
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.elements.append((tag, attrs))
        if tag == 'script':
            self.schema_active = attrs.get('type') == 'application/ld+json'

    def handle_endtag(self, tag):
        if tag == 'script':
            self.schema_active = False

    def handle_data(self, data):
        if self.schema_active:
            self.schemas.append(json.loads(data))

    def select(self, tag, **attrs):
        return [a for t, a in self.elements if t == tag and all(a.get(k) == v for k, v in attrs.items())]


def file_for(path):
    result = ROOT / path.lstrip('/')
    return result / 'index.html' if path.endswith('/') else result


def main():
    pages = play_links = 0
    for locale in LOCALES:
        for route in ROUTES:
            path = route_url(locale['code'], route)
            source = file_for(path).read_text()
            doc = Document(source)
            context = f'{locale["code"]} {route}'
            html = doc.select('html')[0]
            assert html['lang'] == locale['tag'], context
            assert html['dir'] == locale.get('dir', 'ltr'), context
            assert html['data-route'] == route, context
            assert doc.select('link', rel='canonical')[0]['href'] == BASE + path, context
            assert len(doc.select('h1')) == 1, context
            assert doc.select('meta', name='description')[0]['content'].strip(), context
            assert doc.select('meta', property='og:url')[0]['content'] == BASE + path, context
            assert doc.schemas and doc.schemas[0]['@context'] == 'https://schema.org', context
            assert not doc.select('form') and not doc.select('iframe'), context
            assert 'formsubmit' not in source.lower() and 'recaptcha' not in source.lower(), context
            alternate = {a['hreflang']: a['href'] for a in doc.select('link', rel='alternate')}
            expected = {l['tag']: BASE + route_url(l['code'], route) for l in LOCALES}
            expected['x-default'] = BASE + route
            assert alternate == expected, context
            choices = [a for a in doc.select('a') if 'data-locale-choice' in a]
            assert len(choices) == 19 and sum(a.get('aria-current') == 'true' for a in choices) == 1, context
            for a in choices:
                assert urlsplit(a['href']).path == route_url(a['data-locale-choice'], route), context
            for tag, attrs in doc.elements:
                if tag == 'script' and attrs.get('src'):
                    assert attrs['src'].startswith('/assets/'), context
                for key in ('src', 'href'):
                    value = attrs.get(key, '')
                    url = urlsplit(value)
                    if url.scheme or url.netloc or not url.path:
                        continue
                    assert url.path.startswith('/'), (context, value)
                    assert file_for(url.path).is_file(), (context, value)
                if tag == 'a' and urlsplit(attrs.get('href', '')).netloc == 'play.google.com':
                    assert attrs.get('target') == '_blank', context
                    assert {'noopener', 'noreferrer'} <= set(attrs.get('rel', '').split()), context
                    assert parse_qs(urlsplit(attrs['href']).query)['hl'] == [locale['play']], context
                    assert attrs.get('aria-label'), context
                    play_links += 1
                if tag == 'img' and attrs.get('src'):
                    assert 'alt' in attrs and attrs.get('width') and attrs.get('height'), context
            if route == '/contact/':
                assert doc.select('a', href='mailto:niko@pix-kit.com'), context
            pages += 1
    sitemap = ET.parse(ROOT / 'sitemap.xml')
    urls = [el.text for el in sitemap.findall('.//{*}loc')]
    expected = [BASE + p for p in sitemap_entries()]
    expected += [BASE + '/privacy/' + p.name for p in sorted((ROOT / 'privacy').glob('*.html'))]
    assert urls == expected and len(urls) == len(set(urls)) == 101
    assert pages == 133 and play_links == 114
    print(f'PASS: {pages} pages, 19 languages, {play_links} Google Play new-tab links, 101 sitemap URLs, metadata, media and language navigation. No forms, embeds or external scripts.')


if __name__ == '__main__':
    main()
