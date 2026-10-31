import type { ComponentProps } from 'react'

const buttonVariants = {
  plain: '',
  primary: 'bg-accent text-white',
  outline: 'border border-line text-ink',
  danger: 'bg-danger text-white',
  dangerSoft: 'bg-danger/12 text-danger',
}

export function Button({
  className = '',
  variant = 'plain',
  ...props
}: ComponentProps<'button'> & { variant?: keyof typeof buttonVariants }) {
  return (
    <button className={`${buttonVariants[variant]} ${className}`} {...props} />
  )
}

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={`rounded-lg px-3 py-2 text-sm border border-line bg-panel text-ink ${className}`}
      {...props}
    />
  )
}

export function Select({ className = '', ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={`rounded-lg px-3 py-2 text-sm border border-line bg-paper text-ink ${className}`}
      {...props}
    />
  )
}

export function Panel({ className = '', ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={`rounded-xl border border-line bg-panel ${className}`}
      {...props}
    />
  )
}

export function TabButton({
  active,
  className = '',
  ...props
}: ComponentProps<'button'> & { active: boolean }) {
  return (
    <Button
      className={`px-3 py-1.5 rounded-md text-sm font-medium ${active ? 'bg-accent-soft text-accent' : 'bg-transparent text-muted'} ${className}`}
      {...props}
    />
  )
}

export function StatusBadge({
  status,
  label,
}: {
  status: string
  label?: string
}) {
  const tone = ['success', 'active'].includes(status)
    ? 'bg-success/12 text-success'
    : ['failure', 'fail', 'not_configured'].includes(status)
      ? 'bg-danger/12 text-danger'
      : ['idle', 'none', 'no_project'].includes(status)
        ? 'bg-warning/12 text-warning'
        : 'bg-line text-muted'
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${tone}`}
    >
      {label ?? status}
    </span>
  )
}
