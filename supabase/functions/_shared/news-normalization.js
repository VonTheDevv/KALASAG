const PH_BOUNDS = Object.freeze({ minLat: 4.5, maxLat: 21.5, minLng: 116, maxLng: 127.5 })
const MAX_TITLE_LENGTH = 280
const MAX_SUMMARY_LENGTH = 600
const MAX_AUTHOR_LENGTH = 160
const MAX_LOCATION_LENGTH = 160
const ARTICLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export const NEWS_SOURCES = Object.freeze([
  Object.freeze({
    id: 'gma-news',
    name: 'GMA News',
    homeUrl: 'https://www.gmanetwork.com/news/',
    feedUrl: 'https://data.gmanetwork.com/gno/rss/news/feed.xml',
    fallbackFeedUrls: ['https://data2.gmanetwork.com/gno/rss/news/feed.xml'],
    format: 'rss',
    enabled: true,
    pollIntervalSeconds: 60,
    transport: 'publisher-rss',
    allowedFeedHosts: ['data.gmanetwork.com', 'data2.gmanetwork.com'],
    allowedArticleHosts: ['gmanetwork.com', 'www.gmanetwork.com'],
    statusDetail: 'Official publisher RSS; headline, excerpt, time, and source link only.',
  }),
  Object.freeze({
    id: 'abs-cbn-news',
    name: 'ABS-CBN News',
    homeUrl: 'https://www.abs-cbn.com/news',
    feedUrl: 'https://www.abs-cbn.com/feed',
    format: 'rss',
    enabled: true,
    pollIntervalSeconds: 90,
    transport: 'publisher-feed',
    allowedFeedHosts: ['abs-cbn.com', 'www.abs-cbn.com'],
    allowedArticleHosts: ['abs-cbn.com', 'www.abs-cbn.com', 'news.abs-cbn.com'],
    statusDetail: 'Publisher feed metadata only; article bodies are not copied.',
  }),
  Object.freeze({
    id: 'daily-tribune',
    name: 'Daily Tribune',
    homeUrl: 'https://tribune.net.ph/news/',
    feedUrl: 'https://tribune.net.ph/news-sitemap.xml',
    format: 'news-sitemap',
    enabled: true,
    pollIntervalSeconds: 60,
    transport: 'publisher-news-sitemap',
    allowedFeedHosts: ['tribune.net.ph', 'www.tribune.net.ph'],
    allowedArticleHosts: ['tribune.net.ph', 'www.tribune.net.ph'],
    statusDetail: 'Publisher news-sitemap metadata only; author and excerpt may be unavailable.',
  }),
  Object.freeze({
    id: 'inquirer-newsinfo',
    name: 'Inquirer NewsInfo',
    homeUrl: 'https://newsinfo.inquirer.net/category/latest-stories',
    feedUrl: 'https://newsinfo.inquirer.net/category/latest-stories/feed',
    format: 'rss',
    enabled: true,
    pollIntervalSeconds: 60,
    transport: 'publisher-rss-via-relay',
    fetchStrategy: 'relay-first',
    allowedFeedHosts: ['newsinfo.inquirer.net'],
    allowedArticleHosts: ['newsinfo.inquirer.net'],
    allowSummary: false,
    allowAuthor: false,
    publishedTimeZone: 'Asia/Manila-wall-clock',
    statusDetail: 'Official publisher RSS through the bounded server relay; headline, time, and source link only.',
  }),
  Object.freeze({
    id: 'manila-standard',
    name: 'Manila Standard',
    homeUrl: 'https://manilastandard.net/category/news',
    feedUrl: 'https://manilastandard.net/wp-json/wp/v2/posts?categories=25&per_page=100&_fields=id%2Clink%2Ctitle%2Cdate_gmt%2C_embedded&_embed=author',
    format: 'wp-json',
    enabled: true,
    pollIntervalSeconds: 60,
    transport: 'publisher-api-via-relay',
    fetchStrategy: 'relay-first',
    allowedFeedHosts: ['manilastandard.net'],
    allowedArticleHosts: ['manilastandard.net'],
    allowSummary: false,
    allowAuthor: true,
    statusDetail: 'Official publisher metadata API through the bounded server relay; article bodies are not copied.',
  }),
])

export const NEWS_CATEGORY_VALUES = Object.freeze([
  'fire',
  'flood',
  'road-incident',
  'killing',
  'robbery-theft',
  'typhoon',
  'earthquake',
  'security-conflict',
])

const namedEntities = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
})

function validXmlScalar(point) {
  return point === 0x09
    || point === 0x0a
    || point === 0x0d
    || (point >= 0x20 && point <= 0xd7ff)
    || (point >= 0xe000 && point <= 0xfffd)
    || (point >= 0x10000 && point <= 0x10ffff)
}

function decodeXmlEntities(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    const normalized = String(code).toLowerCase()
    if (normalized.startsWith('#x')) {
      const point = Number.parseInt(normalized.slice(2), 16)
      return Number.isInteger(point) && validXmlScalar(point) ? String.fromCodePoint(point) : ' '
    }
    if (normalized.startsWith('#')) {
      const point = Number.parseInt(normalized.slice(1), 10)
      return Number.isInteger(point) && validXmlScalar(point) ? String.fromCodePoint(point) : ' '
    }
    return namedEntities[normalized] ?? entity
  })
}

function sanitizeTextScalars(value) {
  const text = String(value ?? '')
  let output = ''
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += text[index] + text[index + 1]
        index += 1
      } else {
        output += ' '
      }
      continue
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      output += ' '
      continue
    }
    if (!validXmlScalar(unit)) {
      output += ' '
      continue
    }
    output += text[index]
  }
  return output
}

