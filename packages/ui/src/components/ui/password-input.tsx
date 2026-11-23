import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { type ComponentProps, useState } from 'react'
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

  const Icon = visible ? EyeOffIcon : EyeIcon

  return (
    <InputGroup>
      <InputGroupInput
        {...props}
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
