import { type MouseEvent, type ReactNode, useEffect, useRef } from 'react'
import { ArrowLeft, Moon, Sun } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { IconButton, Panel } from './ui/primitives'
import { animate, splitText, stagger } from 'animejs'
import AuthBrandIntro from './AuthBrandIntro'

interface AuthShellProps {
  backTo: string
  backLabel: string
  eyebrow?: string
  title: string
  description?: string
  icon?: ReactNode
  children: ReactNode
  footer?: ReactNode
  contentRef?: React.Ref<HTMLDivElement>
  animateTitle?: boolean
  isAnimatingOut?: boolean
  titleMotionKey?: string | number
  titleAccessory?: ReactNode
  onBackClick?: (event: MouseEvent<HTMLAnchorElement>) => void
  showBrandIntro?: boolean
}

export default function AuthShell({
  backTo,
  backLabel,
  eyebrow,
  title,
  description,
  icon,
  children,
  footer,
  contentRef,
  animateTitle = false,
  isAnimatingOut = false,
  titleMotionKey = title,
  titleAccessory,
  onBackClick,
  showBrandIntro = false,
}: AuthShellProps) {
  const { resolvedTheme, toggleTheme } = useTheme()
  const themeLabel = `Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`
  const titleRef = useRef<HTMLHeadingElement>(null)
  const linesRef = useRef<HTMLElement[]>([])

  // Intro: slide lines in on mount
  useEffect(() => {
    if (!animateTitle || !titleRef.current) return

    const el = titleRef.current
    let splitter: ReturnType<typeof splitText> | null = null

    const frame = requestAnimationFrame(() => {
      splitter = splitText(el, {
        lines: { wrap: 'clip' },
      }).addEffect(({ lines }) => {
        linesRef.current = lines as HTMLElement[]
        return animate(lines, {
          y: ['100%', '0%'],
          duration: 460,
          ease: 'out(4)',
          delay: stagger(80),
        })
      })
    })

    return () => {
      cancelAnimationFrame(frame)
      linesRef.current = []
      splitter?.revert()
    }
  }, [animateTitle, titleMotionKey])

  // Outro: slide lines out when isAnimatingOut becomes true
  useEffect(() => {
    if (!isAnimatingOut || linesRef.current.length === 0) return

    animate(linesRef.current, {
      y: '-100%',
      duration: 300,
      ease: 'in(2)',
      delay: stagger(60),
    })
  }, [isAnimatingOut, titleMotionKey])

  return (
    <main className="safe-area-auth h-full overflow-y-auto bg-[var(--surface)] px-4 pb-8 sm:pb-12">
      <div className="mx-auto flex min-h-full w-full max-w-md items-center">
        <div ref={contentRef} className="w-full">
          <div className="mb-6 flex items-center justify-between gap-3">
            <Link
              to={backTo}
              onClick={onBackClick}
              className="ui-control inline-flex items-center gap-2 rounded-[var(--radius-md)] px-1 py-1 text-sm font-medium text-[var(--text-soft)] hover:text-[var(--text)]"
            >
              <ArrowLeft size={16} aria-hidden="true" />
              {backLabel}
            </Link>
            <IconButton size="sm" variant="secondary" onClick={toggleTheme} aria-label={themeLabel} title={themeLabel}>
              {resolvedTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </IconButton>
          </div>

          <Panel className="overflow-hidden shadow-[var(--shadow-md)]">
            <div className="h-1 bg-[var(--action)]" />
            <div className="p-6 sm:p-8">
              <header className="mb-7">
                {showBrandIntro && <AuthBrandIntro />}
                {icon && (
                  <div className="mb-4 grid h-10 w-10 place-items-center rounded-[var(--radius-md)] bg-[var(--action-soft)] text-[var(--action)]">
                    {icon}
                  </div>
                )}
                {eyebrow && (
                  <p className="font-data mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">{eyebrow}</p>
                )}
                <div className="flex items-center gap-3">
                  <h1
                    key={titleMotionKey}
                    ref={titleRef}
                    className="auth-title text-2xl font-extrabold tracking-tight text-[var(--text)]"
                  >
                    {title}
                  </h1>
                  {titleAccessory}
                </div>
                {description && (
                  <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-soft)]">{description}</p>
                )}
              </header>
              {children}
            </div>
          </Panel>

          {footer && <div className="mt-6 text-center text-sm text-[var(--muted)]">{footer}</div>}
        </div>
      </div>
    </main>
  )
}
