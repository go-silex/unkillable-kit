# Testing

## Pyramid (kit)

```text
        ┌──────────────────────┐
        │  e2e few (browser)   │  design-system smoke; later login/me
        ├──────────────────────┤
        │  app integration     │  example-api HTTP — dual auth, IDOR, CORS
        ├──────────────────────┤
        │  package units       │  auth, core, storage, types, mcp, ui contracts
        ├──────────────────────┤
        │  architecture scripts│  kit-bar scripts (names in root package.json — do not copy here)
        └──────────────────────┘
```

---
