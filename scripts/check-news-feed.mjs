import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  NEWS_SOURCES,
  classifyNewsIncident,
  clusterNewsIncidents,
  extractLocationCandidates,
  incidentExpiry,
  marineIncidentLocation,
  normalizeArticleUrl,
  parseSyndicationFeed,
  scorePhotonLocation,
  stripFeedMarkup,
} from '../supabase/functions/_shared/news-normalization.js'

const root = process.cwd()
const failures = []
let passed = 0
const rawHtmlSinkPattern = new RegExp(['dangerously', 'SetInnerHTML'].join(''))

function check(name, assertion) {
  try {
    assertion()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`not ok - ${name}`)
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
  }
}

const source = id => {
  const match = NEWS_SOURCES.find(item => item.id === id)
  assert.ok(match, `Missing news source ${id}`)
  return match
}

const detectedAt = '2026-07-19T04:00:00.000Z'

check('publisher registry enables only sources with a reviewed automated-use basis', () => {
  assert.equal(source('gma-news').enabled, true)
  assert.equal(source('abs-cbn-news').enabled, true)
  assert.equal(source('daily-tribune').enabled, true)
  assert.deepEqual(
    source('gma-news').fallbackFeedUrls,
    ['https://data2.gmanetwork.com/gno/rss/news/feed.xml'],
  )
  assert.equal(source('gma-news').feedUrl, 'https://data.gmanetwork.com/gno/rss/news/feed.xml')
  assert.ok(source('gma-news').fallbackFeedUrls.every(url => url.startsWith('https://')))
  assert.equal(source('inquirer-newsinfo').enabled, true)
  assert.equal(source('inquirer-newsinfo').feedUrl, 'https://newsinfo.inquirer.net/category/latest-stories/feed')
  assert.equal(source('inquirer-newsinfo').transport, 'publisher-rss-via-relay')
  assert.equal(source('inquirer-newsinfo').fetchStrategy, 'relay-first')
  assert.equal(source('inquirer-newsinfo').publishedTimeZone, 'Asia/Manila-wall-clock')
  assert.equal(source('inquirer-newsinfo').allowSummary, false)
  assert.equal(source('inquirer-newsinfo').allowAuthor, false)
  assert.equal(source('manila-standard').enabled, true)
  assert.equal(source('manila-standard').format, 'wp-json')
  assert.match(source('manila-standard').feedUrl, /^https:\/\/manilastandard\.net\/wp-json\//)
  assert.equal(source('manila-standard').transport, 'publisher-api-via-relay')
  assert.equal(source('manila-standard').fetchStrategy, 'relay-first')
  assert.equal(source('manila-standard').allowSummary, false)
  assert.equal(source('manila-standard').allowAuthor, true)
  assert.equal(NEWS_SOURCES.some(item => item.id === 'manila-times'), false)
  assert.equal(NEWS_SOURCES.some(item => item.id === 'rappler'), false)
})

check('article URL normalization permits reviewed publisher hosts and removes tracking', () => {
  assert.equal(
    normalizeArticleUrl(
      'https://www.gmanetwork.com/news/topstories/nation/123/story/?utm_source=test&keep=yes#comments',
      source('gma-news').allowedArticleHosts,
    ),
    'https://www.gmanetwork.com/news/topstories/nation/123/story/?keep=yes',
  )
  assert.equal(
    normalizeArticleUrl(
      'https://regional.gmanetwork.com/news/story',
      source('gma-news').allowedArticleHosts,
    ),
    'https://regional.gmanetwork.com/news/story',
  )
})

check('article URL normalization rejects scheme, credential, and hostname bypasses', () => {
  const allowed = source('gma-news').allowedArticleHosts
  for (const unsafe of [
    'http://www.gmanetwork.com/news/story',
    'https://www.gmanetwork.com@attacker.example/news/story',
    'https://gmanetwork.com.attacker.example/news/story',
    'javascript:alert(1)',
    'https://127.0.0.1/news/story',
  ]) {
    assert.equal(normalizeArticleUrl(unsafe, allowed), null, unsafe)
  }
})

check('RSS parsing keeps bounded metadata, attribution, and canonical publisher links', () => {
  const rss = `<?xml version="1.0"?>
    <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel>
        <item>
          <title><![CDATA[Residential fire hits Barangay Panghulo, Malabon City]]></title>
          <link>https://www.gmanetwork.com/news/topstories/metro/123/fire/?utm_source=rss&amp;keep=1#top</link>
          <pubDate>Sun, 19 Jul 2026 03:58:00 GMT</pubDate>
          <description><![CDATA[<p>Firefighters responded to the blaze.</p><script>alert(1)</script>]]></description>
          <dc:creator><![CDATA[By Juan Reporter]]></dc:creator>
        </item>
        <item>
          <title>Untrusted mirror</title>
          <link>https://gmanetwork.com.attacker.example/copied-story</link>
          <pubDate>Sun, 19 Jul 2026 03:59:00 GMT</pubDate>
        </item>
      </channel>
    </rss>`
  const articles = parseSyndicationFeed(rss, source('gma-news'), detectedAt)
  assert.equal(articles.length, 1)
  assert.equal(articles[0].sourceId, 'gma-news')
  assert.equal(articles[0].author, 'Juan Reporter')
  assert.equal(articles[0].summary, 'Firefighters responded to the blaze.')
  assert.equal(
    articles[0].canonicalUrl,
    'https://www.gmanetwork.com/news/topstories/metro/123/fire/?keep=1',
  )
  assert.ok(articles[0].summary.length <= 600)
})

check('news-sitemap parsing reads title, date, and canonical URL without inventing content', () => {
  const sitemap = `<?xml version="1.0"?>
    <urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
      <url>
        <loc>https://tribune.net.ph/2026/07/19/flood-closes-road</loc>
        <news:news>
          <news:publication_date>2026-07-19T03:55:00Z</news:publication_date>
          <news:title>Flood closes road in Manila</news:title>
        </news:news>
      </url>
    </urlset>`
  const articles = parseSyndicationFeed(sitemap, source('daily-tribune'), detectedAt)
  assert.equal(articles.length, 1)
  assert.equal(articles[0].summary, null)
  assert.equal(articles[0].author, null)
  assert.equal(articles[0].sourceName, 'Daily Tribune')
})

check('Inquirer RSS corrects publisher wall-clock time and keeps headline-link metadata only', () => {
  const rss = `<?xml version="1.0"?>
    <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel>
        <item>
          <title>Fire hits warehouse in Pasig City</title>
          <link>https://newsinfo.inquirer.net/2000000/fire-hits-warehouse-in-pasig-city</link>
          <pubDate>Sun, 19 Jul 2026 12:00:00 +0000</pubDate>
          <description><![CDATA[This excerpt must not be retained under the publisher linking rules.]]></description>
          <dc:creator>cms-account</dc:creator>
        </item>
      </channel>
    </rss>`
  const articles = parseSyndicationFeed(rss, {
    ...source('inquirer-newsinfo'),
    allowedArticleHosts: ['inquirer.net'],
    publishedTimeZone: 'Asia/Manila-wall-clock',
  }, detectedAt)
  assert.equal(articles.length, 1)
  assert.equal(articles[0].publishedAt, '2026-07-19T04:00:00.000Z')
  assert.equal(articles[0].summary, null)
  assert.equal(articles[0].author, null)
})

check('Manila Standard WordPress parsing uses metadata fields and ignores article content', () => {
  const payload = JSON.stringify([
    {
      id: 123,
      date_gmt: '2026-07-19T03:55:00',
      link: 'https://manilastandard.net/news/123/fire-hits-market.html',
      title: { rendered: 'Fire hits market in Quezon City' },
      excerpt: { rendered: '<p>This excerpt is intentionally not retained.</p>' },
      content: { rendered: '<p>Full article body must never be copied.</p>' },
      _embedded: { author: [{ name: 'Maria Reporter' }] },
    },
  ])
  const articles = parseSyndicationFeed(payload, {
    ...source('manila-standard'),
    format: 'wp-json',
    allowedArticleHosts: ['manilastandard.net'],
    allowAuthor: true,
  }, detectedAt)
  assert.equal(articles.length, 1)
  assert.equal(articles[0].publishedAt, '2026-07-19T03:55:00.000Z')
  assert.equal(articles[0].summary, null)
  assert.equal(articles[0].author, 'Maria Reporter')
  assert.doesNotMatch(JSON.stringify(articles), /Full article body/)
})

check('third-party RSS parsing remains publisher-host restricted when explicitly configured', () => {
  const rss = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <item>
          <title>Fire hits homes in Manila - Inquirer.net</title>
          <link>https://news.google.com/rss/articles/abc123?oc=5</link>
          <pubDate>Sun, 19 Jul 2026 03:58:00 GMT</pubDate>
          <description><![CDATA[Google News summary must not be retained.]]></description>
        </item>
      </channel>
    </rss>`
  const articles = parseSyndicationFeed(rss, {
    ...source('inquirer-newsinfo'),
    name: 'Inquirer NewsInfo',
    transport: 'google-news-rss-index',
    allowedArticleHosts: ['news.google.com'],
    titleSuffixes: ['Inquirer.net'],
  }, detectedAt)
  assert.equal(articles.length, 1)
  assert.equal(articles[0].title, 'Fire hits homes in Manila')
  assert.match(articles[0].canonicalUrl, /^https:\/\/news\.google\.com\/rss\/articles\//)
  assert.equal(articles[0].summary, null)
})

check('unsafe XML declarations are rejected before parsing', () => {
  assert.throws(
    () => parseSyndicationFeed(
      '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><item>&xxe;</item></rss>',
      source('gma-news'),
      detectedAt,
    ),
    /Unsafe XML declaration/,
  )
})

check('encoded executable markup is removed rather than returned as markup-looking text', () => {
  const normalized = stripFeedMarkup(
    '&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt; Safe report',
  )
  assert.doesNotMatch(normalized, /<\s*(?:script|img)\b/i)
  assert.doesNotMatch(normalized, /onerror\s*=/i)
  assert.match(normalized, /Safe report/)
})

check('publisher metadata sanitizes illegal control characters and lone surrogates', () => {
  const unsafe = `Fire${String.fromCharCode(0)} report${String.fromCharCode(0xd800)} in Manila`
  const normalized = stripFeedMarkup(unsafe)
  assert.equal([...normalized].some(character => {
    const point = character.codePointAt(0) ?? 0
    return (point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d)
      || (point >= 0xd800 && point <= 0xdfff)
  }), false)
  assert.match(normalized, /Fire report in Manila/)
})

check('metadata-only ingestion never falls back to a full content:encoded article body', () => {
  const normalizer = fs.readFileSync(
    path.join(root, 'supabase/functions/_shared/news-normalization.js'),
    'utf8',
  )
  assert.doesNotMatch(
    normalizer,
    /firstTag\(block,\s*\[[^\]]*['"]content:encoded['"]/,
    'A metadata-only monitor must use publisher descriptions/summaries, not copy from full-body feed fields.',
  )
})

check('English and Filipino incident wording is classified into supported hazards', () => {
  const cases = [
    ['Residential fire destroys homes in Quezon City', 'fire'],
    ['Sunog sa Barangay Panghulo, naapula na', 'fire'],
    ['Flash flooding closes roads in Manila', 'flood'],
    ['Baha sa Malabon, ilang pamilya inilikas', 'flood'],
    ['Bus collision along EDSA injures five', 'road-incident'],
    ['Aksidente sa NLEX, dalawang sasakyan nagbanggaan', 'road-incident'],
    ['Man murdered in Caloocan City', 'killing'],
    ['Lalaki pinatay sa Barangay Commonwealth, Quezon City', 'killing'],
    ['Hold-up reported in Makati convenience store', 'robbery-theft'],
    ['Nakawan sa tindahan sa Pasig City', 'robbery-theft'],
    ['Typhoon enters the Philippine area of responsibility', 'typhoon'],
    ['Bagyo, inaasahang lalakas bago mag-landfall', 'typhoon'],
    ['Magnitude 5.1 earthquake rocks Mindanao', 'earthquake'],
    ['Lindol yumanig sa Davao Oriental', 'earthquake'],
    ['Terror attack hits transit station', 'security-conflict'],
    ['Army launches combat operation in Basilan', 'security-conflict'],
  ]
  for (const [headline, category] of cases) {
    assert.deepEqual(
      { ...classifyNewsIncident(headline), resolved: undefined },
      { category, isHazard: true, resolved: undefined },
      headline,
    )
  }
})

check('incident cause takes precedence over deaths reported in the same headline', () => {
  assert.equal(
    classifyNewsIncident('Couple killed in residential fire in Manila').category,
    'fire',
  )
  assert.equal(
    classifyNewsIncident('Driver killed in truck collision along EDSA').category,
    'road-incident',
  )
  assert.equal(
    classifyNewsIncident('Three killed as earthquake rocks Mindanao').category,
    'earthquake',
  )
})

check('headlines establish the incident category while summaries only add status context', () => {
  assert.deepEqual(
    classifyNewsIncident(
      'Mayor opens a new community health center',
      'The program also discussed aid for families affected by a 2011 earthquake.',
    ),
    { category: null, isHazard: false, resolved: false },
  )
  assert.deepEqual(
    classifyNewsIncident(
      'Authorities issue an afternoon update',
      'A residential fire damaged several houses in the city.',
    ),
    { category: null, isHazard: false, resolved: false },
  )
  assert.deepEqual(
    classifyNewsIncident(
      'Residential fire damages homes in Quezon City',
      'Firefighters say the blaze is now under control.',
    ),
    { category: 'fire', isHazard: true, resolved: true },
  )
})

check('legal, political, aftermath, historical, and animal stories do not become active incidents', () => {
  for (const headline of [
    'Sara Duterte impeachment testimony revisits alleged death threat against President Marcos',
    'Sara Duterte impeachment testimony revisits an alleged murder plot',
    'Court weighs doctrine on evidence in murder cases',
    'Senators seek probe into the alleged threat to kill a public official',
    'Go gives context on the flood control mess after court sheriff controversy',
    'Families receive aid after the 2011 earthquake',
    'Relief donations turned over to Typhoon Yolanda survivors',
    'Town marks a decade of recovery after the earthquake',
    'Rehabilitation of fire-hit communities continues',
    'Memorial and mourning rites held for fire victims',
    'Philippine eagle shot dead in Davao City',
    'Philippine eagle and monkey killed in separate shooting incidents',
    'Police arrest suspect in a 2024 murder',
    'Suspect arrested over a 2024 killing',
    'Lalaki tiklo sa pagpatay noong 2023',
    'Accused charged with murder after a year-long investigation',
  ]) {
    assert.equal(classifyNewsIncident(headline).isHazard, false, headline)
  }
})

check('routine incident monitoring stays Philippine while concrete international security events remain eligible', () => {
  for (const headline of [
    'Wildfire forces evacuations in southern France',
    'Military deploys troops to battle a raging wildfire in France',
    'Magnitude 6.2 earthquake strikes Japan',
    'Flooding closes roads in northern India',
    'Bus crash kills passengers in Canada',
  ]) {
    assert.equal(classifyNewsIncident(headline).isHazard, false, headline)
  }

  const eligible = [
    ['Wildfire forces evacuations in Benguet', 'fire'],
    ['Flash flood sweeps through Barangay San Isidro, Quezon', 'flood'],
    ['Van crashes along Commonwealth Avenue in Quezon City', 'road-incident'],
    ['Woman shot dead in Caloocan City', 'killing'],
    ['Store robbed in Barangay Tondo, Manila', 'robbery-theft'],
    ['Typhoon makes landfall over Eastern Samar', 'typhoon'],
    ['Magnitude 5.0 earthquake strikes Davao Oriental', 'earthquake'],
    ['Drone strike hits military base in Ukraine', 'security-conflict'],
  ]
  for (const [headline, category] of eligible) {
    assert.equal(classifyNewsIncident(headline).category, category, headline)
  }
})

check('preparedness, sports metaphors, and statement-only security coverage stay news-only', () => {
  for (const headline of [
    'Barangays attend typhoon preparedness training',
    'School conducts earthquake response exercise',
    'Warriors flood the court in dominant finals win',
    'DFA condemns terror attack reported overseas',
    'Officials issue statement on alleged bombing threat',
    'Senator calls for military action during committee hearing',
  ]) {
    assert.equal(classifyNewsIncident(headline).isHazard, false, headline)
  }
})

check('production headline regressions remain news-only unless they report a current eligible incident', () => {
  const newsOnly = [
    'Sara Duterte impeachment trial Day 9: Prosecution rests case on alleged threat against Marcos',
    'Go gives context of Sara Duterte punching a court sheriff in 2011',
    'First Lady helps secure P37.5M Nitori aid for Mindanao quake victims',
    'Bong Go aids 372 families displaced by Tondo fire',
    'Hundreds flee as wildfire rips through southern France',
    'Mexican mayor shot dead in town hall',
    'Philippine eagle na si Sawaga-Dalwangan, inatake nga ba mga unggoy o binaril ng tao?',
    'Argentina, Spain fans flood New York as city bids farewell to World Cup',
    "Volleyball: Aussies sweep Letran to open Shakey's campaign",
    'Romualdez camp: No evidence linking former speaker to flood control mess',
    'Marcos condemns China actions vs. Filipino troops in West PH Sea -- Palace',
    'Naaksidenteng rider, natuklasang nakaw ang gamit na motor; plate number, nakaw din',
    'Carnapper tiklo matapos maaksidente habang gamit ang nakaw na plaka',
  ]
  for (const headline of newsOnly) {
    assert.equal(classifyNewsIncident(headline).isHazard, false, headline)
  }

  assert.equal(
    classifyNewsIncident('Residential fire destroys homes in Barangay Panghulo, Malabon City').category,
    'fire',
  )
  assert.equal(
    classifyNewsIncident('Drone strike kills three soldiers at a military base in Ukraine').category,
    'security-conflict',
  )
  assert.equal(
    classifyNewsIncident('Naaksidenteng rider, sugatan sa banggaan sa Quezon City').category,
    'road-incident',
  )
})

check('English and Filipino resolution wording shortens an ended incident lifetime', () => {
  for (const headline of [
    'Residential fire in Manila is now under control',
    'Sunog sa Barangay Panghulo, naapula na',
    'Baha sa Malabon, humupa na',
  ]) {
    assert.equal(classifyNewsIncident(headline).resolved, true, headline)
  }
})

check('retrospectives, metaphors, preparedness stories, and fire-service stories are not live incidents', () => {
  for (const headline of [
    'PSE shares fall after global market crash',
    'Team is on fire heading into the finals',
    'Agency receives flood of applications',
    'Fire Prevention Month campaign opens in Manila',
    'Fire station receives a new rescue truck',
    'Festival opens with ceremonial fire dance in Cebu',
    'Bonfire festival draws tourists to town',
    'Earthquake preparedness drill held in schools',
    'Remembering the 1990 Luzon earthquake',
    'Senate probe examines flood control projects in Bulacan',
    'Lawmakers trade blame over flood-control corruption controversy',
    'Identity theft prevention bill advances in Senate',
    'Military procurement budget approved by committee',
    'Army holds training exercise with allies',
    'Murder case trial resumes next week',
    'Robbery suspect arrested over 2024 case',
    'Dog shot dead after attacking livestock',
    'Actor drops bombshell in television interview',
    'Senators wage war of words over budget',
  ]) {
    assert.equal(classifyNewsIncident(headline).isHazard, false, headline)
  }
})

check('Filipino barangay and dateline locations are extracted without requiring an English verb', () => {
  const filipino = extractLocationCandidates(
    'Sunog sa Barangay Doña Imelda, Quezon City',
    'Patuloy ang operasyon ng mga bumbero.',
  )
  assert.ok(
    filipino.some(value => /Barangay Doña Imelda,\s*Quezon City/i.test(value)),
    JSON.stringify(filipino),
  )
  const dateline = extractLocationCandidates('BAGUIO CITY — Landslide blocks Kennon Road')
  assert.ok(dateline.some(value => value === 'BAGUIO CITY'), JSON.stringify(dateline))

  const temporalCases = [
    ['Fire breaks out in Tondo on Sunday morning', 'Tondo'],
    ['Baha sa Malabon City nitong Linggo', 'Malabon City'],
    ['Aksidente sa EDSA noong Lunes', 'EDSA'],
  ]
  for (const [headline, expected] of temporalCases) {
    const candidates = extractLocationCandidates(headline)
    assert.ok(candidates.includes(expected), `${headline}: ${JSON.stringify(candidates)}`)
  }
})

check('location extraction does not treat trailing prose as part of a place', () => {
  const candidates = extractLocationCandidates(
    'Fire hits homes in Manila residents rush to safety',
  )
  assert.equal(
    candidates.some(value => /residents rush to safety/i.test(value)),
    false,
    JSON.stringify(candidates),
  )
})

check('location extraction prefers an incident-role location and ignores later contextual places', () => {
  const candidates = extractLocationCandidates(
    'Earthquake epicenter was near Lubang, Occidental Mindoro. Residents in Manila felt the tremor.',
  )
  assert.match(candidates[0] ?? '', /Lubang,\s*Occidental Mindoro/i)
  assert.equal(candidates.some(value => value === 'Manila'), false, JSON.stringify(candidates))
})

check('maritime incidents never use a named island or province as a land marker', () => {
  const vesselFire = marineIncidentLocation('Boat fire reported near Romblon')
  assert.equal(vesselFire.isMaritimeIncident, true)
  assert.equal(vesselFire.coordinate, null)

  const reportedPosition = marineIncidentLocation(
    'Vessel fire in waters off Romblon at 12.3456 N, 122.4567 E',
  )
  assert.deepEqual(reportedPosition, {
    isMaritimeIncident: true,
    coordinate: {
      lat: 12.3456,
      lng: 122.4567,
      locationName: 'Reported offshore position',
      locationQuery: 'publisher-reported offshore coordinate',
      locationPrecision: 'offshore',
      locationConfidence: 0.92,
    },
  })
})

check('geocoding accepts a matching Philippine locality above the map threshold', () => {
  const scored = scorePhotonLocation('Barangay Panghulo, Malabon City', {
    geometry: { coordinates: [120.958, 14.687] },
    properties: {
      name: 'Panghulo',
      district: 'Panghulo',
      city: 'Malabon',
      state: 'Metro Manila',
      country: 'Philippines',
      countrycode: 'PH',
    },
  })
  assert.ok(scored)
  assert.equal(scored.locationPrecision, 'locality')
  assert.ok(scored.locationConfidence >= 0.7)
})

check('geocoding rejects wrong-country, out-of-bounds, and mismatched results', () => {
  const base = {
    geometry: { coordinates: [120.9842, 14.5995] },
    properties: {
      name: 'Manila',
      city: 'Manila',
      state: 'Metro Manila',
      country: 'Philippines',
      countrycode: 'PH',
    },
  }
  assert.equal(
    scorePhotonLocation('Manila', {
      ...base,
      properties: { ...base.properties, countrycode: 'US' },
    }),
    null,
  )
  assert.equal(
    scorePhotonLocation('Manila', {
      ...base,
      geometry: { coordinates: [-74.006, 40.7128] },
    }),
    null,
  )
  assert.equal(scorePhotonLocation('Cebu City', base), null)
})

check('geocoding does not map an overlong prose fragment on one matching city word', () => {
  const scored = scorePhotonLocation('Manila residents rush to safety', {
    geometry: { coordinates: [120.9842, 14.5995] },
    properties: {
      name: 'Manila',
      city: 'Manila',
      state: 'Metro Manila',
      country: 'Philippines',
      countrycode: 'PH',
    },
  })
  assert.equal(scored, null)
})

check('regional geocoder matches remain below the marker threshold', () => {
  const scored = scorePhotonLocation('Luzon', {
    geometry: { coordinates: [121, 14.6] },
    properties: {
      name: 'Luzon',
      state: 'Luzon',
      country: 'Philippines',
      countrycode: 'PH',
    },
  })
  assert.ok(scored)
  assert.equal(scored.locationPrecision, 'region')
  assert.ok(scored.locationConfidence < 0.7)
})

check('incident expiry is 24 hours for local acute incidents, 48 hours for weather/security, and 6 hours when resolved', () => {
  const published = '2026-07-19T00:00:00.000Z'
  assert.equal(incidentExpiry(published, 'fire'), '2026-07-20T00:00:00.000Z')
  assert.equal(incidentExpiry(published, 'road-incident'), '2026-07-20T00:00:00.000Z')
  assert.equal(incidentExpiry(published, 'killing'), '2026-07-20T00:00:00.000Z')
  assert.equal(incidentExpiry(published, 'robbery-theft'), '2026-07-20T00:00:00.000Z')
  for (const category of ['flood', 'typhoon', 'earthquake', 'security-conflict']) {
    assert.equal(incidentExpiry(published, category), '2026-07-21T00:00:00.000Z')
  }
  assert.equal(incidentExpiry(published, 'fire', true), '2026-07-19T06:00:00.000Z')
  assert.equal(incidentExpiry('not-a-date', 'fire'), null)
})

check('cross-source clustering corroborates matching incidents but not same-source copies', () => {
  const shared = {
    category: 'fire',
    published_at: '2026-07-19T03:30:00.000Z',
    location_name: 'Barangay Panghulo, Malabon City',
  }
  const clustered = clusterNewsIncidents([
    {
      id: 'gma-1',
      source_id: 'gma-news',
      title: 'Residential fire damages 10 homes in Barangay Panghulo',
      summary: 'Ten homes were damaged in the blaze.',
      ...shared,
    },
    {
      id: 'abs-1',
      source_id: 'abs-cbn-news',
      title: '10 homes damaged by residential fire in Barangay Panghulo',
      summary: 'A blaze damaged ten homes.',
      ...shared,
      published_at: '2026-07-19T03:35:00.000Z',
    },
  ])
  assert.deepEqual(clustered.get('gma-1'), {
    verificationStatus: 'multiple-outlets-reported',
    corroboratingSources: ['abs-cbn-news', 'gma-news'],
  })
  assert.equal(clustered.get('abs-1')?.verificationStatus, 'multiple-outlets-reported')

  const sameSource = clusterNewsIncidents([
    {
      id: 'gma-2',
      source_id: 'gma-news',
      title: 'Residential fire damages homes in Barangay Panghulo',
      summary: '',
      ...shared,
    },
    {
      id: 'gma-3',
      source_id: 'gma-news',
      title: 'Residential fire damages homes in Barangay Panghulo',
      summary: '',
      ...shared,
    },
  ])
  assert.equal(sameSource.get('gma-2')?.verificationStatus, 'news-reported')
  assert.equal(sameSource.get('gma-3')?.verificationStatus, 'news-reported')

  const missingLocation = clusterNewsIncidents([
    { id: 'gma-4', source_id: 'gma-news', title: 'Fire damages homes', summary: '', category: 'fire', published_at: shared.published_at, location_name: null },
    { id: 'abs-2', source_id: 'abs-cbn-news', title: 'Fire damages homes', summary: '', category: 'fire', published_at: shared.published_at, location_name: 'Barangay Panghulo, Malabon City' },
  ])
  assert.equal(missingLocation.get('gma-4')?.verificationStatus, 'news-reported')
})

check('news remains a distinct secondary map layer and cannot enter proximity alarms', () => {
  const hazardMap = fs.readFileSync(path.join(root, 'src/components/HazardMap.tsx'), 'utf8')
  const newsClient = fs.readFileSync(path.join(root, 'src/lib/news.ts'), 'utf8')
  const newsWorker = fs.readFileSync(path.join(root, 'supabase/functions/news-ingest/index.ts'), 'utf8')
  const migration = fs.readFileSync(
    path.join(root, 'supabase/migrations/20260719090000_news_monitoring_pipeline.sql'),
    'utf8',
  )
  const offshoreMigration = fs.readFileSync(
    path.join(root, 'supabase/migrations/20260719103000_news_offshore_location_precision.sql'),
    'utf8',
  )
  const taxonomyMigration = fs.readFileSync(
    path.join(root, 'supabase/migrations/20260719110000_replace_news_publishers_and_strict_incident_taxonomy.sql'),
    'utf8',
  )
  const indexTransportMigration = fs.readFileSync(
    path.join(root, 'supabase/migrations/20260719111500_switch_blocked_publishers_to_index_transport.sql'),
    'utf8',
  )
  const directRelayMigration = fs.readFileSync(
    path.join(root, 'supabase/migrations/20260719120000_restore_direct_news_transports.sql'),
    'utf8',
  )
  const proximityMonitor = fs.readFileSync(
    path.join(root, 'src/components/BackgroundSafetyCheck.tsx'),
    'utf8',
  )

  assert.match(hazardMap, /newsReports:\s*boolean/)
  assert.match(hazardMap, /News-reported secondary signal/)
  assert.match(hazardMap, /This marker cannot trigger a proximity alarm/)
  assert.match(hazardMap, /key=\{`news-\$\{article\.id\}`\}/)
  assert.match(newsClient, /article\.locationConfidence >= 0\.7/)
  assert.match(newsClient, /Date\.parse\(article\.incidentExpiresAt\) > now/)
  assert.match(newsClient, /proximityAlertEligible:\s*false/)
  assert.match(newsWorker, /proximity_alert_eligible:\s*false/)
  assert.match(newsWorker, /MAX_GEOCODES_PER_RUN\s*=\s*8/)
  assert.match(newsWorker, /MAX_GEOCODER_CONCURRENCY\s*=\s*2/)
  assert.match(newsWorker, /INVOCATION_BUDGET_MS\s*=\s*50_000/)
  assert.match(newsWorker, /budget\.remaining\s*-=/)
  assert.match(newsWorker, /isolatedIngestSource/)
  assert.match(newsWorker, /retryPendingGeocodes/)
  assert.match(newsWorker, /source\.fallbackFeedUrls/)
  assert.match(newsWorker, /errorStage:\s*stage/)
  assert.match(newsWorker, /\[source-lifecycle\]/)
  assert.match(newsWorker, /fetchExistingArticles/)
  assert.match(newsWorker, /marineIncidentLocation/)
  assert.match(newsWorker, /source\.format === 'wp-json'/)
  assert.match(newsWorker, /NEWS_RELAY_URL/)
  assert.match(newsWorker, /x-kalasag-news-relay-secret/)
  assert.match(newsWorker, /source\.fetchStrategy === 'relay-first'/)
  assert.match(newsWorker, /deleteExcludedCurrentArticles/)
  assert.match(newsWorker, /classifyNewsIncident\(article\.title, article\.summary \?\? ''\)\.category !== null/)
  assert.match(newsWorker, /index \+= 20/)
  assert.match(newsWorker, /resolved_at:\s*classification\.resolved\s*\?\s*\(existingContentMatches\s*\?\s*existing\?\.resolved_at/)
  assert.match(migration, /CHECK\s*\(proximity_alert_eligible = false\)/)
  assert.match(offshoreMigration, /'offshore'/)
  assert.match(taxonomyMigration, /ALTER COLUMN category SET NOT NULL/)
  assert.match(taxonomyMigration, /'security-conflict'/)
  assert.match(taxonomyMigration, /DELETE FROM public\.news_articles/)
  assert.match(taxonomyMigration, /source_id IN \('manila-times', 'rappler'\)/)
  assert.doesNotMatch(taxonomyMigration, /other-disaster/)
  assert.match(indexTransportMigration, /google-news-rss-index/)
  assert.match(indexTransportMigration, /last_checked_at = NULL/)
  assert.match(directRelayMigration, /publisher-rss-via-relay/)
  assert.match(directRelayMigration, /publisher-api-via-relay/)
  assert.match(directRelayMigration, /last_checked_at = null/i)
  assert.doesNotMatch(directRelayMigration, /next_check_at/i)
  assert.doesNotMatch(proximityMonitor, /useNews|newsArticles|activeNewsIncidents/)
})

check('client keeps active mapped hazards outside the latest monitored-news window and reports loading states', () => {
  const newsClient = fs.readFileSync(path.join(root, 'src/lib/news.ts'), 'utf8')
  const provider = fs.readFileSync(path.join(root, 'src/hooks/NewsProvider.tsx'), 'utf8')
  const hazardMap = fs.readFileSync(path.join(root, 'src/components/HazardMap.tsx'), 'utf8')
  const newsFeed = fs.readFileSync(path.join(root, 'src/components/NewsFeed.tsx'), 'utf8')
  assert.match(newsClient, /Active mapped incidents may be older than the newest 300 monitored reports/)
  assert.match(newsClient, /abortSignal\(controller\.signal\)/)
  assert.match(newsClient, /isStale/)
  assert.match(newsClient, /healthStatus === 'live' \|\| healthStatus === 'unknown'/)
  assert.match(newsClient, /'updated_at'/)
  assert.match(provider, /NEWS_REFRESH_INTERVAL_MS/)
  assert.match(hazardMap, /Loading news-reported incidents/)
  assert.match(hazardMap, /News incidents temporarily unavailable/)
  assert.match(hazardMap, /setNewsClock/)
  assert.match(newsFeed, /Load more/)
  assert.match(newsFeed, /Intl\.RelativeTimeFormat/)
})

check('publisher content is rendered as escaped React text with citation and an original link', () => {
  const newsFeed = fs.readFileSync(path.join(root, 'src/components/NewsFeed.tsx'), 'utf8')
  const hazardMap = fs.readFileSync(path.join(root, 'src/components/HazardMap.tsx'), 'utf8')
  assert.doesNotMatch(newsFeed, rawHtmlSinkPattern)
  assert.doesNotMatch(hazardMap, rawHtmlSinkPattern)
  assert.match(newsFeed, /Source citation:/)
  assert.match(newsFeed, /Read original/)
  assert.match(newsFeed, /rel="noopener noreferrer"/)
})

console.log(`\n${passed} checks passed; ${failures.length} checks failed.`)
if (failures.length) {
  console.error('\nNews feed regression failures:')
  for (const { name } of failures) console.error(`- ${name}`)
  process.exitCode = 1
}