function unwrapCdata(value) {
  return String(value ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

export function stripFeedMarkup(value, limit = MAX_SUMMARY_LENGTH) {
  let decoded = unwrapCdata(value)
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decodeXmlEntities(decoded)
    if (next === decoded) break
    decoded = next
  }
  const withoutExecutableMarkup = decoded
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  return [...sanitizeTextScalars(withoutExecutableMarkup).replace(/\s+/g, ' ').trim()]
    .slice(0, Math.max(0, limit))
    .join('')
}

function tagPattern(name) {
  return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function firstTag(block, names) {
  for (const name of names) {
    const match = String(block).match(new RegExp(`<${tagPattern(name)}\\b[^>]*>([\\s\\S]*?)<\\/${tagPattern(name)}>`, 'i'))
    if (match) return unwrapCdata(match[1]).trim()
  }
  return ''
}

function linkFromEntry(block) {
  const rssLink = firstTag(block, ['link'])
  if (rssLink && !rssLink.includes('<')) return stripFeedMarkup(rssLink, 2_048)
  const atomLink = String(block).match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i)
  return atomLink ? decodeXmlEntities(atomLink[1]).trim() : ''
}

function validPublishedAt(value, detectedAt) {
  const timestamp = Date.parse(String(value ?? ''))
  const detected = Date.parse(String(detectedAt ?? ''))
  if (!Number.isFinite(timestamp) || !Number.isFinite(detected)) return null
  if (timestamp > detected + 15 * 60_000) return null
  if (timestamp < detected - ARTICLE_RETENTION_MS) return null
  return new Date(timestamp).toISOString()
}

function hostnameAllowed(hostname, allowedHosts) {
  const normalized = String(hostname ?? '').toLowerCase().replace(/\.$/, '')
  return allowedHosts.some(host => normalized === host || normalized.endsWith(`.${host}`))
}

export function normalizeArticleUrl(value, allowedHosts) {
  try {
    const url = new URL(String(value ?? '').trim())
    if (url.protocol !== 'https:' || url.username || url.password || !hostnameAllowed(url.hostname, allowedHosts)) return null
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|mc_cid|mc_eid|ref|source)$/i.test(key)) url.searchParams.delete(key)
    }
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function normalizeAuthor(value) {
  const author = stripFeedMarkup(value, MAX_AUTHOR_LENGTH)
    .replace(/^(?:by|written by)\s+/i, '')
    .trim()
  return author || null
}

function publisherPublishedValue(value, source) {
  const normalized = String(value ?? '').trim()
  if (source?.publishedTimeZone !== 'Asia/Manila-wall-clock') return normalized
  // Inquirer currently emits Philippine wall-clock values with a +0000/GMT
  // suffix. Treat that wall clock as UTC+08:00 instead of rejecting fresh
  // items as eight hours in the future.
  return normalized
    .replace(/\s+(?:\+0000|GMT)$/i, ' +0800')
    .replace(/T(\d{2}:\d{2}:\d{2})(?:Z|\+00:00)$/i, 'T$1+08:00')
}

function articleFromBlock(block, source, detectedAt) {
  let title = stripFeedMarkup(firstTag(block, ['title']), MAX_TITLE_LENGTH)
  for (const suffix of [source.name, ...(source.titleSuffixes ?? [])]) {
    title = title.replace(new RegExp(`\\s+-\\s+${tagPattern(suffix)}\\s*$`, 'i'), '').trim()
  }
  const canonicalUrl = normalizeArticleUrl(linkFromEntry(block) || firstTag(block, ['guid', 'id']), source.allowedArticleHosts)
  const publishedAt = validPublishedAt(
    publisherPublishedValue(firstTag(block, ['pubDate', 'published', 'updated', 'dc:date']), source),
    detectedAt,
  )
  if (!title || !canonicalUrl || !publishedAt) return null
  const summary = source.allowSummary === false
    ? ''
    : stripFeedMarkup(firstTag(block, ['description', 'summary']), MAX_SUMMARY_LENGTH)
  const authorBlock = firstTag(block, ['dc:creator', 'author', 'creator'])
  const atomAuthor = firstTag(authorBlock, ['name'])
  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceHomeUrl: source.homeUrl,
    canonicalUrl,
    title,
    summary: summary || null,
    author: source.allowAuthor === false ? null : normalizeAuthor(atomAuthor || authorBlock),
    publishedAt,
    detectedAt,
    transport: source.transport,
  }
}

function articleFromSitemapBlock(block, source, detectedAt) {
  const title = stripFeedMarkup(firstTag(block, ['news:title']), MAX_TITLE_LENGTH)
  const canonicalUrl = normalizeArticleUrl(firstTag(block, ['loc']), source.allowedArticleHosts)
  const publishedAt = validPublishedAt(firstTag(block, ['news:publication_date', 'lastmod']), detectedAt)
  if (!title || !canonicalUrl || !publishedAt) return null
  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceHomeUrl: source.homeUrl,
    canonicalUrl,
    title,
    summary: null,
    author: null,
    publishedAt,
    detectedAt,
    transport: source.transport,
  }
}

