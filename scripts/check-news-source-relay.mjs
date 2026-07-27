import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import {
  createNewsSourceRelayServer,
  fetchNewsSourcePayload,
} from '../server/news-source-relay.mjs'
import { NEWS_SOURCES } from '../supabase/functions/_shared/news-normalization.js'

const relaySecret = 'test-secret-that-is-longer-than-thirty-two-characters'
const gma = NEWS_SOURCES.find(source => source.id === 'gma-news')
const inquirer = NEWS_SOURCES.find(source => source.id === 'inquirer-newsinfo')
const manilaStandard = NEWS_SOURCES.find(source => source.id === 'manila-standard')
assert.ok(gma)
assert.ok(inquirer)
assert.ok(manilaStandard)

const relaySource = fs.readFileSync(new URL('../server/news-source-relay.mjs', import.meta.url), 'utf8')
const relayService = fs.readFileSync(
  new URL('../deploy/systemd/kalasag-news-source-relay.service', import.meta.url),
  'utf8',
)
const deploymentGuide = fs.readFileSync(new URL('../instruction.md', import.meta.url), 'utf8')
assert.match(relaySource, /import https from 'node:https'/)
assert.match(relaySource, /fetchImpl = nativeHttpsFetch/)
assert.doesNotMatch(relaySource, /fetchImpl = fetch[,\n]/)
assert.match(relaySource, /missingRequiredSources/)
assert.match(relayService, /^User=kalasag-news-relay$/m)
assert.match(relayService, /^ProtectProc=invisible$/m)
assert.match(relayService, /\/news-relay\/current\/server\/news-source-relay\.mjs/)
assert.match(deploymentGuide, /NEWS_INGEST_SECRET=<SEPARATE_64_HEX_CHARACTER_RANDOM_SECRET>/)
assert.match(deploymentGuide, /kalasag_news_ingest_secret/)
assert.match(deploymentGuide, /inquirer-newsinfo manila-standard/)

let upstreamCalls = 0
const rss = `<?xml version="1.0"?><rss><channel><item><title>Fire hits homes in Manila</title></item></channel></rss>`
const fetchImpl = async url => {
  upstreamCalls += 1
  assert.equal(new URL(url).hostname, 'data.gmanetwork.com')
  return new Response(rss, {
    status: 200,
    headers: { 'content-type': 'application/xml', etag: '"publisher-etag"' },
  })
}

const requiredGma = {
  ...gma,
  fetchStrategy: 'relay-first',
  pollIntervalSeconds: 0,
}
const server = createNewsSourceRelayServer({
  relaySecret,
  fetchImpl,
  sources: [requiredGma],
  freshMs: 60_000,
  prewarm: false,
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert.equal(typeof address, 'object')
const endpoint = `http://127.0.0.1:${address.port}/internal/news-source?source=gma-news`

try {
  const notReady = await fetch(`http://127.0.0.1:${address.port}/healthz`)
  assert.equal(notReady.status, 503)
  assert.deepEqual((await notReady.json()).missingRequiredSources, ['gma-news'])

  const unauthorized = await fetch(endpoint)
  assert.equal(unauthorized.status, 401)

  const unknown = await fetch(endpoint.replace('gma-news', 'unknown'), {
    headers: { 'x-kalasag-news-relay-secret': relaySecret },
  })
  assert.equal(unknown.status, 404)

  const first = await fetch(endpoint, {
    headers: { 'x-kalasag-news-relay-secret': relaySecret },
  })
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('content-type'), 'application/xml')
  assert.equal(await first.text(), rss)
  const etag = first.headers.get('etag')
  assert.ok(etag)

  const ready = await fetch(`http://127.0.0.1:${address.port}/healthz`)
  assert.equal(ready.status, 200)
  assert.equal((await ready.json()).ok, true)

  const cached = await fetch(endpoint, {
    headers: {
      'x-kalasag-news-relay-secret': relaySecret,
      'if-none-match': etag,
    },
  })
  assert.equal(cached.status, 304)
  assert.equal(upstreamCalls, 1)

  await assert.rejects(
    fetchNewsSourcePayload(gma, null, async () => new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.example/feed.xml' },
    })),
    /redirect was rejected/,
  )
} finally {
  server.close()
  await once(server, 'close')
}

