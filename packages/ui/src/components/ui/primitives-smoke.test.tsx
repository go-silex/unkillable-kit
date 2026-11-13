import { render, screen } from '@testing-library/react'
import { fr } from 'react-day-picker/locale'
import { describe, expect, it } from 'vitest'
import { Alert, AlertDescription, AlertTitle } from './alert'
import { Badge } from './badge'
import { Calendar } from './calendar'
import { Checkbox } from './checkbox'
import { Combobox, ComboboxChips, ComboboxChipsInput } from './combobox'
import { DatePicker } from './date-picker'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './empty'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select'
import { Spinner } from './spinner'
import { Switch } from './switch'
import { Toggle } from './toggle'
import { ToggleGroup, ToggleGroupItem } from './toggle-group'

describe('new shadcn primitives smoke', () => {
  it('renders Empty + Spinner + Badge + Alert', () => {
    render(
      <div>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Spinner />
            </EmptyMedia>
            <EmptyTitle>Nothing here</EmptyTitle>
            <EmptyDescription>Try another filter</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <Badge>hook</Badge>
        <Alert>
          <AlertTitle>Heads up</AlertTitle>
          <AlertDescription>Details</AlertDescription>
        </Alert>
      </div>,
    )
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
    expect(screen.getByText('hook')).toBeInTheDocument()
    expect(screen.getByText('Heads up')).toBeInTheDocument()
    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
  })

  it('renders Switch + Checkbox + ToggleGroup', () => {
    render(
      <div>
        <Switch checked={false} onCheckedChange={() => {}} aria-label="flag" />
        <Checkbox checked={false} onCheckedChange={() => {}} aria-label="box" />
        <Toggle aria-label="solo">T</Toggle>
        <ToggleGroup value={['a']} onValueChange={() => {}} aria-label="group">
          <ToggleGroupItem value="a">A</ToggleGroupItem>
          <ToggleGroupItem value="b">B</ToggleGroupItem>
        </ToggleGroup>
      </div>,
    )
    expect(screen.getByLabelText('flag')).toBeInTheDocument()
    expect(screen.getByLabelText('box')).toBeInTheDocument()
    expect(screen.getByText('A')).toBeInTheDocument()
  })

  it('renders Select closed trigger', () => {
    const items = [
      { label: 'Pick', value: null as string | null },
      { label: 'One', value: 'one' },
    ]
    render(
      <Select items={items} defaultValue={null}>
        <SelectTrigger aria-label="pick">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={String(item.value)} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>,
    )
    expect(screen.getByLabelText('pick')).toBeInTheDocument()
  })

  it('preserves calendar day identity and locale on parent rerender', () => {
    const month = new Date(2025, 0, 15)
    const view = render(<Calendar mode="single" month={month} locale={fr} />)
    const day = view.container.querySelector<HTMLButtonElement>('[data-day="15/01/2025"]')
    expect(day).not.toBeNull()
    day?.focus()
    view.rerender(<Calendar mode="single" month={month} locale={fr} />)
    expect(view.container.querySelector('[data-day="15/01/2025"]')).toBe(day)
    expect(day).toHaveFocus()
  })

  it('renders Calendar + DatePicker + Popover + Combobox chips shell', () => {
    render(
      <div>
        <Calendar mode="single" />
        <DatePicker placeholder="Due date" />
        <Popover>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>Popover body</PopoverContent>
        </Popover>
        <Combobox multiple>
          <ComboboxChips>
            <ComboboxChipsInput placeholder="Assignees" aria-label="assignees" />
          </ComboboxChips>
        </Combobox>
      </div>,
    )
    expect(screen.getByText('Due date')).toBeInTheDocument()
    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(screen.getByLabelText('assignees')).toBeInTheDocument()
  })
})
