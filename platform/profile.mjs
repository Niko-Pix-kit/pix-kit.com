export const avatarPresets = Object.freeze([
  Object.freeze({ id: 'robot', url: '/assets/avatars/robot.svg' }),
  Object.freeze({ id: 'spark', url: '/assets/avatars/spark.svg' }),
  Object.freeze({ id: 'book', url: '/assets/avatars/book.svg' }),
]);
const avatars = new Map(avatarPresets.map(({ id, url }) => [id, url]));

// ISO 3166-1 assigned country and territory codes; Intl also names non-country regions and aliases.
export const countryCodes = Object.freeze(`
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ
VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
`.trim().split(/\s+/));
const countries = new Set(countryCodes);
const localizedCountries = new Map();
const legacyCountries = Object.freeze({ BU: 'MM', DD: 'DE', FX: 'FR', TP: 'TL', UK: 'GB', YD: 'YE', ZR: 'CD' });

/** Canonicalize unambiguous legacy selections without changing stored records. */
export function normalizeCountryCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  const canonical = Object.hasOwn(legacyCountries, code) ? legacyCountries[code] : code;
  return countries.has(canonical) ? canonical : null;
}

export function countryFlag(value) {
  const code = normalizeCountryCode(value);
  return code ? String.fromCodePoint(...[...code].map(letter => 0x1f1e6 + letter.charCodeAt(0) - 65)) : '';
}

/** Names precede flags so native select type-ahead and alphabetical sorting remain usable. */
export function countryOptions(localeTag = 'en') {
  if (!localizedCountries.has(localeTag)) {
    const names = new Intl.DisplayNames(localeTag, { type: 'region' });
    const collator = new Intl.Collator(localeTag);
    const options = countryCodes.map(code => {
      const name = names.of(code);
      return Object.freeze({ code, name, label: `${name} ${countryFlag(code)}` });
    }).sort((left, right) => collator.compare(left.name, right.name) || left.code.localeCompare(right.code));
    localizedCountries.set(localeTag, Object.freeze(options));
  }
  return localizedCountries.get(localeTag);
}

export function countryLabel(value, localeTag = 'en') {
  const code = normalizeCountryCode(value);
  return code ? countryOptions(localeTag).find(country => country.code === code).label : '';
}

export function normalizeNickname(value) {
  if (typeof value !== 'string') return null;
  const nickname = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_]{2,23}$/.test(nickname) ? nickname : null;
}

export function presetAvatarUrl(preset) {
  return avatars.get(preset) ?? null;
}

/** Only explicitly public profile fields may cross the public rendering boundary. */
export function publicProfile(profile) {
  const nickname = normalizeNickname(profile?.nickname);
  if (!nickname) return null;
  const projected = { nickname, avatarUrl: presetAvatarUrl(profile.avatarPreset) };
  for (const [field, flag] of [
    ['givenName', 'publicGivenName'], ['familyName', 'publicFamilyName'],
    ['countryCode', 'publicCountry'], ['preferredLocale', 'publicLanguage'],
  ]) {
    if (profile[flag] === true && typeof profile[field] === 'string' && profile[field]) {
      const value = field === 'countryCode' ? normalizeCountryCode(profile[field]) : profile[field];
      if (value) projected[field] = value;
    }
  }
  return projected;
}
