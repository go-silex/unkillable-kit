import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Sidebar, SidebarProvider, SidebarRail, SidebarTrigger } from './sidebar'

const frenchToggleLabel = 'Basculer la barre latérale'

function renderSidebarControls(toggleLabel?: string) {
  vi.stubGlobal('innerWidth', 1024)
  render(
    <SidebarProvider>
      <SidebarTrigger toggleLabel={toggleLabel} />
      <Sidebar>
        <SidebarRail toggleLabel={toggleLabel} />
      </Sidebar>
    </SidebarProvider>,
  )
}

describe('Sidebar labels', () => {
  it('defaults both desktop controls to English', () => {
    renderSidebarControls()

    expect(screen.getAllByRole('button', { name: 'Toggle Sidebar' })).toHaveLength(2)
    expect(screen.getByTitle('Toggle Sidebar')).toHaveAccessibleName('Toggle Sidebar')
  })

  it('localizes both desktop controls and the rail title', () => {
    renderSidebarControls(frenchToggleLabel)

    expect(screen.getAllByRole('button', { name: frenchToggleLabel })).toHaveLength(2)
    expect(screen.getByTitle(frenchToggleLabel)).toHaveAccessibleName(frenchToggleLabel)
    expect(screen.queryByRole('button', { name: 'Toggle Sidebar' })).not.toBeInTheDocument()
    expect(screen.queryByTitle('Toggle Sidebar')).not.toBeInTheDocument()
    expect(screen.queryByText('Toggle Sidebar')).not.toBeInTheDocument()
  })

  it('lets native rail attributes override toggleLabel', () => {
    render(
      <SidebarProvider>
        <SidebarRail
          toggleLabel={frenchToggleLabel}
          aria-label="Ouvrir le menu"
          title="Menu latéral"
        />
      </SidebarProvider>,
    )

    expect(screen.getByRole('button', { name: 'Ouvrir le menu' })).toHaveAttribute(
      'title',
      'Menu latéral',
    )
  })

  it('defaults the mobile dialog name and description to English', () => {
    vi.stubGlobal('innerWidth', 390)
    render(
      <SidebarProvider>
        <SidebarTrigger />
        <Sidebar />
      </SidebarProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Toggle Sidebar' }))

    expect(screen.getByRole('dialog', { name: 'Sidebar' })).toHaveAccessibleDescription(
      'Displays the mobile sidebar.',
    )
  })

  it('localizes the mobile dialog name and description without leaving English text', () => {
    vi.stubGlobal('innerWidth', 390)
    render(
      <SidebarProvider>
        <SidebarTrigger toggleLabel={frenchToggleLabel} />
        <Sidebar
          mobileTitle="Barre latérale"
          mobileDescription="Affiche la barre latérale mobile."
        />
      </SidebarProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: frenchToggleLabel }))

    expect(screen.getByRole('dialog', { name: 'Barre latérale' })).toHaveAccessibleDescription(
      'Affiche la barre latérale mobile.',
    )
    expect(screen.queryByText('Sidebar')).not.toBeInTheDocument()
    expect(screen.queryByText('Displays the mobile sidebar.')).not.toBeInTheDocument()
    expect(screen.queryByText('Toggle Sidebar')).not.toBeInTheDocument()
    expect(screen.queryByText('Close')).not.toBeInTheDocument()
  })
})
