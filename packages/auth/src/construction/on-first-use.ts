/** Returns `build`'s value, computed on the first call and returned again on later calls. */
export function lazily<T>(build: () => T): () => T {
  let built: { value: T } | undefined
  return () => {
    built ??= { value: build() }
    return built.value
  }
}

/**
 * Stands in for the object `build` returns. The first operation on the stand-in builds that object
 * and moves its prototype and own properties onto the stand-in, which from then on behaves as that
 * object. A failed build is retried by the next operation; an operation during the build throws.
 */
export function onFirstUse<T extends object>(build: () => T): T {
  const handle = {} as T
  let state: 'pending' | 'building' | 'built' = 'pending'
  const open = () => {
    if (state === 'built') return handle
    if (state === 'building') throw new Error('The handle was used while it was being built')
    state = 'building'
    try {
      const value = build()
      Object.setPrototypeOf(handle, Object.getPrototypeOf(value))
      Object.defineProperties(handle, Object.getOwnPropertyDescriptors(value))
      state = 'built'
    } finally {
      if (state === 'building') state = 'pending'
    }
    return handle
  }
  return new Proxy(handle, {
    get: (_, key, receiver) => Reflect.get(open(), key, receiver),
    set: (_, key, value, receiver) => Reflect.set(open(), key, value, receiver),
    has: (_, key) => Reflect.has(open(), key),
    deleteProperty: (_, key) => Reflect.deleteProperty(open(), key),
    defineProperty: (_, key, descriptor) => Reflect.defineProperty(open(), key, descriptor),
    getOwnPropertyDescriptor: (_, key) => Reflect.getOwnPropertyDescriptor(open(), key),
    ownKeys: () => Reflect.ownKeys(open()),
    getPrototypeOf: () => Reflect.getPrototypeOf(open()),
    setPrototypeOf: (_, prototype) => Reflect.setPrototypeOf(open(), prototype),
    isExtensible: () => Reflect.isExtensible(open()),
    preventExtensions: () => Reflect.preventExtensions(open()),
  })
}
