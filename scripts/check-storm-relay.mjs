import assert from 'node:assert/strict'
import {
  buildStormPayload,
  distanceToParKm,
  gdacsCyclones,
  gdacsTrack,
} from '../server/storm-relay.mjs'

const inside = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [125, 15] },
  properties: {
    eventtype: 'TC',
    eventid: 123,
    name: 'TEST-26',
    alertlevel: 'Orange',
    windspeed: 50,
  },
}

const feed = {
  features: [
    inside,
    { ...inside, geometry: { type: 'Point', coordinates: [150, 15] }, properties: { ...inside.properties, eventid: 456 } },
    { ...inside, geometry: { type: 'Polygon', coordinates: [] }, properties: { ...inside.properties, eventid: 789 } },
    { ...inside, properties: { ...inside.properties, eventtype: 'FL', eventid: 999 } },
  ],
}

assert.equal(distanceToParKm(15, 125), 0)
assert.ok(distanceToParKm(15, 150) > 10)

const cyclones = gdacsCyclones(feed)
assert.equal(cyclones.length, 1)
assert.equal(cyclones[0].id, '123')
assert.equal(cyclones[0].windKph, 93)

const geometry = {
  features: [
    {
      geometry: { type: 'LineString', coordinates: [[124, 14], [125, 15]] },
      properties: { forecast: false, polygonlabel: 'Tropical storm' },
    },
    {
      geometry: { type: 'LineString', coordinates: [[125, 15], [126, 16]] },
      properties: { forecast: true, polygonlabel: 'Typhoon' },
    },
  ],
}

assert.deepEqual(gdacsTrack(geometry, false, [125, 15]).track, [[14, 124], [15, 125]])
assert.deepEqual(gdacsTrack(geometry, true, [125, 15]).track, [[15, 125], [16, 126]])

const payload = await buildStormPayload(feed, async id => id === '123' ? geometry : null, '2026-07-15T00:00:00.000Z')
assert.equal(payload.data.length, 1)
assert.deepEqual(payload.data[0].observedTrack, [[14, 124], [15, 125]])
assert.deepEqual(payload.data[0].forecastTrack, [[15, 125], [16, 126]])
assert.equal(payload.sources[0].status, 'live')

console.log('Live cyclone relay filtering and track logic passed.')
