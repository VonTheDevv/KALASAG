(() => {
  try {
    const stored = localStorage.getItem('kalasag_theme')
    const systemDark = matchMedia('(prefers-color-scheme: dark)').matches
    const resolved = stored === 'dark' || stored === 'light' ? stored : systemDark ? 'dark' : 'light'
    document.documentElement.dataset.theme = resolved
    document.documentElement.style.colorScheme = resolved
    const themeColor = document.querySelector('meta[name="theme-color"]')
    if (themeColor) themeColor.content = resolved === 'dark' ? '#0F141B' : '#F6F8FB'
  } catch {
    // ThemeProvider and CSS media queries provide the fallback.
  }
})()
