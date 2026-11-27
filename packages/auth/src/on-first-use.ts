/** Returns `build`'s value, computed on the first call and returned again on later calls. */
export function lazily<T>(build: () => T): () => T {
  let built: { value: T } | undefined
  return () => {
    built ??= { value: build() }
    return built.value
  }
}

/**
 * Stands in for the object `build` returns, building it on the first operation and forwarding
 * every operation to that one object.
 */
export function onFirstUse<T extends object>(build: () => T): T {
  const target = lazily(build)
  return new Proxy({} as T, {
    get: (_, key) => Reflect.get(target(), key),
    set: (_, key, value) => Reflect.set(target(), key, value),
    has: (_, key) => Reflect.has(target(), key),
    deleteProperty: (_, key) => Reflect.deleteProperty(target(), key),
    defineProperty: (_, key, descriptor) => Reflect.defineProperty(target(), key, descriptor),
    getOwnPropertyDescriptor: (_, key) => Reflect.getOwnPropertyDescriptor(target(), key),
    ownKeys: () => Reflect.ownKeys(target()),
    getPrototypeOf: () => Reflect.getPrototypeOf(target()),
  })
}
