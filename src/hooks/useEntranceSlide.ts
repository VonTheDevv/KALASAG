import { useEffect, useRef } from 'react'
import { animate as anime } from 'animejs'

/**
 * Animates the target element sliding up from below on mount.
 * Returns a ref to attach to the element you want animated.
 *
 * @param delay  Delay in ms before animation starts (default 60)
 * @param distance  How far below to start in px (default 16)
 * @param duration  Animation duration in ms (default 320)
 */
export function useEntranceSlide(delay = 60, distance = 16, duration = 320) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.style.opacity = '1'
      el.style.transform = 'none'
      return
    }

    // Set initial state
    el.style.opacity = '0'
    el.style.transform = `translateY(${distance}px)`

    anime(el, {
      translateY: [distance, 0],
      opacity: [0, 1],
      duration,
      delay,
      easing: 'easeOutCubic',
    })
  }, [delay, distance, duration])

  return ref
}
