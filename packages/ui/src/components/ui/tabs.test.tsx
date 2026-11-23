import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { expect, it, vi } from 'vitest'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../index'

function ExampleTabs(props: ComponentProps<typeof Tabs>) {
  return (
    <Tabs {...props}>
      <TabsList aria-label="Example tabs">
        <TabsTrigger value="first">First</TabsTrigger>
        <TabsTrigger value="second">Second</TabsTrigger>
      </TabsList>
      <TabsContent value="first">First panel</TabsContent>
      <TabsContent value="second">Second panel</TabsContent>
    </Tabs>
  )
}

function expectSelectedPanel(name: string, text: string) {
  const tab = screen.getByRole('tab', { name, selected: true })
  const panel = screen.getByRole('tabpanel', { name })

  expect(panel).toHaveTextContent(text)
  expect(panel.id).not.toBe('')
  expect(tab.id).not.toBe('')
  expect(tab).toHaveAttribute('aria-controls', panel.id)
  expect(panel).toHaveAttribute('aria-labelledby', tab.id)

  return tab
}

it('moves focus and selection to the next uncontrolled tab with ArrowRight', async () => {
  const user = userEvent.setup()
  render(<ExampleTabs defaultValue="first" />)

  const first = expectSelectedPanel('First', 'First panel')
  await user.tab()
  expect(first).toHaveFocus()

  await user.keyboard('{ArrowRight}')

  expect(expectSelectedPanel('Second', 'Second panel')).toHaveFocus()
  expect(first).toHaveAttribute('aria-selected', 'false')
  await waitFor(() => {
    expect(screen.queryByRole('tabpanel', { name: 'First' })).not.toBeInTheDocument()
  })
})

it('requests a controlled selection change without switching panels until value changes', async () => {
  const user = userEvent.setup()
  const onValueChange = vi.fn()
  const { rerender } = render(<ExampleTabs value="second" onValueChange={onValueChange} />)

  expectSelectedPanel('Second', 'Second panel')
  await user.tab()
  await user.keyboard('{ArrowLeft}')

  expect(screen.getByRole('tab', { name: 'First', selected: false })).toHaveFocus()
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith('first', expect.anything())
  expectSelectedPanel('Second', 'Second panel')

  rerender(<ExampleTabs value="first" onValueChange={onValueChange} />)

  expectSelectedPanel('First', 'First panel')
  await waitFor(() => {
    expect(screen.queryByRole('tabpanel', { name: 'Second' })).not.toBeInTheDocument()
  })
})

it('preserves ARIA links when a caller spreads IDs onto mounted panels', () => {
  const firstPanelProps = { id: 'caller-first', keepMounted: true }
  const secondPanelProps = { id: 'caller-second', keepMounted: true }
  render(
    <Tabs defaultValue="first">
      <TabsList aria-label="Example tabs">
        <TabsTrigger value="first">First</TabsTrigger>
        <TabsTrigger value="second">Second</TabsTrigger>
      </TabsList>
      <TabsContent value="first" {...firstPanelProps}>
        First panel
      </TabsContent>
      <TabsContent value="second" {...secondPanelProps}>
        Second panel
      </TabsContent>
    </Tabs>,
  )

  for (const [name, selected] of [
    ['First', true],
    ['Second', false],
  ] as const) {
    const tab = screen.getByRole('tab', { name, selected })
    const panel = screen.getByText(`${name} panel`)
    expect(document.getElementById(tab.getAttribute('aria-controls') ?? '')).toBe(panel)
    expect(panel).toHaveAttribute('aria-labelledby', tab.id)
  }
})
