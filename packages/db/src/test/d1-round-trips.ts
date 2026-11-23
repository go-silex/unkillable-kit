import type { KitD1Database } from '../index'

/** Wrap a test binding before dispatching one HTTP request. Setup must use the original binding. */
export function countD1RoundTrips<T extends KitD1Database>(db: T) {
  let count = 0
  const statements = new WeakMap<object, object>()

  function wrapStatement(statement: object) {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        const method = Reflect.get(target, key, target)
        if (typeof method !== 'function') return method
        if (key === 'bind') {
          return (...args: unknown[]) => wrapStatement(Reflect.apply(method, target, args))
        }
        return (...args: unknown[]) => {
          if (key === 'first' || key === 'all' || key === 'run' || key === 'raw') count++
          return Reflect.apply(method, target, args)
        }
      },
    })
    statements.set(wrapped, statement)
    return wrapped
  }

  function wrapDatabase<U extends object>(binding: U): U {
    return new Proxy(binding, {
      get(target, key) {
        const method = Reflect.get(target, key, target)
        if (typeof method !== 'function') return method
        switch (key) {
          case 'prepare':
            return (sql: string) => wrapStatement(Reflect.apply(method, target, [sql]))
          case 'withSession':
            return (...args: unknown[]) => wrapDatabase(Reflect.apply(method, target, args))
          case 'batch':
            return (batch: object[]) => {
              count++
              return Reflect.apply(method, target, [
                batch.map((stmt) => statements.get(stmt) ?? stmt),
              ])
            }
          case 'exec':
            return (sql: string) => {
              count++
              return Reflect.apply(method, target, [sql])
            }
          default:
            return method.bind(target)
        }
      },
    })
  }

  return {
    db: wrapDatabase(db),
    get count() {
      return count
    },
    assertAtMost(route: string, ceiling: number) {
      if (count > ceiling) {
        throw new Error(`${route}: D1 round-trip ceiling ${ceiling}, observed ${count}`)
      }
    },
  }
}
