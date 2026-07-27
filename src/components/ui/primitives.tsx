import {
  type CSSProperties,
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { cx } from '../../lib/cx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-[var(--action)] text-[var(--action-text)] hover:bg-[var(--action-hover)]',
  secondary:
    'border-[var(--border)] bg-[var(--panel)] text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--panel-elevated)]',
  ghost: 'border-transparent bg-transparent text-[var(--text-soft)] hover:bg-[var(--action-soft)] hover:text-[var(--text)]',
  danger: 'border-transparent bg-[var(--danger)] text-[var(--surface)] hover:brightness-95',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  busy?: boolean
  leadingIcon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', busy = false, leadingIcon, className, children, disabled, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'ui-control inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-md)] border px-4 py-2 text-sm font-semibold sm:min-h-10',
        buttonVariants[variant],
        className,
      )}
      {...props}
    >
      {busy ? <span className="ui-spinner" aria-hidden="true" /> : leadingIcon}
      {children}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
}

const iconSizes = {
  sm: 'h-10 w-10 sm:h-9 sm:w-9',
  md: 'h-11 w-11 sm:h-10 sm:w-10',
  lg: 'h-11 w-11',
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'ui-control inline-grid shrink-0 place-items-center rounded-[var(--radius-md)] border',
        iconSizes[size],
        buttonVariants[variant],
        className,
      )}
      {...props}
    />
  )
})

export type PanelTone = 'default' | 'warning' | 'danger' | 'success' | 'info'

const panelTones: Record<PanelTone, string> = {
  default: 'elevated-panel bg-[var(--panel)]',
  warning: 'border-[var(--warning-border)] bg-[var(--warning-soft)]',
  danger: 'border-[var(--danger-border)] bg-[var(--danger-soft)]',
  success: 'border-[var(--success-border)] bg-[var(--success-soft)]',
  info: 'border-[var(--info-border)] bg-[var(--info-soft)]',
}

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  tone?: PanelTone
}

export function Panel({ tone = 'default', className, ...props }: PanelProps) {
  return (
    <div
      className={cx(
        `rounded-[var(--radius-lg)] text-[var(--text)] shadow-[var(--shadow-card)] ${tone === 'default' ? 'elevated-panel' : 'border'}`,
        panelTones[tone],
        className,
      )}
      {...props}
    />
  )
}

export const Card = Panel

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx(
        'ui-control min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--panel)] px-3.5 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--muted)] hover:border-[var(--border-strong)] focus:border-[var(--action)]',
        className,
      )}
      {...props}
    />
  )
})

export type SelectTone = 'default' | 'danger' | 'teal'
export type SelectVariant = 'default' | 'compact' | 'minimal'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps {
  value?: string
  defaultValue?: string
  options: readonly SelectOption[]
  onValueChange?: (value: string) => void
  placeholder?: string
  id?: string
  name?: string
  required?: boolean
  disabled?: boolean
  className?: string
  contentClassName?: string
  tone?: SelectTone
  variant?: SelectVariant
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}

const selectVariants: Record<SelectVariant, string> = {
  default: 'min-h-11 w-full px-3.5 py-2.5 text-sm',
  compact: 'min-h-10 w-full px-3 py-2 text-sm',
  minimal: 'min-h-8 max-w-full px-1.5 py-1 text-sm font-bold',
}

/**
 * A fully styled, keyboard-accessible select. Radix owns focus, type-ahead,
 * collision handling and the hidden form value; local classes own the KALASAG
 * theme and motion.
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    value,
    defaultValue,
    options,
    onValueChange,
    placeholder = 'Select an option',
    id,
    name,
    required,
    disabled,
    className,
    contentClassName,
    tone = 'default',
    variant = 'default',
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
  },
  ref,
) {
  return (
    <SelectPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      name={name}
      required={required}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        ref={ref}
        id={id}
        data-tone={tone}
        data-variant={variant}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        className={cx(
          'custom-select-trigger ui-control inline-flex items-center justify-between gap-3 rounded-[var(--radius-md)] text-left text-[var(--text)] disabled:cursor-not-allowed',
          selectVariants[variant],
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="custom-select-chevron shrink-0 text-[var(--muted)]">
          <ChevronDown size={16} strokeWidth={2.25} aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={7}
          collisionPadding={12}
          data-tone={tone}
          className={cx(
            'custom-select-content z-[6000] overflow-hidden rounded-[var(--radius-lg)] bg-[var(--panel)] text-[var(--text)] shadow-[var(--shadow-lg)]',
            contentClassName,
          )}
        >
          <SelectPrimitive.ScrollUpButton className="custom-select-scroll-button">
            <ChevronUp size={16} aria-hidden="true" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="custom-select-viewport p-1.5">
            {options.map((option, index) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                style={{ '--select-item-index': index } as CSSProperties}
                className="custom-select-item relative flex min-h-10 select-none items-center rounded-[var(--radius-md)] py-2 pl-3 pr-10 text-sm outline-none"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-3 inline-grid place-items-center text-[var(--select-accent)]">
                  <Check size={16} strokeWidth={2.5} aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="custom-select-scroll-button">
            <ChevronDown size={16} aria-hidden="true" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
})

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
const badgeTones: Record<BadgeTone, string> = {
  neutral: 'border-[var(--border)] bg-[var(--panel-elevated)] text-[var(--text-soft)]',
  info: 'border-[var(--info)]/25 bg-[var(--info-soft)] text-[var(--info)]',
  success: 'border-[var(--success)]/25 bg-[var(--success-soft)] text-[var(--success)]',
  warning: 'border-[var(--warning)]/25 bg-[var(--warning-soft)] text-[var(--warning)]',
  danger: 'border-[var(--danger)]/25 bg-[var(--danger-soft)] text-[var(--danger)]',
}

export function Badge({ tone = 'neutral', className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold leading-none',
        badgeTones[tone],
        className,
      )}
      {...props}
    />
  )
}

export interface NoticeProps extends HTMLAttributes<HTMLDivElement> {
  tone?: Exclude<PanelTone, 'default'>
  title?: string
}

export function Toast({ tone = 'info', title, className, children, ...props }: NoticeProps) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx('rounded-[var(--radius-md)] border px-4 py-3 text-sm', panelTones[tone], className)}
      {...props}
    >
      {title && <p className="mb-1 font-semibold text-[var(--text)]">{title}</p>}
      <div className="text-[var(--text-soft)]">{children}</div>
    </div>
  )
}

export function ErrorBanner(props: Omit<NoticeProps, 'tone'>) {
  return <Toast tone="danger" {...props} />
}

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'line' | 'block' | 'circle'
}

const skeletonVariants = {
  line: 'h-3 rounded-full',
  block: 'rounded-[var(--radius-md)]',
  circle: 'aspect-square rounded-full',
}

export function Skeleton({ variant = 'block', className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cx('skeleton', skeletonVariants[variant], className)}
      {...props}
    />
  )
}