const inquirerPayload = await fetchNewsSourcePayload(inquirer, null, async () => new Response(rss, {
  status: 200,
  headers: { 'content-type': 'application/rss+xml; charset=UTF-8' },
}))
assert.equal(inquirerPayload.body.toString('utf8'), rss)

const wpJson = JSON.stringify([{ id: 1, link: 'https://manilastandard.net/news/example' }])
const manilaPayload = await fetchNewsSourcePayload(manilaStandard, null, async () => new Response(wpJson, {
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
}))
assert.equal(manilaPayload.body.toString('utf8'), wpJson)

const previous = {
  body: Buffer.from(rss),
  contentType: 'application/xml',
  etag: '"cached-body"',
  upstreamUrl: gma.feedUrl,
  upstreamEtag: '"upstream-etag"',
  upstreamLastModified: 'Wed, 22 Jul 2026 12:00:00 GMT',
  checkedAt: 1,
}
const notModified = await fetchNewsSourcePayload(gma, previous, async () => new Response(null, {
  status: 304,
  headers: { etag: '"upstream-etag"' },
}))
assert.equal(notModified.body, previous.body)
assert.ok(notModified.checkedAt > previous.checkedAt)

await assert.rejects(
  fetchNewsSourcePayload(gma, null, async () => new Response('<html>blocked</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })),
  /invalid content type/,
)

await assert.rejects(
  fetchNewsSourcePayload(gma, null, async () => new Response(rss, {
    status: 200,
    headers: {
      'content-type': 'application/xml',
      'content-length': String(2 * 1024 * 1024 + 1),
    },
  })),
  /exceeded the size limit/,
)

let staleCalls = 0
const staleServer = createNewsSourceRelayServer({
  relaySecret,
  sources: [requiredGma],
  freshMs: 1,
  staleMs: 60_000,
  prewarm: false,
  fetchImpl: async () => {
    staleCalls += 1
    if (staleCalls > 1) throw new Error('temporary publisher failure')
    return new Response(rss, { status: 200, headers: { 'content-type': 'application/xml' } })
  },
})
staleServer.listen(0, '127.0.0.1')
await once(staleServer, 'listening')
const staleAddress = staleServer.address()
assert.equal(typeof staleAddress, 'object')
const staleEndpoint = `http://127.0.0.1:${staleAddress.port}/internal/news-source?source=gma-news`
try {
  const first = await fetch(staleEndpoint, {
    headers: { 'x-kalasag-news-relay-secret': relaySecret },
  })
  assert.equal(first.status, 200)
  await first.arrayBuffer()
  await new Promise(resolve => setTimeout(resolve, 10))

  const stale = await fetch(staleEndpoint, {
    headers: { 'x-kalasag-news-relay-secret': relaySecret },
  })
  assert.equal(stale.status, 200)
  assert.equal(stale.headers.get('x-kalasag-cache-state'), 'stale')
  await stale.arrayBuffer()
  const callsAfterFailure = staleCalls

  const backedOff = await fetch(staleEndpoint, {
    headers: { 'x-kalasag-news-relay-secret': relaySecret },
  })
  assert.equal(backedOff.status, 200)
  assert.equal(backedOff.headers.get('x-kalasag-cache-state'), 'stale')
  assert.equal(staleCalls, callsAfterFailure)

  const degraded = await fetch(`http://127.0.0.1:${staleAddress.port}/healthz`)
  assert.equal(degraded.status, 200)
  assert.deepEqual((await degraded.json()).degradedSources, ['gma-news'])
} finally {
  staleServer.close()
  await once(staleServer, 'close')
}

let prewarmCalls = 0
const prewarmServer = createNewsSourceRelayServer({
  relaySecret,
  sources: [requiredGma],
  fetchImpl: async () => {
    prewarmCalls += 1
    return new Response(rss, { status: 200, headers: { 'content-type': 'application/xml' } })
  },
})
prewarmServer.listen(0, '127.0.0.1')
await once(prewarmServer, 'listening')
const prewarmAddress = prewarmServer.address()
assert.equal(typeof prewarmAddress, 'object')
try {
  let health
  for (let attempt = 0; attempt < 20; attempt += 1) {
    health = await fetch(`http://127.0.0.1:${prewarmAddress.port}/healthz`)
    if (health.status === 200) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(health?.status, 200)
  assert.equal(prewarmCalls, 1)
} finally {
  prewarmServer.close()
  await once(prewarmServer, 'close')
}

console.log('Authenticated news source relay controls passed.')
