/**
 * Browser smoke for design-system tabs and overlays (and admin gate).
 * Fails on pageerror / console Base UI contract messages.
 *
 * Prerequisites:
 *   1. bun run db:migrate && bun run db:seed  (once)
 *   2. apps/example-api: bun run dev  → :8787
 *   3. apps/example-web: bun run dev  → :5173 (host binds 127.0.0.1 + localhost)
 *   4. Chromium: Playwright-managed (default) or CHROME_PATH / system Chrome
 *
 * Usage:
 *   bun apps/example-web/scripts/e2e-design-system.mjs
 *   # or: bun run --filter @kit/example-web test:e2e:design-system
 *
 * Env:
 *   E2E_BASE_URL (default http://127.0.0.1:5173)
 *   E2E_API_URL  (default http://127.0.0.1:8787)
 *   CHROME_PATH  optional absolute browser binary
 *   E2E_DEMO_EMAIL / E2E_DEMO_PASSWORD  (dev/test defaults only)
 */
import { accessSync, constants as fsConstants } from 'node:fs'
import { chromium } from 'playwright-core'

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173'
const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:8787'
const DEMO_EMAIL = process.env.E2E_DEMO_EMAIL ?? 'demo@kit.local'
const DEMO_PASSWORD = process.env.E2E_DEMO_PASSWORD ?? 'demo-password-change-me'

const pageErrors = []
const consoleErrors = []

function fileExists(path) {
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    try {
      accessSync(path, fsConstants.R_OK)
      return true
    } catch {
      return false
    }
  }
}

/** Prefer Playwright Chromium; allow CHROME_PATH / system Chrome override. */
function resolveBrowserExecutable() {
  if (process.env.CHROME_PATH) {
    if (!fileExists(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH not found or not readable: ${process.env.CHROME_PATH}`)
    }
    return process.env.CHROME_PATH
  }
  try {
    const pw = chromium.executablePath()
    if (pw && fileExists(pw)) return pw
  } catch {
    // Playwright browsers not installed
  }
  for (const candidate of [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]) {
    if (fileExists(candidate)) return candidate
  }
  throw new Error(
    'No Chromium found. Install Playwright browsers (`bunx playwright install chromium`) or set CHROME_PATH.',
  )
}

async function pollHttpOk(url, { timeoutMs = 30_000, intervalMs = 500, label = url } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastErr = 'not started'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000),
      })
      // any HTTP response means the process is up (health may be 200; SPA may be 200)
      if (res.status > 0 && res.status < 500) return
      lastErr = `HTTP ${res.status}`
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Health poll timeout (${label}): ${lastErr}`)
}

function assertClean(phase) {
  const all = [...pageErrors, ...consoleErrors]
  const bad = all.filter((m) =>
    /Base UI|MenuGroupContext|must be used within|DialogRootContext|TypeError|ReferenceError/i.test(
      m,
    ),
  )
  if (bad.length) {
    console.error(`E2E FAIL (${phase}):`, bad)
    process.exitCode = 1
    throw new Error(bad.join('\n'))
  }
}

const executablePath = resolveBrowserExecutable()
if (process.env.E2E_DEBUG) console.error('[e2e] browser', executablePath)

// Health before browser (fail fast if stack not up)
if (process.env.E2E_DEBUG) console.error('[e2e] poll API')
await pollHttpOk(`${API}/health`, { label: 'API /health' })
if (process.env.E2E_DEBUG) console.error('[e2e] poll web')
await pollHttpOk(BASE, { label: 'web BASE' })
if (process.env.E2E_DEBUG) console.error('[e2e] launch')

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
})
if (process.env.E2E_DEBUG) console.error('[e2e] new page')
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.setDefaultTimeout(15_000)
page.on('pageerror', (err) => pageErrors.push(String(err)))
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})

