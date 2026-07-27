import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { viteLiveData } from './scripts/vite-live-data.js'
import { viteAisRelay } from './scripts/vite-ais-relay.js'

function aisRelayCspSource(value: string | undefined) {
  if (!value) return ''
  try {
    const relay = new URL(value)
    if (relay.protocol === 'https:' || relay.protocol === 'http:') relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:'
    return relay.protocol === 'wss:' || relay.protocol === 'ws:' ? ` ${relay.origin}` : ''
  } catch {
    return ''
  }
}

function httpsCspSource(value: string | undefined) {
  if (!value) return ''
  try {
    const endpoint = new URL(value)
    return endpoint.protocol === 'https:' ? ` ${endpoint.origin}` : ''
  } catch {
    return ''
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const relayCspSource = aisRelayCspSource(env.VITE_AIS_RELAY_URL)
  const liveDataCspSource = httpsCspSource(env.VITE_LIVE_DATA_URL)
  const addressSearchCspSource = httpsCspSource(env.VITE_ADDRESS_SEARCH_URL || 'https://kalasagph.tech/api/address-search')
  return {
  plugins: [
    {
      name: 'kalasag-ais-relay-csp',
      transformIndexHtml(html) {
        return html
          .replace('__KALASAG_AIS_RELAY_CSP__', relayCspSource)
          .replace('__KALASAG_LIVE_DATA_CSP__', liveDataCspSource)
          .replace('__KALASAG_ADDRESS_SEARCH_CSP__', addressSearchCspSource)
      },
    },
    react(),
    tailwindcss(),
    basicSsl(),
    viteLiveData(env.TOMTOM_API_KEY, env.GFW_API_TOKEN, env.KALASAG_DEV_ALLOWED_ORIGINS),
    viteAisRelay(env.AISSTREAM_API_KEY, env.KALASAG_DEV_ALLOWED_ORIGINS),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'kalasag-logo.png', 'icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'KALASAG - Disaster Readiness',
        short_name: 'KALASAG',
        description: 'Real-time disaster and emergency dashboard for the Philippines.',
        theme_color: '#0F141B',
        background_color: '#0F141B',
        display: 'standalone',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,bin}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // 4 MiB to accommodate satellite.png (2.32 MB)
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ]
      }
    })
  ],
  server: {
    // Localhost is the safe default. Deliberate LAN testing can still use
    // `npm run dev -- --host 0.0.0.0` without making every launch public.
    host: '127.0.0.1',
    allowedHosts: ['localhost', ...String(env.KALASAG_DEV_ALLOWED_HOSTS || '').split(',').map(value => value.trim()).filter(Boolean)],
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), payment=(), usb=()',
    },
    proxy: {
      '/api-adsb': {
        target: 'https://api.airplanes.live',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-adsb/, '')
      },
      '/api-adsb-one': {
        target: 'https://api.adsb.one',
        changeOrigin: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://adsb.one/'
        },
        rewrite: (path) => path.replace(/^\/api-adsb-one/, '')
      },
      '/api-gdacs': {
        target: 'https://www.gdacs.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-gdacs/, '')
      },
      '/api-jtwc': {
        target: 'https://www.metoc.navy.mil',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-jtwc/, '')
      }
    }
  }
}})
