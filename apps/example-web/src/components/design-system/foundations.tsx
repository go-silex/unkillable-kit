import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@kit/ui'
import { ChevronRight, Plus, Settings } from 'lucide-react'
import { useLocale } from '../../lib/locale'
import { DemoBox, Section } from './section'

const TOKEN_SWATCHES = [
  { name: 'background', className: 'bg-background border' },
  { name: 'foreground', className: 'bg-foreground' },
  { name: 'card', className: 'bg-card border' },
  { name: 'primary', className: 'bg-primary' },
  { name: 'secondary', className: 'bg-secondary border' },
  { name: 'muted', className: 'bg-muted border' },
  { name: 'accent', className: 'bg-accent border' },
  { name: 'destructive', className: 'bg-destructive' },
  { name: 'border', className: 'bg-border' },
  { name: 'ring', className: 'bg-ring' },
  { name: 'sidebar', className: 'bg-sidebar border' },
  { name: 'sidebar-primary', className: 'bg-sidebar-primary' },
] as const

export function Foundations() {
  const { m } = useLocale()

  return (
    <>
      {/* Foundations */}
      <Section id="foundations" title={m.dsFoundations} description={m.dsFoundationsDesc}>
        <DemoBox title="Color tokens">
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {TOKEN_SWATCHES.map((t) => (
              <div key={t.name} className="space-y-1.5">
                <div className={`h-12 w-full rounded-lg ${t.className}`} />
                <p className="truncate font-mono text-[10px] text-muted-foreground">{t.name}</p>
              </div>
            ))}
          </div>
        </DemoBox>
        <div className="grid gap-4 md:grid-cols-2">
          <DemoBox title="Typography">
            <div className="space-y-2">
              <p className="text-2xl font-semibold tracking-tight">Heading 2xl / semibold</p>
              <p className="text-lg font-semibold">Heading lg</p>
              <p className="text-base">Body base — Geist Variable</p>
              <p className="text-sm text-muted-foreground">Muted sm — secondary copy</p>
              <p className="font-mono text-xs">Mono xs — sk_… / requestId</p>
            </div>
          </DemoBox>
          <DemoBox title="Radius & surface">
            <div className="flex flex-wrap items-end gap-3">
              <div className="size-12 rounded-sm border bg-muted" title="sm" />
              <div className="size-12 rounded-md border bg-muted" title="md" />
              <div className="size-12 rounded-lg border bg-muted" title="lg" />
              <div className="size-12 rounded-xl border bg-muted" title="xl" />
              <div className="size-12 rounded-full border bg-muted" title="full" />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Tokens shadcn base-nova · light/dark via classe{' '}
              <code className="rounded bg-muted px-1">.dark</code>
            </p>
          </DemoBox>
        </div>
      </Section>

      {/* Buttons */}
      <Section id="buttons" title="Button" description="Variants + sizes (@base-ui/react/button)">
        <DemoBox title="Variants">
          <div className="flex flex-wrap gap-2">
            <Button>Default</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
          </div>
        </DemoBox>
        <DemoBox title="Sizes">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs">XS</Button>
            <Button size="sm">SM</Button>
            <Button size="default">Default</Button>
            <Button size="lg">LG</Button>
            <Button size="icon">
              <Settings />
            </Button>
            <Button size="icon-sm" variant="outline">
              <Plus />
            </Button>
          </div>
        </DemoBox>
        <DemoBox title="With icons">
          <div className="flex flex-wrap gap-2">
            <Button>
              <Plus data-icon="inline-start" />
              Create
            </Button>
            <Button variant="outline">
              Continue
              <ChevronRight data-icon="inline-end" />
            </Button>
            <Button variant="secondary" disabled>
              Disabled
            </Button>
          </div>
        </DemoBox>
      </Section>

      {/* Forms */}
      <Section id="forms" title={m.dsForms} description="Input, Textarea, Label, Field">
        <DemoBox>
          <FieldGroup className="max-w-md">
            <Field>
              <FieldLabel htmlFor="ds-email">Email</FieldLabel>
              <Input id="ds-email" type="email" placeholder="you@kit.local" />
              <FieldDescription>Used for session demo login.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="ds-notes">Notes</FieldLabel>
              <Textarea id="ds-notes" placeholder="Optional body…" rows={3} />
            </Field>
            <Field data-invalid>
              <FieldLabel htmlFor="ds-err">With error</FieldLabel>
              <Input id="ds-err" aria-invalid defaultValue="bad" />
              <FieldError>VALIDATION_ERROR · field required</FieldError>
            </Field>
            <div className="flex items-center gap-2">
              <Label htmlFor="ds-alone">Standalone label</Label>
              <Input id="ds-alone" className="max-w-xs" />
            </div>
          </FieldGroup>
        </DemoBox>
      </Section>

      <Section id="tabs" title={m.dsTabs} description={m.dsTabsDesc}>
        <DemoBox>
          <Tabs defaultValue="first">
            <TabsList aria-label={m.dsTabs}>
              <TabsTrigger value="first">{m.dsTabsFirst}</TabsTrigger>
              <TabsTrigger value="second">{m.dsTabsSecond}</TabsTrigger>
            </TabsList>
            <TabsContent value="first">{m.dsTabsFirstPanel}</TabsContent>
            <TabsContent value="second">{m.dsTabsSecondPanel}</TabsContent>
          </Tabs>
        </DemoBox>
      </Section>
    </>
  )
}
