# Pix-kit website

Official static website at https://pix-kit.com, published from `main` by GitHub
Pages. No framework, runtime dependencies, external fonts or build service are
required. The checked-in HTML is the deployed site.

## Pages and content

- `/`: two Android app cards, each with a swipeable screenshot carousel.
- `/apps/pix-graph/` and `/apps/pix-moments/`: descriptive product pages, FAQs,
  Google Play links and links to the existing privacy policies.
- `/about/`: the brand, apps, digital content and children's books.
- `/contact/`: email contact and a CAPTCHA-protected form.
- `/privacy/`: existing app policies. These files are deliberately unchanged.

Edit shared product copy in `data/apps.json` and the page templates in
`tools/build_site.py`. Rebuild the marketing pages using Python 3:

```sh
python3 tools/build_site.py
```

The generator never writes to `privacy/` or changes `CNAME`. It also generates
the sitemap, robots file, canonical URLs, social metadata and structured data.
Policies retain their original URLs and styles.

## Optional blue P / orange K experiment

`assets/css/letter-colors.css` contains only the experimental letter colors:
P/p use the logo blue `#0084ce`; K/k use the logo orange `#ff6600`. The small
script `assets/js/letter-colors.js` enhances marked large headings. Body text,
form fields, addresses and legal pages retain their original readable text.

- Preview any marketing page without the enhancement by adding `?letters=off`.
- To remove the experiment everywhere, clear the two color rules in
  `assets/css/letter-colors.css`. No HTML or other styles need to change.
- To remove the enhancement entirely, remove its CSS and JS references from
  `tools/build_site.py` and regenerate the pages.

The original unwrapped text is present in the HTML for search engines and
visitors with JavaScript disabled. No controls or text are replaced with images.

## Contact setup — one confirmation required

The verified address in both existing app policies and Google Play is
`niko@pix-kit.com`. This address is used consistently; `info@pix-kit.com` was
not assumed to exist.

GitHub Pages has no email backend. The form uses a standard HTTPS POST to
FormSubmit with its reCAPTCHA enabled (`_captcha=true`) plus a honeypot. The
visitor completes the provider's real CAPTCHA on the next step; the site does
not simulate a robot checkbox or claim to send emails itself. No provider code
is loaded until submission. Direct email is always available alongside the form.

**Before relying on the form:** submit it once from the live `/contact/` page,
then open the activation email sent by FormSubmit to `niko@pix-kit.com` and
confirm the address. First-use activation is required by FormSubmit. No real
message or activation request was sent during automated verification, and
delivery has not been verified. After activation, send a test and check receipt.

Official setup documentation: https://formsubmit.co/ and
https://formsubmit.co/documentation . A different address can be set in the
generator's `EMAIL` constant; it will need its own activation. The form's
redirect is `https://pix-kit.com/contact/thanks/`.

## Media and performance

App copy was checked against the public English Google Play listings. Original
marketing assets came from the corresponding app repositories:

- PixGraph: `store-assets/feature-graphic`, `store-assets/screenshots/phone`
  (all seven screenshots) and `store-assets/logo`.
- Pix-Moments: `store-assets/feature-graphic` and
  `store-assets/en-US/phone-screenshots` (all eight screenshots).
- PixGraph's official trailer, verified on its Google Play listing:
  https://www.youtube.com/watch?v=yZPJzSS56U0 . It loads through YouTube's
  privacy-enhanced embed only after an explicit play click. No trailer is shown
  for Pix-Moments because none was present on that listing.
- The Google Play badge is Google's official English badge asset.

WebP copies have smaller responsive variants, descriptive alt text, dimensions
and lazy loading. Original site PNG assets remain unchanged. Carousels support
native touch swipes and horizontal scrolling without JavaScript, with arrow
buttons, keyboard navigation and image enlargement added by the small script.
They do not auto-advance and respect reduced-motion preferences.

The site contains static indexable content, unique titles and descriptions,
canonical URLs, social previews, Organization/WebSite/SoftwareApplication
structured data, breadcrumbs, a sitemap and a custom 404. There are no invented
ratings or download counts. Search ranking and indexing remain up to the search
engine; the site does not promise either.
