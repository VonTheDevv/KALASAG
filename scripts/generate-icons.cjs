const fs = require('fs')
const path = require('path')

const dir = path.join(__dirname, 'public', 'icons')
fs.mkdirSync(dir, { recursive: true })

const makeIcon = (size) => {
  const r = Math.round(size * 0.2)
  const cx = size / 2
  const strokeW = Math.round(size * 0.042)
  const lineW = Math.round(size * 0.052)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" rx="${r}" fill="#0a0a0a"/>`,
    `<path d="M${cx} ${size*0.1}L${size*0.85} ${size*0.28}L${size*0.85} ${size*0.54}`,
    `C${size*0.85} ${size*0.73} ${size*0.69} ${size*0.9} ${cx} ${size*0.97}`,
    `C${size*0.31} ${size*0.9} ${size*0.15} ${size*0.73} ${size*0.15} ${size*0.54}`,
    `L${size*0.15} ${size*0.28}Z" fill="none" stroke="#ff6b00" stroke-width="${strokeW}"/>`,
    `<line x1="${cx}" y1="${size*0.36}" x2="${cx}" y2="${size*0.68}" stroke="#ff6b00" stroke-width="${lineW}" stroke-linecap="round"/>`,
    `<line x1="${size*0.34}" y1="${cx+size*0.02}" x2="${size*0.66}" y2="${cx+size*0.02}" stroke="#ff6b00" stroke-width="${lineW}" stroke-linecap="round"/>`,
    `</svg>`,
  ].join('')
}

fs.writeFileSync(path.join(dir, 'icon-192.png'), makeIcon(192))
fs.writeFileSync(path.join(dir, 'icon-512.png'), makeIcon(512))
// Also write as SVG with .png extension won't work for real PWA, but for dev server it's fine
// Write actual SVG files for reference
fs.writeFileSync(path.join(dir, 'icon-192.svg'), makeIcon(192))
fs.writeFileSync(path.join(dir, 'icon-512.svg'), makeIcon(512))

console.log('Icons written to', dir)
