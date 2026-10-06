"""Compile all translations into static, indexable HTML (standard library only)."""
import json
import re
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://pix-kit.com'
DIRECTORY = ROOT / 'data/i18n'
LOCALES = json.loads((DIRECTORY / 'locales.json').read_text())
EN = json.loads((DIRECTORY / 'en.json').read_text())
REQUIRED = set(json.loads((DIRECTORY / 'required.json').read_text()))
BADGES = json.loads((ROOT / 'data/badges.json').read_text())['badges']
SOURCE_KEYS = {value: key for key, value in EN.items()}
ROUTES = ['/', '/about/', '/contact/', '/contact/thanks/', '/apps/pix-graph/', '/apps/pix-moments/', '/404.html']
KEEP = {'Pix-kit', 'PixGraph', 'Pix-Moments', 'Android', 'niko@pix-kit.com'}
# Screenshot alternative text is composed from the localized screenshot caption.
ALT_CAPTION = dict(zip([18,22,26,30,34,38,42,46,70,73,76,79,82,85,88,91,94], [19,23,27,31,35,39,43,47,71,74,77,80,83,86,89,92,95]))


def route_url(code, path):
    return path if code == 'en' else '/' + code + path


def dictionary(code):
    if code == 'en': return EN
    data = json.loads((DIRECTORY / (code + '.json')).read_text())
    missing = REQUIRED - data.keys()
    if missing: raise ValueError(f'{code}: missing translations {sorted(missing)}')
    for key in REQUIRED:
        if not isinstance(data[key], str) or not data[key].strip():
            raise ValueError(f'{code}: empty translation {key}')
        if set(re.findall(r'\{\w+\}', EN[key])) != set(re.findall(r'\{\w+\}', data[key])):
            raise ValueError(f'{code}: placeholder mismatch {key}')
    return data


