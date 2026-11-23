import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { type ComponentProps, useCallback, useState } from 'react'
import { cn } from '../../lib/utils'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './input-group'

export type PasswordInputProps = Omit<ComponentProps<typeof InputGroupInput>, 'type'> & {
  showPasswordLabel: string
  hidePasswordLabel: string
}

export function PasswordInput({
  showPasswordLabel,
  hidePasswordLabel,
  disabled,
  className,
  value,
  onChange,
  form,
  ref,
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false)
  const empty = value === ''
  const [wasEmpty, setWasEmpty] = useState(empty)
  // Handle controlled clears before rendering the input, without replacing its DOM node.
  if (empty !== wasEmpty) {
    setWasEmpty(empty)
    if (empty) setVisible(false)
  }

  const inputRef = useCallback(
    (input: HTMLInputElement | null) => {
      if (!input) return
      let cleanupRef: (() => void) | undefined
      if (typeof ref === 'function') {
        const cleanup = ref(input)
        cleanupRef = typeof cleanup === 'function' ? cleanup : () => ref(null)
      } else if (ref) {
        ref.current = input
        cleanupRef = () => {
          ref.current = null
        }
      }

      const owner = input.form
      const handleReset = () => setVisible(false)
      owner?.addEventListener('reset', handleReset)
      return () => {
        owner?.removeEventListener('reset', handleReset)
        cleanupRef?.()
      }
    },
    // Rebind when the input is explicitly associated with a different form.
    [ref, form],
  )

  const Icon = visible ? EyeOffIcon : EyeIcon

  return (
    <InputGroup>
      <InputGroupInput
        {...props}
        form={form}
        ref={inputRef}
        type={visible ? 'text' : 'password'}
        disabled={disabled}
        spellCheck={false}
        className={cn(className, '[&::-ms-reveal]:hidden')}
        value={value}
        onChange={(event) => {
          if (value === undefined && event.currentTarget.value === '') setVisible(false)
          onChange?.(event)
        }}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          type="button"
          size="icon-xs"
          disabled={disabled}
          aria-label={visible ? hidePasswordLabel : showPasswordLabel}
          aria-pressed={visible}
          onClick={() => setVisible((previous) => !previous)}
        >
          <Icon aria-hidden="true" />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
