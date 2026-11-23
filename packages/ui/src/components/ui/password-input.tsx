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

      const root = input.getRootNode()
      const handleReset = (event: Event) => {
        if (event.target === input.form) setVisible(false)
      }
      root.addEventListener('reset', handleReset, true)
      return () => {
        root.removeEventListener('reset', handleReset, true)
        cleanupRef?.()
      }
    },
    [ref],
  )

  const Icon = visible ? EyeOffIcon : EyeIcon

  return (
    <InputGroup>
      <InputGroupInput
        {...props}
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