class Localizer(HTMLParser):
    def __init__(self, locale, route):
        super().__init__(convert_charrefs=True)
        self.locale = locale
        self.code = locale['code']
        self.route = route
        self.strings = dictionary(self.code)
        self.parts = []
        self.script = False
        self.json_script = False

    def t(self, key):
        return self.strings[f'{int(key):03}']

    def translate(self, value):
        normalized = ' '.join(value.split())
        if self.code == 'en' or not normalized or normalized in KEEP or not re.search('[A-Za-z]', normalized):
            return value
        key = SOURCE_KEYS.get(normalized)
        if key in self.strings:
            translated = self.strings[key]
        elif normalized == '© 2026 Pix-kit · Build. Learn. Play.':
            translated = '© 2026 Pix-kit · ' + self.t(179)
        elif normalized == 'Contact Pix-kit':
            translated = self.t(7) + ' Pix-kit'
        elif normalized == 'Pix-kit Android apps':
            translated = 'Pix-kit — ' + self.t(9)
        elif normalized.startswith('Enlarge: '):
            translated = self.t(239).format(caption=self.translate(normalized[9:]))
        elif re.fullmatch(r'\d+ of \d+', normalized):
            translated = normalized.replace(' of ', ' / ')
        elif normalized in ['PixGraph screenshots and media', 'Pix-Moments screenshots and media']:
            translated = self.t(235).format(app=normalized.split(' screenshots')[0])
        elif normalized.startswith('Swipe or use the left and right arrow keys'):
            translated = self.t(236)
        elif normalized.startswith('Previous ') and normalized.endswith(' image'):
            translated = self.t(237)
        elif normalized.startswith('Next ') and normalized.endswith(' image'):
            translated = self.t(238)
        elif normalized.startswith('Get ') and 'on Google Play (opens in a new tab)' in normalized:
            translated = self.t(234).format(app=normalized[4:].split(' on Google')[0])
        elif normalized in ['Explore PixGraph', 'Explore Pix-Moments']:
            translated = self.t(233).format(app=normalized[8:])
        elif normalized in ['PixGraph privacy', 'Pix-Moments privacy', 'PixGraph Privacy Policy', 'Pix-Moments Privacy Policy']:
            translated = normalized.split()[0] + ' — ' + self.t(65)
        elif normalized.startswith('Make room for Pix'):
            translated = self.t(240).format(app=normalized[len('Make room for '):-1])
        elif normalized == 'Pix-kit home':
            translated = self.t(241)
        elif normalized == 'Explore Pix-kit Android apps':
            translated = self.t(9)
        elif normalized.startswith('Pix-kit — Build. Learn. Play.'):
            translated = 'Pix-kit — ' + self.t(179)
        elif normalized == 'Play the official PixGraph trailer on YouTube':
            translated = 'PixGraph — ' + self.t(52)
        elif key and int(key) in ALT_CAPTION:
            translated = ('PixGraph' if int(key) < 70 else 'Pix-Moments') + ' — ' + self.t(ALT_CAPTION[int(key)])
        else:
            raise ValueError(f'{self.code}: untranslated text: {normalized}')
        leading = re.match(r'^\s*', value).group()
        trailing = re.search(r'\s*$', value).group()
        return leading + translated + trailing

    def url(self, value):
        u = urlsplit(value)
        if u.netloc == 'play.google.com':
            args = dict(parse_qsl(u.query)); args['hl'] = self.locale['play']
            return urlunsplit((u.scheme,u.netloc,u.path,urlencode(args),u.fragment))
        if u.netloc not in ('', 'pix-kit.com'): return value
        if u.path not in ROUTES: return value
        new = route_url(self.code, u.path)
        return urlunsplit((u.scheme,u.netloc,new,u.query,u.fragment))

    def schema(self, value, key=''):
        if isinstance(value, list): return [self.schema(x, key) for x in value]
        if isinstance(value, dict): return {k:self.schema(v,k) for k,v in value.items()}
        if not isinstance(value, str): return value
        if key == 'inLanguage': return self.locale['tag']
        if key in ('name','description') and value not in KEEP:
            return self.translate(value)
        if key in ('url','item','downloadUrl'):
            return self.url(value)
        if key == '@id' and value not in (BASE+'/#organization',BASE+'/#website'):
            return self.url(value)
        return value

    def handle_decl(self, decl): self.parts.append('<!'+decl+'>')
    def handle_comment(self, comment): self.parts.append('<!--'+comment+'-->')
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'html':
            attrs.update(lang=self.locale['tag'],dir=self.locale.get('dir','ltr'))
            attrs['data-locale'] = self.code
            attrs['data-route'] = self.route
        if tag == 'script':
            self.script = True
            self.json_script = attrs.get('type') == 'application/ld+json'
        for attr in ['aria-label','alt','placeholder']:
            if attrs.get(attr): attrs[attr] = self.translate(attrs[attr])
        if attrs.get('aria-roledescription'):
            attrs['aria-roledescription'] = self.t(243 if attrs['aria-roledescription']=='carousel' else 244)
        if tag == 'meta':
            kind = attrs.get('name',attrs.get('property'))
            if kind in ('description','twitter:title','twitter:description','og:title','og:description','og:image:alt'):
                attrs['content'] = self.translate(attrs['content'])
            if kind == 'og:url': attrs['content'] = self.url(attrs['content'])
            if kind == 'og:locale': attrs['content'] = self.locale['og']
        if tag == 'img' and attrs.get('src') == '/assets/google-play-badge.png':
            attrs['src'] = '/assets/badges/' + self.code + '.svg'
            attrs['width'] = str(round(BADGES[self.code]['width']))
            attrs['height'] = str(round(BADGES[self.code]['height']))
        if 'href' in attrs: attrs['href'] = self.url(attrs['href'])
        if tag == 'input' and attrs.get('name') == '_next': attrs['value'] = self.url(attrs['value'])
        self.parts.append('<'+tag+''.join(' '+k+('="'+escape(v,quote=True)+'"' if v is not None else '') for k,v in attrs.items())+'>')
    def handle_startendtag(self, tag, attrs): self.handle_starttag(tag, attrs)
    def handle_endtag(self, tag):
        self.parts.append('</'+tag+'>')
        if tag == 'script': self.script = self.json_script = False
    def handle_data(self, data):
        if self.json_script:
            self.parts.append(json.dumps(self.schema(json.loads(data)),ensure_ascii=False).replace('<','\\u003c'))
        elif self.script: self.parts.append(data)
        else: self.parts.append(escape(self.translate(data),quote=False))

    def finish(self):
        out = ''.join(self.parts)
        hreflang = '\n'.join(f'<link rel="alternate" hreflang="{l["tag"]}" href="{BASE}{route_url(l["code"],self.route)}">' for l in LOCALES)
        hreflang += f'\n<link rel="alternate" hreflang="x-default" href="{BASE}{self.route}">'
        config = {'locales':[{k:l[k] for k in ('code','tag')} for l in LOCALES]}
        extra = hreflang + '\n<script type="application/json" id="locale-config">'+json.dumps(config)+'</script>\n<script src="/assets/js/language.js?v=20261007" defer></script>'
        out = out.replace('</head>',extra+'\n</head>',1)
        links=[]
        for l in LOCALES:
            href=route_url(l['code'],self.route)
            if l['code']=='en': href+='?lang=en'
            links.append(f'<a href="{href}" data-locale-choice="{l["code"]}" lang="{l["tag"]}" dir="auto" hreflang="{l["tag"]}"'+(' aria-current="true"' if l['code']==self.code else '')+f'>{escape(l["name"])}</a>')
        bar=f'''<div class="language-bar"><div class="wrap language-inner"><span class="language-label">{escape(self.t(226))}</span><details class="language-picker"><summary aria-label="{escape(self.t(228),quote=True)}"><span aria-hidden="true">◎</span> {escape(self.locale['name'])}</summary><div class="language-panel"><div class="language-options">{''.join(links)}</div><button type="button" data-language-auto hidden>{escape(self.t(229))}</button><p>{escape(self.t(230))} <a href="https://country.is/" target="_blank" rel="noopener noreferrer">country.is</a></p></div></details><span class="language-mode" data-language-mode hidden>{escape(self.t(227))}</span></div></div>'''
        out=out.replace('</header>','</header>'+bar,1)
        if self.code!='en':
            # English-source screenshots remain identical to the approved design.
            out=out.replace('<p class="gallery-hint">','<p class="media-language-note">'+escape(self.t(232))+'</p><p class="gallery-hint">')
            out=out.replace('<p class="legal-note">','<p class="policy-language-note">'+escape(self.t(231))+'</p><p class="legal-note">')
        return out


def write_localized_versions(route, source):
    for locale in LOCALES:
        parser=Localizer(locale,route); parser.feed(source); output=parser.finish()
        target=ROOT/route_url(locale['code'],route).lstrip('/')
        if route.endswith('/'): target=target/'index.html'
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(output,encoding='utf-8')


def sitemap_entries():
    paths=[r for r in ROUTES if r not in ['/contact/thanks/','/404.html']]
    return [route_url(l['code'],p) for l in LOCALES for p in paths]