function wordpressPublishedAt(value) {
  const normalized = String(value ?? '').trim()
  if (!normalized) return ''
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`
}

function articleFromWordPressEntry(entry, source, detectedAt) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const title = stripFeedMarkup(entry.title?.rendered, MAX_TITLE_LENGTH)
  const canonicalUrl = normalizeArticleUrl(entry.link, source.allowedArticleHosts)
  const publishedAt = validPublishedAt(wordpressPublishedAt(entry.date_gmt), detectedAt)
  if (!title || !canonicalUrl || !publishedAt) return null
  const summary = source.allowSummary === false
    ? ''
    : stripFeedMarkup(entry.excerpt?.rendered, MAX_SUMMARY_LENGTH)
  const embeddedAuthor = Array.isArray(entry._embedded?.author)
    ? entry._embedded.author[0]?.name
    : null
  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceHomeUrl: source.homeUrl,
    canonicalUrl,
    title,
    summary: summary || null,
    author: source.allowAuthor === false
      ? null
      : normalizeAuthor(embeddedAuthor || entry.yoast_head_json?.author),
    publishedAt,
    detectedAt,
    transport: source.transport,
  }
}

function parseWordPressFeed(payload, source, detectedAt) {
  let entries
  try {
    entries = JSON.parse(String(payload ?? ''))
  } catch {
    throw new Error('Publisher API returned invalid JSON')
  }
  if (!Array.isArray(entries)) throw new Error('Publisher API returned an invalid payload')
  const seen = new Set()
  const articles = []
  for (const entry of entries.slice(0, 150)) {
    const article = articleFromWordPressEntry(entry, source, detectedAt)
    if (!article || seen.has(article.canonicalUrl)) continue
    seen.add(article.canonicalUrl)
    articles.push(article)
  }
  return articles.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
}

export function parseSyndicationFeed(payload, source, detectedAt = new Date().toISOString()) {
  if (!source || !source.enabled) return []
  if (source.format === 'wp-json') return parseWordPressFeed(payload, source, detectedAt)
  const text = String(payload ?? '')
  if (!text.trim() || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Unsafe XML declaration')
  const blocks = source.format === 'news-sitemap'
    ? [...text.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].map(match => match[1])
    : [...text.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)].map(match => match[1])
  const seen = new Set()
  const articles = []
  for (const block of blocks.slice(0, 150)) {
    const article = source.format === 'news-sitemap'
      ? articleFromSitemapBlock(block, source, detectedAt)
      : articleFromBlock(block, source, detectedAt)
    if (!article || seen.has(article.canonicalUrl)) continue
    seen.add(article.canonicalUrl)
    articles.push(article)
  }
  return articles.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
}

const retrospectivePattern = /\b(?:anniversary|commemorat(?:e|es|ed|ing|ion)|memorial|remember(?:ing|ed)?|look back|history of|tribute)\b/i
const metaphorPattern = /\b(?:market crash|stock crash|political storm|social media storm|storm of criticism|team (?:is|was|on) fire|flood of (?:applications|messages|complaints)|fire sale|draws? fire|bombshell|war of words)\b/i
const culturalFirePattern = /\b(?:theater|theatre|film|movie|book|album|music|review|classic)\b.{0,80}\bfire\b|\bfire\b.{0,80}\b(?:theater|theatre|film|movie|book|album|music|review|classic)\b/i
const floodControlStoryPattern = /\bflood[\s-]+control\b|\b(?:ghost\s+)?flood(?:[\s-]+control)?\s+projects?\b/i
const strongFloodIncidentPattern = /\b(?:flash floods?|flooding|flooded|inundat(?:e|ed|ion)|baha|pagbaha|binaha|bumaha|overflow(?:s|ed)?)\b|\bfloods?\b.{0,45}\b(?:affect(?:s|ed)?|closes?|displaces?|engulfs?|forces?|hits?|kills?|strands?|submerges?|sweeps?)\b/i
const crimeFollowupPattern = /\b(?:murder|homicide|killing|robbery|theft|hold-?up|holdup)\s+(?:case|raps|trial|hearing|probe|investigation|suspect|accused)\b|\b(?:suspect|accused)\b.{0,100}\b(?:murder|homicide|killing|robbery|theft|hold-?up|holdup)\b|\b(?:charged|convicted|sentenced|acquitted|arraigned|indicted)\b.{0,100}\b(?:murder|homicide|killing|robbery|theft)\b/i
const concludedCrimePattern = /\b(?:arrest(?:s|ed)?|apprehend(?:s|ed)?|caught|captur(?:e|es|ed)|detain(?:s|ed)?|nabbed|surrender(?:s|ed)?|tiklo|arestado|naaresto|nahuli)\b/i
const nonIncidentTheftPattern = /\b(?:anti-theft|identity theft|intellectual property theft|wage theft|data theft|theft protection|theft prevention|theft law)\b/i
const nonIncidentSecurityPattern = /\b(?:military|army|armed forces|defen[cs]e)\b.{0,80}\b(?:appointment|budget|cooperation|exercise|forum|parade|procurement|purchase|seminar|training)\b|\b(?:appointment|budget|cooperation|exercise|forum|parade|procurement|purchase|seminar|training)\b.{0,80}\b(?:military|army|armed forces|defen[cs]e)\b/i
const nonHumanKillingPattern = /\b(?:agila|animal|ape|bird|buffalo|carabao|cat|cattle|cow|crocodile|deer|dog|dolphin|eagle|fish|goat|horse|livestock|macaque|monkey|pet|pig|primate|shark|snake|tiger|turtle|unggoy|whale|wildlife)\b.{0,55}\b(?:binaril|killed|murdered|pinatay|pinaslang|shot dead|sinaksak|slain)\b|\b(?:binaril|killed|murdered|pinatay|pinaslang|shot dead|sinaksak|slain)\b.{0,55}\b(?:agila|animal|ape|bird|buffalo|carabao|cat|cattle|cow|crocodile|deer|dog|dolphin|eagle|fish|goat|horse|livestock|macaque|monkey|pet|pig|primate|shark|snake|tiger|turtle|unggoy|whale|wildlife)\b/i
const humanKillingPattern = /\b(?:man|woman|person|civilian|resident|driver|rider|teen(?:ager)?|child|children|couple|worker|police officer|soldier)\b.{0,45}\b(?:killed|slain|murdered|gunned down|shot dead|stabbed to death)\b/i
const politicalLegalThreatPattern = /\b(?:alleged(?:ly)?|claim(?:s|ed)?|accus(?:e|es|ed|ation)|den(?:y|ies|ied)|impeach(?:ment|ed)?|remark|statement|testimony)\b.{0,100}\b(?:death threat|murder plot|threat(?:s|en|ened|ening)?\s+to\s+(?:kill|murder|shoot|assassinate))\b|\b(?:death threat|murder plot|threat(?:s|en|ened|ening)?\s+to\s+(?:kill|murder|shoot|assassinate))\b.{0,100}\b(?:hearing|impeach(?:ment|ed)?|remark|statement|testimony)\b/i
const legalProceedingPattern = /\b(?:appeal|court doctrine|evidence|hearing|impeach(?:ment|ed)?|inquest|investigation|murder case|probe|testimony|trial|verdict)\b/i
const aftermathCoveragePattern = /\b(?:aftermath|aids?|assistance|donat(?:e|es|ed|ing|ion|ions)|fundrais(?:er|ers|ing)|funeral|livelihood support|mourning|rebuild(?:s|ing)?|reconstruct(?:s|ed|ion)?|recovery|rehab(?:ilitation)?|relief|survivors? receive|victims? receive)\b/i
const aftermathLeadPattern = /\b(?:aids?|assists?|donat(?:e|es|ed|ing)|distribut(?:e|es|ed|ing)|gives?|helps? secure|provides?|secures?|turns? over)\b.{0,110}\b(?:aid|assistance|families|relief|survivors?|victims?)\b/i
const preparednessCoveragePattern = /\b(?:drill|preparedness|response exercise|seminar|simulation|training)\b/i
const historicalContextPattern = /\bin\s+(?:19|20)\d{2}\b|\b(?:after|nearly|over)\s+(?:a|an|one|\d+)\s+(?:year|years|month|months)\b|\b\d+\s+years?\s+(?:after|since)\b/i
const sportsContextPattern = /\b(?:athlete|basketball|coach|court|finals?|football|game|league|match|pba|player|sports?|team|tournament|uaap|volleyball)\b/i
const roadCrimeFollowupPattern = /\b(?:accident|maaksidente|naaksidente|naaksidenteng)\b.{0,120}\b(?:carnap(?:ped|per)?|nakaw|stolen|theft)\b|\b(?:carnap(?:ped|per)?|nakaw|stolen|theft)\b.{0,120}\b(?:accident|maaksidente|naaksidente|naaksidenteng)\b/i
const statementOnlySecurityPattern = /\b(?:dfa|government|officials?|president|senator|spokesperson|united nations|un)\b.{0,70}\b(?:appeals?|calls? for|condemns?|denounces?|expresses? concern|issues? (?:a )?statement|reacts?|slams?|urges?)\b|\b(?:statement|condemnation|reaction)\b.{0,70}\b(?:attack|bombing|military|terror(?:ism|ist)?)\b/i
const naturalHazardContextPattern = /\b(?:blaze|earthquake|fire|flood(?:ing|ed|s)?|landslide|quake|storm|typhoon|wildfire)\b/i

// A headline-only classifier cannot prove a location for every local report.
// It can, however, keep explicitly foreign routine incidents out. Ambiguous
// Philippine-source headlines remain eligible and still need a PH geocoder
// match before they can become map markers.
const philippineJurisdictionPattern = /\b(?:barangay|brgy\.?|philippines?|philippine|filipino|luzon|visayas|mindanao|metro manila|ncr|manila|quezon city|caloocan|malabon|valenzuela|makati|pasig|taguig|paranaque|para[ñn]aque|las pi[ñn]as|muntinlupa|marikina|pasay|mandaluyong|navotas|cebu|davao|benguet|samar|leyte|palawan|romblon|bicol|ilocos|cagayan|pangasinan|bulacan|cavite|laguna|batangas|rizal|mindoro|panay|negros|bohol|zamboanga|cotabato|surigao|agusan)\b/i
const explicitForeignJurisdictionPattern = /\b(?:afghan|afghanistan|american|argentina|argentine|australia|australian|bangladesh|beijing|brazil|brazilian|britain|british|cambodia|cambodian|canada|canadian|chile|chilean|china|chinese|colombia|colombian|ethiopia|ethiopian|france|french|gaza|german|germany|hong kong|india|indian|indonesia|indonesian|iran|iranian|iraq|iraqi|israel|israeli|italian|italy|jakarta|japan|japanese|kenya|kenyan|kuala lumpur|laos|lebanese|lebanon|london|malaysia|malaysian|mexican|mexico|moscow|myanmar|nepal|nepali|new zealand|nigeria|nigerian|north korea|pakistan|pakistani|palestine|palestinian|paris|peru|peruvian|poland|polish|portugal|portuguese|qatar|russia|russian|saudi arabia|singapore|singaporean|somalia|somali|south africa|south african|south korea|spain|spanish|sri lanka|sudan|sydney|syria|syrian|taipei|taiwan|taiwanese|thailand|thai|tokyo|turkey|turkish|t[uü]rkiye|uae|ukraine|ukrainian|united arab emirates|united kingdom|united states|u\.s\.a?\.?|usa|vietnam|vietnamese|west bank|yemen|yemeni)\b/i

const strongCurrentIncidentPatterns = Object.freeze({
  fire: /\b(?:fire|blaze|wildfire)\b.{0,60}\b(?:breaks?|broke|burns?|damages?|destroys?|displaces?|engulfs?|erupts?|forces?|hits?|kills?|prompts?|rages?|razes?|rips?|spreads?|sweeps?)\b|\b(?:catches?|caught|engulfed in|razed by)\s+fire\b|\b(?:nasusunog|nasunog|nagliyab|sunog|tupok)\b/i,
  flood: strongFloodIncidentPattern,
  'road-incident': /\b(?:accident|banggaan|bumangga|collision|crash|nabangga|naaksidente|naaksidenteng|nasagasaan|overturned|pile-?up|rollover|sumalpok)\b/i,
  typhoon: /\b(?:typhoon|tropical (?:storm|depression|cyclone)|super typhoon|bagyo|habagat|low pressure area|lpa)\b.{0,80}\b(?:approaches?|enters?|exits?|forecast|hits?|intensifies?|landfall|lalakas|leaves?|makes?|rainfall|signal|strikes?|warning|winds?|weakens?)\b|\b(?:inaasahan|inaasahang|signal|warning)\b.{0,80}\b(?:bagyo|typhoon|storm)\b/i,
  earthquake: /\b(?:magnitude\s*\d|earthquake|quake|aftershock|tremor)\b.{0,60}\b(?:detected|hits?|jolts?|recorded|rocks?|shakes?|strikes?)\b|\b(?:lindol|pagyanig|niyanig|yumanig)\b/i,
  killing: /\b(?:fatal shooting|deadly stabbing|murdered|slain|assassinated|gunned down|shot dead|stabbed to death|pinatay|pinaslang|binaril|sinaksak|pamamaril)\b/i,
  'robbery-theft': /\b(?:robbery|hold-?up|holdup|burglary|snatching|carjacking|kidnapping|abduction|robbed|held up|stolen|burglarized|carjacked|kidnapped|abducted|holdap|holdaper|nakawan|pagnanakaw|ninakaw|tinangay|dinukot)\b/i,
  'security-conflict': /\b(?:terror(?:ist|ism)?\s+(?:attack|plot)|terror attack|suicide bombing|bombing|bomb blast|airstrike|air strike|missile strike|drone strike|armed clash|military offensive|combat operation|engkwentro|sagupaan|pagbobomba)\b/i,
})

const categoryRules = Object.freeze([
  {
    category: 'fire',
    patterns: [
      /\bwildfires?\b/i,
      /\b(?:structure|residential|house|building|warehouse|factory|market|school|hospital|vehicle|forest|grass|wildland|wild)\s+(?:fire|blaze)\b/i,
      /\b(?:fire|blaze)\s+(?:breaks?|broke)\s+out\b/i,
      /\b(?:fire|blaze)\s+(?:damages?|destroys?|displaces?|engulfs?|erupts?|hits?|kills?|razes?|rips?|sweeps?)\b/i,
      /\b(?:dead|displaced|families?|homes?|houses?|hurt|injured|killed|residents?)\b.{0,70}\b(?:fire|blaze)\b/i,
      /\b(?:sunog|nasusunog|nasunog|nagliyab|tupok)\b/i,
      /\b(?:catches?|caught|engulfed in|razed by)\s+fire\b/i,
    ],
  },
  {
    category: 'flood',
    patterns: [
      /\b(?:flash )?flood(?:ing|ed|s)?\b/i,
      /\b(?:baha|pagbaha|binaha|bumaha|inundat(?:e|ed|ion))\b/i,
      /\b(?:river|creek|water)\s+(?:overflows?|rose|rises?)\b/i,
    ],
  },
  {
    category: 'road-incident',
    patterns: [
      /\b(?:road|traffic|vehicular|vehicle|car|bus|truck|van|jeepney|motorcycle|tricycle)\s+(?:accident|crash(?:es|ed)?|collision|pile-?up)\b/i,
      /\b(?:accident|crash(?:es|ed)?|collision|pile-?up)\s+(?:on|along|involving|between)\b/i,
      /\b(?:road mishap|banggaan|aksidente|maaksidente|naaksidente|naaksidenteng|bumangga|nabangga|sumalpok|nasagasaan|rollover|overturned)\b/i,
      /\b(?:car|bus|truck|van|jeepney|motorcycle|tricycle)\s+(?:falls?|fell|plunges?|plunged)\s+(?:into|off)\b/i,
    ],
  },
  {
    category: 'typhoon',
    patterns: [
      /\b(?:typhoon|tropical (?:storm|depression|cyclone)|super typhoon|storm surge)\b/i,
      /\b(?:bagyo|habagat|low pressure area|LPA)\b/i,
    ],
  },
  {
    category: 'earthquake',
    patterns: [
      /\b(?:earthquake|quake|aftershock|tremor)\b/i,
      /\b(?:lindol|pagyanig|niyanig)\b/i,
    ],
  },
  {
    category: 'security-conflict',
    patterns: [
      /\b(?:terror(?:ist|ism)?\s+(?:attack|plot|threat)|terror attack|suicide bombing|bombing|bomb blast)\b/i,
      /\b(?:airstrike|air strike|missile strike|drone strike|armed clash|military offensive|combat operation)\b/i,
      /\b(?:army|military|armed forces|troops?|soldiers?)\b.{0,80}\b(?:attack|clash|combat|deploy(?:s|ed|ment)?|offensive|operation|raid|strike)\b/i,
      /\b(?:engkwentro|sagupaan|terorismo|pagbobomba)\b/i,
    ],
  },
  {
    category: 'killing',
    patterns: [
      /\b(?:murder|homicide|assassination|fatal shooting|deadly stabbing)\b/i,
      /\b(?:murdered|slain|assassinated|gunned down|shot dead|stabbed to death)\b/i,
      /\b(?:man|woman|person|civilian|resident|driver|rider|teen(?:ager)?|child|children|couple|worker|police officer|soldier)\b.{0,45}\b(?:killed|slain|murdered|gunned down|shot dead|stabbed to death)\b/i,
      /\b(?:pinatay|pinaslang|binaril|sinaksak|pamamaril)\b/i,
    ],
  },
  {
    category: 'robbery-theft',
    patterns: [
      /\b(?:robbery|hold-?up|holdup|burglary|theft|snatching|carjacking|kidnapping|abduction)\b/i,
      /\b(?:robbed|held up|stolen|burglarized|carjacked|kidnapped|abducted)\b/i,
      /\b(?:holdap|holdaper|nakawan|pagnanakaw|ninakaw|tinangay|dinukot)\b/i,
    ],
  },
])

const resolutionPattern = /\b(?:contained|extinguished|fire out|under control|cleared|road reopened|reopened to traffic|resolved|ended|lifted|all clear|humupa|apula|naapula|kontrolado)\b/i
const routineIncidentCategories = new Set([
  'fire',
  'flood',
  'road-incident',
  'killing',
  'robbery-theft',
  'typhoon',
  'earthquake',
])
const concreteSecurityOutcomePattern = /\b(?:attack|bombing|blast|clash|combat|offensive|raid|strike)\b.{0,70}\b(?:damages?|destroys?|hits?|injures?|kills?|leaves?|strikes?)\b|\b(?:dead|deaths?|injured|killed|wounded)\b.{0,70}\b(?:attack|bombing|blast|clash|raid|strike)\b/i

export function classifyNewsIncident(title, summary = '') {
  const headline = String(title ?? '').replace(/\s+/g, ' ').trim()
  const supportingText = String(summary ?? '').replace(/\s+/g, ' ').trim()
  const text = `${headline} ${supportingText}`.trim()
  if (
    !headline
    || retrospectivePattern.test(headline)
    || metaphorPattern.test(headline)
    || culturalFirePattern.test(headline)
  ) {
    return { category: null, isHazard: false, resolved: false }
  }
  for (const rule of categoryRules) {
    // The publisher headline must independently identify the category. Feed
    // excerpts often recap older or unrelated events and may only add status
    // context (for example, that a headline-reported fire is now contained).
    if (!rule.patterns.some(pattern => pattern.test(headline))) continue
    const strongCurrentPattern = strongCurrentIncidentPatterns[rule.category]
    const reportsCurrentIncident = Boolean(strongCurrentPattern?.test(headline))
    if (
      routineIncidentCategories.has(rule.category)
      && explicitForeignJurisdictionPattern.test(headline)
      && !philippineJurisdictionPattern.test(headline)
    ) continue
    if (
      rule.category === 'flood'
      && floodControlStoryPattern.test(headline)
      && !strongFloodIncidentPattern.test(headline)
    ) continue
    if (
      (aftermathCoveragePattern.test(headline)
        || preparednessCoveragePattern.test(headline)
        || historicalContextPattern.test(headline))
      && !reportsCurrentIncident
    ) continue
    if (routineIncidentCategories.has(rule.category) && aftermathLeadPattern.test(headline)) continue
    if (
      rule.category === 'flood'
      && sportsContextPattern.test(headline)
      && !reportsCurrentIncident
    ) continue
    if (rule.category === 'road-incident' && roadCrimeFollowupPattern.test(headline)) continue
    if (
      (rule.category === 'killing' || rule.category === 'robbery-theft')
      && concludedCrimePattern.test(headline)
    ) continue
    if (
      (rule.category === 'killing' || rule.category === 'robbery-theft')
      && (crimeFollowupPattern.test(headline) || legalProceedingPattern.test(headline))
      && !reportsCurrentIncident
    ) continue
    if (
      (rule.category === 'killing' || rule.category === 'security-conflict')
      && politicalLegalThreatPattern.test(headline)
    ) continue
    if (
      rule.category === 'killing'
      && nonHumanKillingPattern.test(headline)
      && !humanKillingPattern.test(headline)
    ) continue
    if (rule.category === 'robbery-theft' && nonIncidentTheftPattern.test(headline)) continue
    if (rule.category === 'security-conflict' && nonIncidentSecurityPattern.test(headline)) continue
    if (
      rule.category === 'security-conflict'
      && naturalHazardContextPattern.test(headline)
      && !concreteSecurityOutcomePattern.test(headline)
    ) continue
    if (
      rule.category === 'security-conflict'
      && statementOnlySecurityPattern.test(headline)
      && !concreteSecurityOutcomePattern.test(headline)
    ) continue
    return {
      category: rule.category,
      isHazard: true,
      resolved: resolutionPattern.test(text),
    }
  }
  return { category: null, isHazard: false, resolved: false }
}

function cleanLocationCandidate(value) {
  const cleaned = stripFeedMarkup(value, MAX_LOCATION_LENGTH)
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/\s+(?:after|amid|as|before|during|following|leaving|leaves|killing|kills|injuring|injures|where|while|when)\b.*$/i, '')
    .replace(/\s+on\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:\s+(?:morning|afternoon|evening|night))?\b.*$/i, '')
    .replace(/\s+(?:nitong|noong|kaninang)\b.*$/i, '')
    .replace(/\s+(?:commuters?|families?|motorists?|people|residents?)\s+(?:are|evacuate|flee|leave|rush|seek|were)\b.*$/i, '')
    .replace(/\.\s+.*$/g, '')
    .replace(/[.,;:|\-–—\s]+$/g, '')
    .trim()
  if (
    cleaned.length < 3
    || cleaned.length > MAX_LOCATION_LENGTH
    || cleaned.split(/\s+/).length > 12
    || /^(?:cctv|camera|country|nation|area|region|road|highway|street|sea|coast|province|city|barangay|philippines|video)$/i.test(cleaned)
  ) return null
  return cleaned
}

export function extractLocationCandidates(title, summary = '') {
  const text = stripFeedMarkup(`${String(title ?? '')}. ${String(summary ?? '')}`, 1_200)
  const priorityCandidates = []
  const fallbackCandidates = []
  const addTo = (list, value) => {
    const cleaned = cleanLocationCandidate(value)
    if (
      !cleaned
      || [...priorityCandidates, ...fallbackCandidates]
        .some(item => item.toLowerCase() === cleaned.toLowerCase())
    ) return
    list.push(cleaned)
  }

  // Protect common place abbreviations while splitting. Extraction then runs
  // within one sentence so a capture cannot cross into later incident prose.
  const protectedText = text.replace(
    /\b(?:Brgy|St|Rd|Ave|Blvd|Mt|Gov|Gen|Dr|Sr|Jr)\./gi,
    match => `${match.slice(0, -1)}\uE000`,
  )
  const sentences = protectedText
    .split(/[!?]\s+|\.\s+(?=[A-Z0-9])/)
    .map(sentence => sentence.replace(/\uE000/g, '.').trim())
    .filter(Boolean)
  const place = "([A-Z][A-Za-zÀ-ž0-9 .'’()-]{2,90}(?:,\\s*[A-Z][A-Za-zÀ-ž .'’()-]{2,60})?)"
  const placeEnd = '(?=,\\s+[a-zà-ž]|\\s+(?:after|amid|as|before|during|following|leaves?|leaving|kills?|injures?|where|while|when|on\\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))\\b|[;:|]|$)'

  const incidentRolePatterns = [
    new RegExp(`\\b(?:epicenter|epicentre|sentro ng lindol)\\s+(?:was\\s+)?(?:located\\s+)?(?:near|in|at|off|outside)\\s+${place}${placeEnd}`, 'gi'),
    new RegExp(`\\b(?:landfall|storm center|storm centre|eye of (?:the )?(?:storm|typhoon))\\s+(?:was\\s+)?(?:located\\s+)?(?:near|in|at|over|off|outside|east of|west of|north of|south of)\\s+${place}${placeEnd}`, 'gi'),
    new RegExp(`\\b(?:fire|blaze|sunog|nasusunog|nasunog)\\b.{0,50}?\\b(?:in|at|sa|near|along)\\s+${place}${placeEnd}`, 'gi'),
    new RegExp(`\\b(?:flood(?:ing|ed)?|baha|pagbaha|binaha|bumaha)\\b.{0,50}?\\b(?:in|at|sa|near|along)\\s+${place}${placeEnd}`, 'gi'),
    new RegExp(`\\b(?:accident|crash|collision|pile-?up|aksidente|banggaan)\\b.{0,50}?\\b(?:in|at|sa|near|along|on)\\s+${place}${placeEnd}`, 'gi'),
    new RegExp(`\\b(?:murder|homicide|shooting|stabbing|pamamaril|pinatay|pinaslang)\\b.{0,50}?\\b(?:in|at|sa|near|along)\\s+${place}${placeEnd}`, 'gi'),
    new RegExp(`\\b(?:robbery|hold-?up|holdup|burglary|snatching|carjacking|holdap|nakawan|pagnanakaw)\\b.{0,50}?\\b(?:in|at|sa|near|along)\\s+${place}${placeEnd}`, 'gi'),
    new RegExp(`\\b(?:terror attack|bombing|bomb blast|armed clash|military offensive|engkwentro|sagupaan|pagbobomba)\\b.{0,50}?\\b(?:in|at|sa|near|along)\\s+${place}${placeEnd}`, 'gi'),
  ]
  const incidentSignal = /\b(?:fire|blaze|sunog|nasusunog|nasunog|flood(?:ing|ed)?|baha|pagbaha|binaha|bumaha|accident|crash|collision|pile-?up|aksidente|banggaan|earthquake|quake|lindol|typhoon|storm|bagyo|murder|homicide|shooting|stabbing|pamamaril|pinatay|pinaslang|robbery|hold-?up|holdup|burglary|snatching|carjacking|holdap|nakawan|pagnanakaw|terror attack|bombing|bomb blast|armed clash|military offensive|engkwentro|sagupaan|pagbobomba)\b/i
  for (const sentence of sentences) {
    for (const pattern of incidentRolePatterns) {
      pattern.lastIndex = 0
      for (const match of sentence.matchAll(pattern)) addTo(priorityCandidates, match[1])
    }
  }

  const explicit = new RegExp(`(?:\\b(?:barangay|brgy\\.?|city of|municipality of|province of)\\s+)${place}`, 'g')
  for (const [index, sentence] of sentences.entries()) {
    if (index > 0 && !incidentSignal.test(sentence)) continue
    explicit.lastIndex = 0
    for (const match of sentence.matchAll(explicit)) addTo(priorityCandidates, match[0])
  }

  const dateline = sentences[0]?.match(/^([A-Z][A-Z .'-]{2,70}(?: CITY| PROVINCE)?)\s*(?:—|–|-|:)/)
  if (dateline) addTo(priorityCandidates, dateline[1])

  const preposition = new RegExp(`\\b(?:in|at|sa|near|along|off|outside|across|hits?|strikes?|rocks?)\\s+${place}${placeEnd}`, 'g')
  for (const sentence of sentences) {
    // A generic "in <place>" from a later context sentence is often a
    // witness, agency, or evacuation location rather than the incident. Only
    // use fallback prepositions in a sentence that names the incident itself.
    if (!incidentSignal.test(sentence)) continue
    preposition.lastIndex = 0
    for (const match of sentence.matchAll(preposition)) addTo(fallbackCandidates, match[1])
  }

  return [...priorityCandidates, ...fallbackCandidates].slice(0, 4)
}

const maritimeVehiclePattern = /\b(?:vessel|ship|boat|ferry|motor(?:ized)?boat|banca|bangka|yacht|cargo ship|passenger ship|tugboat)\b/i
const maritimeWaterPattern = /\b(?:waters? (?:off|of|near)|offshore|at sea|open sea|sea|strait|channel|gulf|bay|nautical miles?|nm\b|karagatan|dagat|katubigan)\b/i
const preciseCoordinatePattern = /(?:^|\b)(\d{1,2}\.\d{3,6})\s*°?\s*([NS])\s*(?:,|;|\s+)\s*(\d{2,3}\.\d{3,6})\s*°?\s*([EW])\b/i
const decimalCoordinatePairPattern = /(?:coordinates?|position|located|offshore|at sea|waters? (?:off|of|near))\s*(?:of|at|:)?\s*(\d{1,2}\.\d{3,6})\s*[,;/]\s*(\d{2,3}\.\d{3,6})\b/i

function maritimeCoordinatesFromText(text) {
  const cardinal = text.match(preciseCoordinatePattern)
  if (cardinal) {
    const latMagnitude = Number(cardinal[1])
    const lngMagnitude = Number(cardinal[3])
    const lat = cardinal[2].toUpperCase() === 'S' ? -latMagnitude : latMagnitude
    const lng = cardinal[4].toUpperCase() === 'W' ? -lngMagnitude : lngMagnitude
    return inPhilippineBounds(lat, lng) ? { lat, lng } : null
  }
  const decimal = text.match(decimalCoordinatePairPattern)
  if (!decimal) return null
  const lat = Number(decimal[1]), lng = Number(decimal[2])
  return inPhilippineBounds(lat, lng) ? { lat, lng } : null
}

/**
 * Maritime headlines often name the nearest island or province, not the
 * incident point. Never turn that administrative place into a land marker.
 * An offshore marker is allowed only when the feed itself supplies a precise
 * Philippine coordinate and describes a marine/offshore context.
 */
export function marineIncidentLocation(title, summary = '') {
  const text = stripFeedMarkup(`${String(title ?? '')}. ${String(summary ?? '')}`, 1_200)
  // A ship/boat/ferry incident is maritime even when the publisher only says
  // "near Romblon". That named place is still not safe to use as a land pin.
  const isMaritimeIncident = maritimeVehiclePattern.test(text)
  if (!isMaritimeIncident) return { isMaritimeIncident: false, coordinate: null }
  const coordinate = maritimeWaterPattern.test(text) ? maritimeCoordinatesFromText(text) : null
  return {
    isMaritimeIncident: true,
    coordinate: coordinate
      ? {
          ...coordinate,
          locationName: 'Reported offshore position',
          locationQuery: 'publisher-reported offshore coordinate',
          locationPrecision: 'offshore',
          locationConfidence: 0.92,
        }
      : null,
  }
}

export function incidentExpiry(publishedAt, category, resolved = false) {
  const timestamp = Date.parse(String(publishedAt ?? ''))
  if (!Number.isFinite(timestamp) || !NEWS_CATEGORY_VALUES.includes(category)) return null
  const duration = resolved
    ? 6 * 60 * 60 * 1000
    : ['fire', 'road-incident', 'killing', 'robbery-theft'].includes(category)
      ? 24 * 60 * 60 * 1000
      : 48 * 60 * 60 * 1000
  return new Date(timestamp + duration).toISOString()
}

function normalizedWords(value) {
  const stop = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is', 'near',
    'of', 'on', 'or', 'ph', 'philippines', 'the', 'to', 'with', 'after', 'amid', 'over',
  ])
  return new Set(
    String(value ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(word => word.length > 2 && !stop.has(word)),
  )
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0
  let overlap = 0
  for (const word of left) if (right.has(word)) overlap += 1
  return overlap / (left.size + right.size - overlap)
}

function locationMatch(left, right) {
  const a = String(left ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const b = String(right ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)))
}

export function clusterNewsIncidents(articles) {
  const values = Array.isArray(articles) ? articles : []
  const words = values.map(article => normalizedWords(`${article.title ?? ''} ${article.summary ?? ''}`))
  const matches = (left, right) => {
    const a = values[left], b = values[right]
    if (!a?.id || !b?.id || a.source_id === b.source_id || a.category !== b.category) return false
    const timeA = Date.parse(String(a.published_at ?? '')), timeB = Date.parse(String(b.published_at ?? ''))
    const maximumGap = ['fire', 'road-incident', 'killing', 'robbery-theft'].includes(a.category)
      ? 4 * 60 * 60 * 1000
      : 8 * 60 * 60 * 1000
    if (!Number.isFinite(timeA) || !Number.isFinite(timeB) || Math.abs(timeA - timeB) > maximumGap) return false

    const locationA = String(a.location_name ?? '').trim()
    const locationB = String(b.location_name ?? '').trim()
    // Similar generic headlines do not establish incident identity. Require
    // independent and compatible spatial evidence from both publishers.
    if (!locationA || !locationB || !locationMatch(locationA, locationB)) return false
    const similarity = jaccard(words[left], words[right])
    return similarity >= 0.35
  }

  // Complete-link grouping prevents transitive chains from turning three
  // merely related stories into false multi-outlet corroboration.
  const groups = []
  values.forEach((_, index) => {
    const group = groups.find(candidate => candidate.every(other => matches(index, other)))
    if (group) group.push(index)
    else groups.push([index])
  })

  const result = new Map()
  for (const group of groups) {
    const groupedArticles = group.map(index => values[index])
    const sources = [...new Set(groupedArticles.map(article => String(article.source_id ?? '')).filter(Boolean))].sort()
    const verificationStatus = sources.length >= 2 ? 'multiple-outlets-reported' : 'news-reported'
    for (const article of groupedArticles) {
      if (article?.id) result.set(String(article.id), { verificationStatus, corroboratingSources: sources })
    }
  }
  return result
}

export function inPhilippineBounds(lat, lng) {
  return Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= PH_BOUNDS.minLat
    && lat <= PH_BOUNDS.maxLat
    && lng >= PH_BOUNDS.minLng
    && lng <= PH_BOUNDS.maxLng
}

export function scorePhotonLocation(candidate, feature) {
  const coordinates = feature?.geometry?.coordinates
  const properties = feature?.properties ?? {}
  const lng = Number(coordinates?.[0]), lat = Number(coordinates?.[1])
  if (!inPhilippineBounds(lat, lng)) return null
  const countryCode = String(properties.countrycode ?? '').toUpperCase()
  if (countryCode && countryCode !== 'PH') return null

  const displayName = [
    properties.name,
    properties.street,
    properties.district,
    properties.city,
    properties.county,
    properties.state,
    properties.country,
  ].filter(Boolean).map(String).join(', ')
  const queryWords = normalizedWords(candidate)
  const resultWords = normalizedWords(displayName)
  const overlap = jaccard(queryWords, resultWords)
  if (overlap < 0.3) return null

  const regionOnly = /\b(?:luzon|visayas|mindanao|metro manila|national capital region|philippines)\b/i.test(candidate)
  const queryNamesStreet = /\b(?:avenue|ave\.?|boulevard|blvd\.?|drive|expressway|highway|hwy\.?|lane|road|rd\.?|street|st\.?)\b/i.test(candidate)
  const hasStreet = queryNamesStreet && Boolean(properties.street || properties.housenumber)
  const hasLocality = Boolean(properties.city || properties.town || properties.village || properties.district || properties.county)
  const precision = hasStreet ? 'street' : regionOnly ? 'region' : hasLocality ? 'locality' : 'region'
  const confidence = precision === 'street'
    ? Math.min(0.95, 0.85 + overlap * 0.1)
    : precision === 'locality'
      ? Math.min(0.84, 0.7 + overlap * 0.14)
      : Math.min(0.65, 0.5 + overlap * 0.15)
  return {
    lat,
    lng,
    locationName: stripFeedMarkup(displayName || candidate, MAX_LOCATION_LENGTH),
    locationQuery: stripFeedMarkup(candidate, MAX_LOCATION_LENGTH),
    locationPrecision: precision,
    locationConfidence: Math.round(confidence * 100) / 100,
  }
}
