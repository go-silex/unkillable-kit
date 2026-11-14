export type KeysMessages = {
  keys: string
  keysDesc: string
  mintKey: string
  mintKeyDesc: string
  keyScopes: string
  keyScopesHelp: string
  keyScopeRead: string
  keyScopeWrite: string
  keyScopeAdmin: string
  copyKey: string
  keyOnce: string
}

export const keysEn: KeysMessages = {
  keys: 'API keys',
  keysDesc: 'Mint an sk_ key for MCP / machine auth',
  mintKey: 'Generate key',
  mintKeyDesc: 'Plaintext key is shown only once.',
  keyScopes: 'Scopes',
  keyScopesHelp: 'Scopes are independent. Read-only is selected by default.',
  keyScopeRead: 'Read',
  keyScopeWrite: 'Write',
  keyScopeAdmin: 'Admin',
  copyKey: 'Copy',
  keyOnce: 'Copy it now — it will not be shown again.',
}

export const keysFr: KeysMessages = {
  keys: 'Clés API',
  keysDesc: 'Mint une clé sk_ pour MCP / machine auth',
  mintKey: 'Générer une clé',
  mintKeyDesc: 'La clé en clair n’est affichée qu’une fois.',
  keyScopes: 'Autorisations',
  keyScopesHelp: 'Les autorisations sont indépendantes. Lecture seule est sélectionnée par défaut.',
  keyScopeRead: 'Lecture',
  keyScopeWrite: 'Écriture',
  keyScopeAdmin: 'Administration',
  copyKey: 'Copier',
  keyOnce: 'Copiez-la maintenant — elle ne sera plus visible.',
}