try {
  // Login as platform admin via Better Auth (ADR-0002) from page origin (cookie on 5173 proxy)
  if (process.env.E2E_DEBUG) console.error('[e2e] goto login')
  await page.goto(`${BASE}/login`, { waitUntil: 'commit', timeout: 20_000 })
  if (process.env.E2E_DEBUG) console.error('[e2e] wait email field')
  await page
    .locator('input[type="email"], input[name="email"]')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })

  if (process.env.E2E_DEBUG) console.error('[e2e] sign-in evaluate')
  await page.evaluate(
    async ({ email, password }) => {
      localStorage.setItem('kit.theme', 'light')
      document.documentElement.classList.remove('dark')
      const res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!res.ok) throw new Error(`login ${res.status}`)
      const me = await fetch('/api/me', { credentials: 'include' })
      if (!me.ok) throw new Error(`me ${me.status}`)
    },
    { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  )
  assertClean('login')

  if (process.env.E2E_DEBUG) console.error('[e2e] goto design-system')
  await page.goto(`${BASE}/admin/design-system#overlays`, { waitUntil: 'commit', timeout: 20_000 })
  // App-specific ready: overlays section controls
  await page
    .getByRole('button', { name: 'Dropdown' })
    .waitFor({ state: 'visible', timeout: 15_000 })
  assertClean('design-system load')

  const tabs = page.getByRole('tablist', { name: 'Tabs' })
  const firstTab = tabs.getByRole('tab').first()
  const secondTab = tabs.getByRole('tab').nth(1)
  await firstTab.waitFor({ state: 'visible' })
  await firstTab.press('ArrowRight')
  await secondTab.and(page.locator(':focus[aria-selected="true"]')).waitFor({ state: 'visible' })
  await page
    .getByRole('tabpanel', { name: await secondTab.textContent(), exact: true })
    .waitFor({ state: 'visible' })
  assertClean('tabs keyboard navigation')

  /**
   * Base UI overlays can leave Playwright's real click stuck on "performing click action".
   * dispatchEvent + wait for result is still event-driven (no sleep correctness).
   */
  async function openOverlay(buttonName, resultLocator) {
    const btn = page.getByRole('button', { name: buttonName })
    await btn.waitFor({ state: 'visible', timeout: 10_000 })
    await btn.dispatchEvent('click')
    await resultLocator.waitFor({ state: 'visible', timeout: 10_000 })
  }

  // Open dropdown in overlays section
  if (process.env.E2E_DEBUG) console.error('[e2e] dropdown')
  const dropdownLabel = page
    .locator('[data-slot="dropdown-menu-label"]')
    .filter({ hasText: 'Actions' })
  await openOverlay('Dropdown', dropdownLabel)
  assertClean('dropdown open')

  // Close menu (toggle trigger — avoid Escape which can crash headless Base UI on some hosts)
  if (process.env.E2E_DEBUG) console.error('[e2e] close dropdown + dialog')
  await page.getByRole('button', { name: 'Dropdown' }).dispatchEvent('click')
  await dropdownLabel.waitFor({ state: 'hidden', timeout: 10_000 })
  const dialogTitle = page
    .locator('[data-slot="dialog-title"]')
    .filter({ hasText: 'Dialog reference' })
  await openOverlay('Open Dialog', dialogTitle)
  assertClean('dialog open')
  // Close dialog via Escape only if still open; fallback click backdrop if present
  if (await dialogTitle.isVisible().catch(() => false)) {
    await page
      .locator('[data-slot="dialog-close"], button:has-text("Close")')
      .first()
      .dispatchEvent('click')
      .catch(async () => {
        await page.keyboard.press('Escape')
      })
    await dialogTitle.waitFor({ state: 'hidden', timeout: 10_000 })
  }

  // Open sheet
  if (process.env.E2E_DEBUG) console.error('[e2e] sheet')
  const sheetTitle = page
    .locator('[data-slot="sheet-title"]')
    .filter({ hasText: 'Sheet reference' })
  await openOverlay('Open Sheet', sheetTitle)
  assertClean('sheet open')

  console.log(
    JSON.stringify({
      ok: true,
      base: BASE,
      api: API,
      browser: executablePath,
      pageErrors: pageErrors.length,
      consoleErrors: consoleErrors.length,
    }),
  )
} finally {
  await browser.close()
}

if (process.exitCode) process.exit(process.exitCode)
