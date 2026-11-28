/**
 * Ensures `paths` `@/*` resolve under TypeScript 7 without `baseUrl`.
 * Typechecked by the package `typecheck` script; not a runtime export surface.
 */
import { cn } from '@/lib/utils'

export function pathsSmoke(...classes: string[]): string {
  return cn(...classes)
}
