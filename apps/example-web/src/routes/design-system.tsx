import { Badge } from '@kit/ui'
import { Palette } from 'lucide-react'
import { PageHeader } from '../components/app-shell'
import { DataTanstack } from '../components/design-system/data-tanstack'
import { FeedbackOverlays } from '../components/design-system/feedback-overlays'
import { Foundations } from '../components/design-system/foundations'
import { Templates } from '../components/design-system/templates'
import { useLocale } from '../lib/locale'

export function DesignSystemPage() {
  const { m } = useLocale()

  const toc = [
    { id: 'foundations', label: m.dsFoundations },
    { id: 'buttons', label: 'Button' },
    { id: 'forms', label: m.dsForms },
    { id: 'tabs', label: 'Tabs' },
    { id: 'feedback', label: m.dsFeedback },
    { id: 'overlays', label: m.dsOverlays },
    { id: 'data', label: m.dsData },
    { id: 'tanstack', label: m.dsTanstack },
    { id: 'templates', label: m.dsTemplates },
  ]

  return (
    <div className="space-y-10">
      <PageHeader
        title={m.designSystem}
        description={m.designSystemDesc}
        actions={
          <Badge variant="secondary" className="gap-1">
            <Palette className="size-3" />
            admin
          </Badge>
        }
      />

      <div className="grid gap-8 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="sticky top-20 hidden h-fit space-y-1 lg:block">
          <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {m.dsOnThisPage}
          </p>
          {toc.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="block rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="min-w-0 space-y-12">
          <Foundations />
          <FeedbackOverlays />
          <DataTanstack />
          <Templates />

          <p className="text-center text-xs text-muted-foreground">{m.designSystemFooter}</p>
        </div>
      </div>
    </div>
  )
}
