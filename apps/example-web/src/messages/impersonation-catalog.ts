export type ImpersonationMessages = {
  impersonationBanner: string
  impersonationActor: string
  impersonationSubject: string
  impersonationOrganization: string
  impersonationReadMode: string
  impersonationWriteMode: string
  impersonationInactive: string
  impersonationStop: string
  impersonationStopping: string
  impersonationStopError: string
  impersonationRestricted: string
  impersonationStart: string
  impersonationSelectOrganization: string
  impersonationMode: string
  impersonationRead: string
  impersonationWrite: string
  impersonationPermissionsTitle: string
  impersonationPermissionsDescription: string
  impersonationRole: string
  impersonationSave: string
  impersonationSaved: string
  impersonationConflict: string
  impersonationReload: string
}

export const impersonationFr: ImpersonationMessages = {
  impersonationBanner: 'Session de représentation',
  impersonationActor: 'Opérateur',
  impersonationSubject: 'Utilisateur représenté',
  impersonationOrganization: 'Organisation',
  impersonationReadMode: 'Lecture',
  impersonationWriteMode: 'Écriture',
  impersonationInactive:
    'Cette session n’est plus autorisée. Revenez à votre compte ou déconnectez-vous.',
  impersonationStop: 'Revenir à mon compte',
  impersonationStopping: 'Retour en cours…',
  impersonationStopError: 'Impossible de revenir à votre compte.',
  impersonationRestricted: 'Cette page est indisponible pendant la représentation.',
  impersonationStart: 'Représenter',
  impersonationSelectOrganization: 'Choisir une organisation',
  impersonationMode: 'Mode',
  impersonationRead: 'Lecture',
  impersonationWrite: 'Écriture',
  impersonationPermissionsTitle: 'Autorisations de représentation',
  impersonationPermissionsDescription:
    'Autoriser chaque rôle de plateforme à représenter un membre en lecture ou en écriture.',
  impersonationRole: 'Rôle',
  impersonationSave: 'Enregistrer',
  impersonationSaved: 'Autorisations enregistrées',
  impersonationConflict: 'Ces autorisations ont changé. Rechargez-les avant de les enregistrer.',
  impersonationReload: 'Recharger',
}

export const impersonationEn: ImpersonationMessages = {
  impersonationBanner: 'Impersonation session',
  impersonationActor: 'Operator',
  impersonationSubject: 'Represented user',
  impersonationOrganization: 'Organization',
  impersonationReadMode: 'Read',
  impersonationWriteMode: 'Write',
  impersonationInactive:
    'This session is no longer authorized. Return to your account or sign out.',
  impersonationStop: 'Return to my account',
  impersonationStopping: 'Returning…',
  impersonationStopError: 'Could not return to your account.',
  impersonationRestricted: 'This page is unavailable during impersonation.',
  impersonationStart: 'Impersonate',
  impersonationSelectOrganization: 'Select an organization',
  impersonationMode: 'Mode',
  impersonationRead: 'Read',
  impersonationWrite: 'Write',
  impersonationPermissionsTitle: 'Impersonation permissions',
  impersonationPermissionsDescription:
    'Allow each platform role to impersonate a member in read or write mode.',
  impersonationRole: 'Role',
  impersonationSave: 'Save',
  impersonationSaved: 'Permissions saved',
  impersonationConflict: 'These permissions changed. Reload them before saving.',
  impersonationReload: 'Reload',
}
