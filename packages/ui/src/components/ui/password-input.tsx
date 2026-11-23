import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { type ComponentProps, useState } from 'react'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './input-group'

export type PasswordInputProps = Omit<ComponentProps<typeof InputGroupInput>, 'type'> & {
  showPasswordLabel: string
  hidePasswordLabel: string
}

export function PasswordInput({
  showPasswordLabel,
  hidePasswordLabel,
  disabled,
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false)
  const Icon = visible ? EyeOffIcon : EyeIcon

  return (
    <InputGroup>
      <InputGroupInput {...props} type={visible ? 'text' : 'password'} disabled={disabled} />
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
