import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { assertNoBaseUiContractErrors, captureRuntimeErrors } from '../../test/capture-errors'
import { Button } from './button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from './dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './sheet'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

describe('Dialog / Sheet / Tooltip (Base UI contracts)', () => {
  it('bare DialogPopup keeps only the caller classes inside a classed portal', () => {
    const errors = captureRuntimeErrors(() => {
      render(
        <Dialog open onOpenChange={() => {}}>
          <DialogPortal className="product-layer">
            <DialogPopup aria-label="Search" className="product-sheet">
              <input aria-label="Query" />
            </DialogPopup>
          </DialogPortal>
        </Dialog>,
      )
    })
    assertNoBaseUiContractErrors(errors)
    const popup = screen.getByRole('dialog', { name: 'Search' })
    expect(popup).toHaveAttribute('class', 'product-sheet')
    expect(popup.closest('.product-layer')).not.toBeNull()
  })

  it('controlled Dialog mounts without contract errors', () => {
    const errors = captureRuntimeErrors(() => {
      render(
        <Dialog open onOpenChange={() => {}}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Title</DialogTitle>
              <DialogDescription>Desc</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button">Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>,
      )
    })
    assertNoBaseUiContractErrors(errors)
    expect(screen.getByText('Title')).toBeInTheDocument()
  })

  it('Sheet open mounts cleanly', () => {
    const errors = captureRuntimeErrors(() => {
      render(
        <Sheet open onOpenChange={() => {}}>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>Sheet title</SheetTitle>
              <SheetDescription>Sheet desc</SheetDescription>
            </SheetHeader>
            <SheetFooter>
              <Button type="button">Done</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>,
      )
    })
    assertNoBaseUiContractErrors(errors)
    expect(screen.getByText('Sheet title')).toBeInTheDocument()
  })

  it('Tooltip with provider mounts cleanly', () => {
    const errors = captureRuntimeErrors(() => {
      render(
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger render={<Button type="button">Tip</Button>} />
            <TooltipContent>Help text</TooltipContent>
          </Tooltip>
        </TooltipProvider>,
      )
    })
    assertNoBaseUiContractErrors(errors)
    expect(screen.getByRole('button', { name: 'Tip' })).toBeInTheDocument()
  })
})
