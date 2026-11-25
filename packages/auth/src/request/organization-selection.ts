import { AppError } from '@kit/core'
import { isIdentifier } from '../snapshot/core-rows'

export function organizationHeader(headers: Headers): string | undefined {
  const value = headers.get('x-org-id')
  if (!value) return undefined
  // Fetch combines repeated fields with commas. Even an identical repetition is malformed.
  if (value.includes(',') || !isIdentifier(value)) throw AppError.validation('Invalid X-Org-Id')
  return value
}
