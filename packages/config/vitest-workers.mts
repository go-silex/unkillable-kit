// Vitest 5.1 reserves one CPU by default in run mode. Use every available CPU in CI only.
export const ciMaxWorkers = process.env.CI ? '100%' : undefined
