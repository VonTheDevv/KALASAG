import { useEffect, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { CheckCircle2, Eye, EyeOff, XCircle } from 'lucide-react'

interface AnimatedInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  icon?: ReactNode
  isValid?: boolean | null
  errorMessage?: string
  showValidation?: boolean
  containerClassName?: string
}

export default function AnimatedInput({
  label,
  icon,
  isValid,
  errorMessage,
  showValidation = false,
  containerClassName = '',
  type,
  className = '',
  id,
  ...inputProps
}: AnimatedInputProps) {
  const generatedId = useId()
  const inputId = id || generatedId
  const errorId = `${inputId}-error`
  const [focused, setFocused] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const isPassword = type === 'password'
  const actualType = isPassword && showPassword ? 'text' : type

  useEffect(() => {
    if (inputProps.value && String(inputProps.value).length > 0) setDirty(true)
  }, [inputProps.value])

  const showValid = showValidation && dirty && isValid === true
  const showInvalid = showValidation && dirty && isValid === false

  const stateClasses = showValid
    ? 'border-[var(--success)] bg-[var(--success-soft)]'
    : showInvalid
      ? 'border-[var(--danger)] bg-[var(--danger-soft)]'
      : focused
        ? 'border-[var(--action)] bg-[var(--panel)] ring-2 ring-[var(--focus-ring)]'
        : 'border-[var(--border)] bg-[var(--surface-alt)] hover:border-[var(--border-strong)]'

  return (
    <div className={containerClassName}>
      <label htmlFor={inputId} className="mb-1.5 block text-xs font-semibold text-[var(--text-soft)]">
        {label}
      </label>
      <div className="relative">
        {icon && (
          <span className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 transition-colors duration-150 ${focused ? 'text-[var(--action)]' : 'text-[var(--muted)]'}`}>
            {icon}
          </span>
        )}
        <input
          {...inputProps}
          id={inputId}
          type={actualType}
          aria-invalid={showInvalid || undefined}
          aria-describedby={showInvalid && errorMessage ? errorId : inputProps['aria-describedby']}
          onFocus={(event) => {
            setFocused(true)
            inputProps.onFocus?.(event)
          }}
          onBlur={(event) => {
            setFocused(false)
            setDirty(true)
            inputProps.onBlur?.(event)
          }}
          className={`w-full rounded-lg border py-2.5 text-sm font-medium text-[var(--text)] outline-none transition-[background-color,border-color,box-shadow] duration-150 placeholder:text-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-60 ${icon ? 'pl-10' : 'pl-3.5'} ${isPassword || showValid || showInvalid ? 'pr-12' : 'pr-3.5'} ${stateClasses} ${className}`}
        />
        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {showValid && <CheckCircle2 size={17} className="text-[var(--success)]" aria-label="Valid" />}
          {showInvalid && <XCircle size={17} className="text-[var(--danger)]" aria-label="Invalid" />}
          {isPassword && inputProps.value && String(inputProps.value).length > 0 && (
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              className="rounded p-1 text-[var(--muted)] transition-colors duration-150 hover:bg-[var(--panel-elevated)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          )}
        </div>
      </div>
      {showInvalid && errorMessage && (
        <p id={errorId} className="mt-1.5 text-xs font-medium text-[var(--danger)]">
          {errorMessage}
        </p>
      )}
    </div>
  )
}
