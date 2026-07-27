/**
 * Synthesizes an NDRRMC-style emergency siren using the Web Audio API.
 * No audio files required — runs 100% client-side offline.
 */

let audioCtx: AudioContext | null = null
let alarmNodes: { osc: OscillatorNode; gain: GainNode }[] = []
let rafId: number | null = null

function getCtx(): AudioContext {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext()
  }
  return audioCtx
}

export function startAlarmSiren() {
  const ctx = getCtx()
  if (ctx.state === 'suspended') ctx.resume()

  stopAlarmSiren() // clear any existing

  // Two-tone wailing siren (like civil defense)
  const frequencies = [
    { base: 880, mod: 220 },
    { base: 660, mod: 165 },
  ]

  alarmNodes = frequencies.map(({ base, mod }) => {
    const osc      = ctx.createOscillator()
    const lfo      = ctx.createOscillator()
    const lfoGain  = ctx.createGain()
    const gain     = ctx.createGain()

    osc.type      = 'sawtooth'
    osc.frequency.setValueAtTime(base, ctx.currentTime)

    lfo.type      = 'sine'
    lfo.frequency.setValueAtTime(2.5, ctx.currentTime)   // 2.5 Hz sweep
    lfoGain.gain.setValueAtTime(mod, ctx.currentTime)

    lfo.connect(lfoGain)
    lfoGain.connect(osc.frequency)

    gain.gain.setValueAtTime(0.18, ctx.currentTime)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start()
    lfo.start()

    return { osc, gain }
  })
}

export function stopAlarmSiren() {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
  alarmNodes.forEach(({ osc, gain }) => {
    try {
      gain.gain.setValueAtTime(gain.gain.value, audioCtx!.currentTime)
      gain.gain.linearRampToValueAtTime(0, audioCtx!.currentTime + 0.3)
      osc.stop(audioCtx!.currentTime + 0.31)
    } catch {
      // already stopped
    }
  })
  alarmNodes = []
}
