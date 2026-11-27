import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  LocaleSwitcher,
  NavUser,
  Separator,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  type Theme,
  useTheme,
} from '@kit/ui'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Moon, Sun, SunMoon } from 'lucide-react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { canManageMembers, isPlatformActor, signOutAndClearSession, useMe } from '../lib/auth'
import { localeLabels } from '../lib/i18n'
import { useLocale } from '../lib/locale'
import { useOrgContext } from '../lib/org-context'
import { ImpersonationBanner } from './impersonation-banner'
import { ShellCommandPalette } from './shell-command-palette'
import { ShellBrand, ShellNav, ShellUserExtras } from './shell-nav'
import { pageTitle } from './shell-title'

export type ShellMode = 'admin' | 'app'

/**
 * Active state for sidebar links.
 * Shell homes (`/admin`, `/app`) are prefixes of every nested route — exact match only,
 * otherwise "Accueil" stays lit on orgs/notes/etc.
 */
/** dashboard-01 inspired shell: brand header, grouped nav, user footer, site header. */
function ShellChrome({ mode, children }: { mode: ShellMode; children: ReactNode }) {
  const { m, locale, setLocale, locales } = useLocale()
  const { theme, setTheme } = useTheme()
  const me = useMe()
  const { activeOrgId } = useOrgContext()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const showMembers =
    mode === 'app' && Boolean(activeOrgId) && canManageMembers(me.data, activeOrgId ?? '')

  const logout = async () => {
    try {
      await signOutAndClearSession(qc)
      toast.message(m.logout)
      await navigate({ to: '/login' })
    } catch {
      toast.error(m.error, { description: m.errUnauthorized })
    }
  }

  const cycleTheme = () => {
    const order: Theme[] = ['light', 'dark', 'system']
    const i = order.indexOf(theme)
    setTheme(order[(i + 1) % order.length]!)
  }
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : SunMoon
  const themeLabel =
    theme === 'dark' ? m.themeDark : theme === 'light' ? m.themeLight : m.themeSystem

  const displayName = me.data?.name ?? me.data?.email ?? me.data?.subject ?? m.account
  const initials = displayName.slice(0, 2).toUpperCase()
  const title = pageTitle(pathname, m)
  const homeTo = mode === 'admin' ? '/admin' : '/app'
  const subtitle = mode === 'admin' ? m.shellAdminSubtitle : m.shellAppSubtitle
  const platform = isPlatformActor(me.data)

  return (
    <>
      {/* sidebar-07: collapses to icons */}
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <ShellBrand mode={mode} homeTo={homeTo} subtitle={subtitle} appTitle={m.appTitle} />
        </SidebarHeader>

        <SidebarContent>
          <ShellNav
            mode={mode}
            m={m}
            showMembers={showMembers}
            activeOrgId={activeOrgId}
            delegated={Boolean(me.data?.impersonation)}
          />
        </SidebarContent>

        <SidebarFooter>
          <NavUser
            user={{
              name: displayName,
              email: me.data?.email ?? me.data?.subject ?? '',
              fallback: initials,
            }}
            logoutLabel={m.logout}
            onLogout={() => void logout()}
          >
            <ShellUserExtras
              mode={mode}
              platform={platform}
              m={m}
              navigate={navigate}
              delegated={Boolean(me.data?.impersonation)}
            />
            <DropdownMenuSeparator />
            <LocaleSwitcher
              variant="menu"
              locales={locales}
              value={locale}
              onChange={setLocale}
              labels={localeLabels}
            />
            <DropdownMenuItem onClick={cycleTheme}>
              <ThemeIcon />
              {themeLabel}
            </DropdownMenuItem>
          </NavUser>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        {me.data?.impersonation ? <ImpersonationBanner /> : null}
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex w-full items-center gap-2 px-4 lg:gap-3 lg:px-6">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-vertical:h-4 data-vertical:self-auto"
            />
            <h1 className="text-sm font-medium">{title}</h1>
            <ShellCommandPalette
              key={JSON.stringify([mode, activeOrgId, me.data?.impersonation?.id])}
              mode={mode}
              delegated={Boolean(me.data?.impersonation)}
              onNavigate={(href) => {
                const destination = new URL(href, window.location.origin)
                const revealsNote =
                  destination.pathname === '/app/notes' && destination.searchParams.has('noteId')
                // Let the selected row position itself instead of resetting scroll after commit.
                void navigate({ href, resetScroll: !revealsNote })
              }}
            />
          </div>
        </header>
        <div className="flex flex-1 flex-col">
          <main className="@container/main flex flex-1 flex-col gap-2">
            <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 px-4 lg:px-6">{children}</div>
          </main>
        </div>
      </SidebarInset>
    </>
  )
}

export function AppShell({ children, mode = 'app' }: { children: ReactNode; mode?: ShellMode }) {
  return (
    <SidebarProvider>
      <ShellChrome mode={mode}>{children}</ShellChrome>
    </SidebarProvider>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="mb-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}
