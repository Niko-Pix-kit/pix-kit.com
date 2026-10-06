# Pix-kit website

Official static website at https://pix-kit.com, published from `main` by GitHub
Pages. The checked-in HTML is the deployed site. No framework, external fonts,
server-side runtime or paid build service is required.

## Pages and translations

- `/`: two Android app cards with swipeable screenshot carousels.
- `/apps/pix-graph/` and `/apps/pix-moments/`: product stories, FAQs, Google Play
  links and links to the original privacy policies.
- `/about/`: the brand, digital tools and children's books.
- `/contact/`: a direct email link to `niko@pix-kit.com`, the address verified in
  the existing app policies and Google Play. No form, CAPTCHA or email service.
- `/contact/thanks/`: retained as a noindex email-contact page for old links.
- `/privacy/`: the six original policies, with unchanged files, URLs and styles.

English is at the root. Eighteen translated editions are under `/fr/`, `/ja/`,
`/de/`, `/es/`, `/it/`, `/pt/`, `/pt-br/`, `/nl/`, `/pl/`, `/ru/`, `/uk/`, `/zh-cn/`,
`/zh-tw/`, `/ko/`, `/ar/`, `/hi/`, `/id/` and `/tr/`. This covers the union of app
locales: Pix-Moments has all 19; PixGraph currently supplies English resources.
Arabic pages use right-to-left layout. Every edition has translated visible
copy, accessibility labels, metadata and structured data. Screenshot artwork
remains in English with localized captions and a short notice. The app policies
remain in English as requested.

Edit product copy in `data/apps.json`, templates in `tools/build_site.py`, and
translations in `data/i18n/`. `en.json` maps stable string IDs to source text;
other language files provide translations. `required.json` specifies mandatory
IDs. `tools/localize_site.py` refuses missing translations or inconsistent
placeholders instead of silently publishing mixed-language pages. If an English
source sentence changes, update its catalog value and every translation.

Build and check using Python 3 and Node (no installed packages required):

```sh
python3 tools/build_site.py
python3 tools/check_site.py
node tools/test_language.cjs
```

The generator writes 133 HTML pages (seven routes in 19 languages), the sitemap
and robots file. It never writes to `privacy/` or changes `CNAME`. The 95 indexable
marketing URLs have self-canonical links and reciprocal hreflang alternatives,
including x-default. The sitemap also retains the six policy URLs.

## Language selection and privacy

The language menu always links to the same page in each language. It works
without JavaScript. Choosing English explicitly uses `?lang=en` so automatic
selection cannot immediately redirect the visitor elsewhere. Normal internal
links preserve the current edition.

On unprefixed English pages, `assets/js/language.js` respects a manual choice
first. Otherwise it looks up the visitor's IP country with `https://api.country.is/`
and maps it to a supported language. For multilingual countries, compatible
browser preferences help select the language. Unsupported countries or a failed
lookup use the browser language, then English. There is a 2.2-second timeout.
Direct localized URLs are respected, including visits from search results.
Crawlers and 404 pages are not redirected. A pending lookup cannot interrupt a
visitor who has started interacting or chosen a language.

The country request omits credentials and referrer information. The provider
necessarily receives the visitor's IP address to determine its country; Pix-kit
only uses the country field and does not store the IP. A link to the provider
appears in the language menu. No GPS location or precise location is requested.
The service and its stated privacy approach are documented at https://country.is/.

Only functional language preferences are stored:

- `localStorage` key `pixkit.language.v1`: manually chosen locale, until the
  visitor chooses automatic detection or clears browser storage.
- `sessionStorage` key `pixkit.auto-language.v1`: detected locale and timestamp,
  reused for at most one hour and limited to the browser session.

Neither key contains an identifier or IP address. Blocked storage is handled
without breaking navigation. The automatic-detection button clears both choices
and performs a fresh lookup.

There is no analytics, ad tracking, embedded video, third-party font, form
service, CAPTCHA or cookie-writing code. Google Play and the YouTube trailer
open externally in a new tab with `noopener noreferrer`. Media are served
locally. A consent banner is therefore not added for this configuration; CNIL
lists expected interface-language preferences among consent-exempt functions:
https://www.cnil.fr/fr/cookies-et-autres-traceurs/que-dit-la-loi . Reassess this if
tracking or third-party embeds are introduced later.

## Optional blue P / orange K experiment

`assets/css/letter-colors.css` contains the experimental letter colors: P/p use
logo blue `#0084ce`; K/k use logo orange `#ff6600`. The small
`assets/js/letter-colors.js` enhances marked headings without changing their text.

- Add `?letters=off` to preview a page without the enhancement. This option is
  preserved when switching languages.
- To disable the colors everywhere, clear the two rules in that stylesheet.
- To remove the enhancement entirely, remove its CSS and JS references from
  `tools/build_site.py` and regenerate.

## Media, performance and SEO

App copy was checked against the public Google Play listings. Original assets
came from the apps' GitHub repositories:

- PixGraph: `store-assets/feature-graphic`, `store-assets/screenshots/phone`
  (all seven screenshots) and `store-assets/logo`.
- Pix-Moments: `store-assets/feature-graphic` and
  `store-assets/en-US/phone-screenshots` (all eight screenshots).
- PixGraph trailer: https://www.youtube.com/watch?v=yZPJzSS56U0 . The site links
  to it without loading a YouTube player. No trailer was listed for Pix-Moments.

The 19 localized Google Play badges are original SVG assets downloaded from
Google’s Partner Marketing Hub. Their source filenames and checksums are in
`data/badges.json`; the artwork is unmodified and served locally.

WebP media have responsive variants, translated alternative text, dimensions
and lazy loading. Original branding PNGs remain unchanged. Carousels support
native swiping without JavaScript, with buttons, keyboard navigation and image
enlargement added by a small script. They do not auto-advance and respect
reduced-motion preferences.

Pages include unique titles and descriptions, social previews, Organization,
WebSite and SoftwareApplication structured data, breadcrumbs and a custom 404.
There are no invented ratings or download counts. Indexing and ranking remain
up to search engines.
