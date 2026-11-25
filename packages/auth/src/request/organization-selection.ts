import { AppError } from '@kit/core'
import type { Context, Env } from 'hono'
import { isIdentifier, unavailable } from '../snapshot/core-rows'
import type { OrgContextOpts } from './request-policy'

export function organizationHeader(headers: Headers): string | undefined {
  const value = headers.get('x-org-id')
  if (!value) return undefined
  // Fetch combines repeated fields with commas. Even an identical repetition is malformed.
  if (value.includes(',') || !isIdentifier(value)) throw AppError.validation('Invalid X-Org-Id')
  return value
}

export type Selection = { id?: string; error?: AppError }

export function selectOrganization<E extends Env>(
  c: Context<E>,
  choose?: OrgContextOpts<E>['organizationId'],
): Selection {
  let header: string | undefined
  try {
    header = organizationHeader(c.req.raw.headers)
  } catch (error) {
    return { error: error instanceof AppError ? error : unavailable() }
  }
  const path = c.req.param('orgId')
  if (path !== undefined && !isIdentifier(path))
    return { error: AppError.validation('Invalid organization id') }
  if (path !== undefined && header !== undefined && path !== header) {
    return { error: AppError.forbidden('Organization mismatch') }
  }
  const supplied = path ?? header
  if (!choose) return { id: supplied }
  let chosen: unknown
  try {
    chosen = choose(c)
  } catch {
    return { error: unavailable() }
  }
  if (!isIdentifier(chosen)) return { error: AppError.validation('Invalid organization id') }
  return supplied !== undefined && supplied !== chosen
    ? { error: AppError.forbidden('Organization mismatch') }
    : { id: chosen }
}
