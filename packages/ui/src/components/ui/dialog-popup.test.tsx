import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Dialog, DialogOverlay, DialogPopup, DialogPortal } from '../../index'

// A product's own dialog markup: its veil is the backdrop and holds the unstyled popup.
function ProductSheet() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPortal className="product-portal">
          <DialogOverlay render={(props) => <div {...props} className="product-veil" />}>
            <DialogPopup aria-label="Search" className="product-sheet">
              <input aria-label="Query" />
            </DialogPopup>
          </DialogOverlay>
        </DialogPortal>
      </Dialog>
    </>
  )
}

async function openSheet() {
  const user = userEvent.setup()
  render(<ProductSheet />)
  await user.click(screen.getByRole('button', { name: 'Open' }))
  const popup = await screen.findByRole('dialog', { name: 'Search' })
  return { user, popup }
}

describe('DialogPopup composed with product markup', () => {
  it('keeps only the product classes and takes focus', async () => {
    const { popup } = await openSheet()
    expect(popup).toHaveAttribute('class', 'product-sheet')
    expect(popup.parentElement).toHaveAttribute('class', 'product-veil')
    expect(popup).toContainElement(document.activeElement as HTMLElement)
  })

  it('closes on Escape and returns focus to the opener', async () => {
    const { user } = await openSheet()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus()
  })

  it('closes on a veil click but not on a click inside the popup', async () => {
    const { user, popup } = await openSheet()
    await user.click(screen.getByRole('textbox', { name: 'Query' }))
    expect(popup).toBeInTheDocument()
    await user.click(popup.parentElement as HTMLElement)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
