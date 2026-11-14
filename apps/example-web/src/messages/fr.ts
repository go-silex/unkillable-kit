import type { FlowsMessages } from './flows-catalog'
import { flowsFr } from './flows-catalog'
import { type ImpersonationMessages, impersonationFr } from './impersonation-catalog'
import { type KeysMessages, keysFr } from './keys-catalog'

export type Messages = {
  appTitle: string
  appSubtitle: string
  login: string
  loginTitle: string
  loginDesc: string
  welcomeTitle: string
  forgotPassword: string
  forgotTitle: string
  forgotDesc: string
  forgotSubmit: string
  forgotEmailHint: string
  forgotEmailRequired: string
  forgotSentTitle: string
  forgotSentDesc: string
  resetPasswordTitle: string
  resetPasswordDesc: string
  resetPasswordNew: string
  resetPasswordConfirm: string
  resetPasswordSubmit: string
  resetPasswordSuccess: string
  resetPasswordMissingToken: string
  resetPasswordInvalidLink: string
  resetPasswordTooShort: string
  resetPasswordMismatch: string
  backToLogin: string
  loginLegal: string
  /** Public sign-up (only when `/health.allowPublicSignup`). */
  signUp: string
  signUpTitle: string
  signUpDesc: string
  signUpSubmit: string
  signUpName: string
  signUpHasAccount: string
  signUpFailed: string
  signUpDisabled: string
  signUpNameRequired: string
  /** Login mode: password vs magic link (B-magic go-silex/silex-boilerplate#59). */
  loginModePassword: string
  loginModeMagic: string
  magicSubmit: string
  magicSentTitle: string
  magicSentDesc: string
  magicHint: string
  email: string
  password: string
  submit: string
  logout: string
  notes: string
  notesDesc: string
  createNote: string
  noteBodyHint: string
  title: string
  body: string
  delete: string
  tableSearch: string
  tableFilter: string
  tableFilterAll: string
  tableFilterWithBody: string
  tableFilterEmptyBody: string
  tableNoResults: string
  tableSortHint: string
  settings: string
  settingsDesc: string
  appearance: string
  themeLight: string
  themeDark: string
  themeSystem: string
  language: string
  me: string
  sendEmail: string
  emailSent: string
  mailpit: string
  health: string
  empty: string
  error: string
  loadFailed: string
  retry: string
  dashboard: string
  session: string
  authMethod: string
  loading: string
  save: string
  cancel: string
  confirmDelete: string
  noteCreated: string
  itemCreated: string
  itemUpdated: string
  itemDeleted: string
  noteDeleted: string
  itemsTitle: string
  itemsDescription: string
  itemCreate: string
  itemEdit: string
  itemCode: string
  itemLabel: string
  itemDescription: string
  itemActive: string
  itemActiveYes: string
  itemActiveNo: string
  itemSearchPlaceholder: string
  itemEmptyTitle: string
  itemEmptyDescription: string
  itemDeleteConfirmTitle: string
  keyMinted: string
  keyRevoked: string
  keysList: string
  emptyKeys: string
  revokeKey: string
  confirmRevoke: string
  bearerTitle: string
  bearerDesc: string
  bearerHelp: string
  bearerSessionNote: string
  copied: string
  navDashboard: string
  navNotes: string
  navItems: string
  navTasks: string
  navKeys: string
  tasksDesc: string
  tasksNeedOrg: string
  tasksEmpty: string
  tasksEmptyDesc: string
  tasksList: string
  taskCreate: string
  taskCreated: string
  taskTitle: string
  taskDescription: string
  taskStage: string
  taskVisibility: string
  taskVisibilityInternal: string
  taskVisibilityShared: string
  taskComments: string
  taskSelectForComments: string
  taskCommentsEmpty: string
  taskCommentPlaceholder: string
  taskCommentAdd: string
  taskCommentAdded: string
  navSettings: string
  navChangelog: string
  changelogTitle: string
  changelogDesc: string
  changelogEmpty: string
  navDesignSystem: string
  navPlatform: string
  navSecondary: string
  navAdmin: string
  navApp: string
  navOrgs: string
  navUsers: string
  navModules: string
  navMembers: string
  navAdminHome: string
  navAppHome: string
  shellAdminSubtitle: string
  shellAppSubtitle: string
  orgPicker: string
  orgPickerEmpty: string
  adminOrgsDesc: string
  adminUsersDesc: string
  adminUserCreateTitle: string
  adminUserCreateDesc: string
  adminUserName: string
  adminUserPlane: string
  adminUserPlaneClient: string
  adminUserOrg: string
  adminUserOrgNone: string
  adminUserSendEmail: string
  adminUserSubmit: string
  adminUserCreated: string
  adminUserSearch: string
  adminUserLoadMore: string
  adminUserLoadingMore: string
  adminUserResend: string
  adminUserWelcomeResent: string
  orgCatalogueBadge: string
  orgCreate: string
  orgCreateTitle: string
  orgCreateDesc: string
  orgName: string
  orgSlug: string
  orgSlugHint: string
  orgCreated: string
  orgNameRequired: string
  switchToApp: string
  switchToAdmin: string
  online: string
  offline: string
  account: string
  displayName: string
  displayNameHint: string
  profileSaved: string
  profileNameRequired: string
  changePasswordTitle: string
  changePasswordDesc: string
  changePasswordCurrent: string
  changePasswordNew: string
  changePasswordConfirm: string
  changePasswordSubmit: string
  changePasswordSuccess: string
  changePasswordWrong: string
  changePasswordReauth: string
  changePasswordRevokeOthers: string
  changePasswordTooShort: string
  changePasswordMismatch: string
  changePasswordCurrentRequired: string
  designSystem: string
  designSystemDesc: string
  designSystemFooter: string
  dsFoundations: string
  dsFoundationsDesc: string
  dsForms: string
  dsFeedback: string
  dsOverlays: string
  dsData: string
  dsTanstack: string
  dsTanstackDesc: string
  dsTemplates: string
  dsTemplatesDesc: string
  dsOnThisPage: string
  forbidden: string
  forbiddenDesc: string
  forbiddenPlatform: string
  forbiddenPlatformDesc: string
  /** Stable ErrorCode → UI copy (API codes stay English; FE translates). */
  errUnauthorized: string
  /**
   * Wrong credentials on password sign-in — **UI copy only**
   * (never “unknown email” vs “bad password” in the toast; wire status may still differ).
   */
  loginFailed: string
  errForbidden: string
  errNotFound: string
  errValidation: string
  errConflict: string
  errInternal: string
  errRateLimited: string
  errEmailInvalid: string
  errPasswordRequired: string
  errTitleRequired: string
  errSupportCta: string
  errPageTitle: string
  envBannerLocal: string
  envBannerStaging: string
  envBannerAdmin: string
  modulesTitle: string
  modulesDesc: string
  moduleOn: string
  moduleOff: string
  moduleNotConfigured: string
  backToSettings: string
  errIntegrationNotConfigured: string
  inviteTitle: string
  inviteDesc: string
  inviteRole: string
  roleOwner: string
  roleAdmin: string
  roleMember: string
  roleReader: string
  inviteSubmit: string
  inviteSent: string
  invitePending: string
  inviteEmpty: string
  inviteCancel: string
  inviteCanceled: string
  inviteNoPermission: string
  membersList: string
  inviteAcceptTitle: string
  inviteAcceptDesc: string
  inviteAcceptSubmit: string
  inviteAcceptMissing: string
  inviteAccepted: string
  orgRolesTitle: string
  orgRolesDesc: string
  orgRoleKey: string
  orgRoleName: string
  orgRoleCreate: string
  orgRoleSystem: string
  roleCreated: string
  roleDeleted: string
  accessWrite: string
  accessRead: string
  accessDisabled: string
  grantAccessLabel: string
  orgRoleGrantsEmpty: string
  confirmDeleteRole: string
  membersEmpty: string
  inviteExpires: string
} & FlowsMessages &
  ImpersonationMessages &
  KeysMessages

export const fr: Messages = {
  ...impersonationFr,
  ...keysFr,
  appTitle: 'Kit Kit',
  appSubtitle: 'example-web · starter SaaS',
  login: 'Connexion',
  loginTitle: 'Connexion',
  loginDesc: 'Session cookie HttpOnly · credentials include',
  welcomeTitle: 'Bienvenue sur Kit Kit',
  forgotPassword: 'Mot de passe oublié ?',
  forgotTitle: 'Réinitialiser le mot de passe',
  forgotDesc: 'Entrez votre e-mail — nous enverrons un lien si un compte existe.',
  forgotSubmit: 'Envoyer le lien',
  forgotEmailHint: 'Réponse générique (pas d’énumération de comptes). Transport log en local.',
  forgotEmailRequired: 'E-mail requis',
  forgotSentTitle: 'Demande enregistrée',
  forgotSentDesc:
    'Si un compte existe, un e-mail de réinitialisation a été envoyé (transport log en local — console Worker).',
  resetPasswordTitle: 'Nouveau mot de passe',
  resetPasswordDesc: 'Choisissez un mot de passe d’au moins 8 caractères.',
  resetPasswordNew: 'Nouveau mot de passe',
  resetPasswordConfirm: 'Confirmer',
  resetPasswordSubmit: 'Enregistrer',
  resetPasswordSuccess: 'Mot de passe mis à jour — connectez-vous',
  resetPasswordMissingToken: 'Lien invalide ou token manquant.',
  resetPasswordInvalidLink: 'Lien de réinitialisation invalide ou expiré.',
  resetPasswordTooShort: 'Au moins 8 caractères',
  resetPasswordMismatch: 'Les mots de passe ne correspondent pas',
  backToLogin: 'Retour à la connexion',
  loginLegal: 'En continuant, vous acceptez les conditions d’utilisation du kit démo.',
  signUp: 'Créer un compte',
  signUpTitle: 'Créer un compte',
  signUpDesc: 'Inscription e-mail — session cookie HttpOnly.',
  signUpSubmit: 'Créer le compte',
  signUpName: 'Nom',
  signUpHasAccount: 'Déjà un compte ? Connexion',
  signUpFailed: 'Impossible de créer le compte. Essayez de vous connecter.',
  signUpDisabled: 'L’inscription publique est désactivée.',
  signUpNameRequired: 'Le nom est requis',
  loginModePassword: 'Mot de passe',
  loginModeMagic: 'Lien magique',
  magicSubmit: 'Envoyer le lien',
  magicSentTitle: 'Vérifiez votre e-mail',
  magicSentDesc:
    'Si un compte existe, un lien de connexion a été envoyé (transport log en local — console Worker).',
  magicHint: 'Réponse générique (pas d’énumération). Lien valable environ 5 minutes.',
  email: 'E-mail',
  password: 'Mot de passe',
  submit: 'Se connecter',
  logout: 'Déconnexion',
  notes: 'Notes',
  notesDesc: 'CRUD démo (D1 + pièces jointes R2 optionnelles)',
  createNote: 'Créer une note',
  noteBodyHint: 'Markdown OK — **gras**, listes, liens…',
  title: 'Titre',
  body: 'Corps',
  delete: 'Supprimer',
  tableSearch: 'Rechercher…',
  tableFilter: 'Filtre',
  tableFilterAll: 'Toutes',
  tableFilterWithBody: 'Avec corps',
  tableFilterEmptyBody: 'Corps vide',
  tableNoResults: 'Aucun résultat pour ce filtre / recherche',
  tableSortHint: 'Cliquer pour trier',
  settings: 'Paramètres',
  settingsDesc: 'Thème, langue et compte démo',
  appearance: 'Apparence',
  themeLight: 'Clair',
  themeDark: 'Sombre',
  themeSystem: 'Système',
  language: 'Langue',
  me: 'Compte',
  sendEmail: 'Envoyer e-mail démo',
  emailSent: 'E-mail démo envoyé (transport log en local — console Worker)',
  mailpit: 'Log local (console Worker)',
  health: 'API',
  empty: 'Aucune note pour l’instant',
  error: 'Erreur',
  loadFailed: 'Chargement impossible',
  retry: 'Réessayer',
  dashboard: 'Tableau de bord',
  session: 'Session',
  authMethod: 'Méthode',
  loading: 'Chargement…',
  save: 'Enregistrer',
  cancel: 'Annuler',
  confirmDelete: 'Supprimer cette note ?',
  noteCreated: 'Note créée',
  itemCreated: 'Élément créé',
  itemUpdated: 'Élément mis à jour',
  itemDeleted: 'Élément supprimé',
  noteDeleted: 'Note supprimée',
  itemsTitle: 'MasterData (démo)',
  itemsDescription: 'Entité référentielle demo_items — pattern kit copiable (CRUD + ownership).',
  itemCreate: 'Nouvel élément',
  itemEdit: 'Modifier',
  itemCode: 'Code',
  itemLabel: 'Libellé',
  itemDescription: 'Description',
  itemActive: 'Actif',
  itemActiveYes: 'Oui',
  itemActiveNo: 'Non',
  itemSearchPlaceholder: 'Filtrer code / libellé…',
  itemEmptyTitle: 'Aucun élément',
  itemEmptyDescription: 'Créez une entrée catalogue pour dogfooder le pattern MasterData.',
  itemDeleteConfirmTitle: 'Supprimer cet élément ?',
  keyMinted: 'Clé API générée',
  keyRevoked: 'Clé révoquée',
  keysList: 'Clés actives',
  emptyKeys: 'Aucune clé active',
  revokeKey: 'Révoquer',
  confirmRevoke: 'Révoquer cette clé API ? Elle ne pourra plus être utilisée.',
  bearerTitle: 'Bearer',
  bearerDesc: 'Authorization: Bearer sk_…',
  bearerHelp:
    'Les clients MCP / machine appellent la même API Hono avec une clé sk_ mintée ici (session uniquement).',
  bearerSessionNote: 'Les sessions UI restent en cookies HttpOnly — pas de clé d’équipe partagée.',
  copied: 'Copié dans le presse-papiers',
  navDashboard: 'Dashboard',
  navNotes: 'Notes',
  navItems: 'Catalogue',
  navTasks: 'Tâches',
  navKeys: 'Clés API',
  tasksDesc: 'Dogfood @kit/tasks — board main, visibilité, commentaires (org active).',
  tasksNeedOrg: 'Sélectionnez une organisation pour charger les tâches.',
  tasksEmpty: 'Aucune tâche',
  tasksEmptyDesc: 'Créez une tâche pour valider le module tasks sur cette org.',
  tasksList: 'Liste',
  taskCreate: 'Nouvelle tâche',
  taskCreated: 'Tâche créée',
  taskTitle: 'Titre',
  taskDescription: 'Description',
  taskStage: 'Colonne',
  taskVisibility: 'Visibilité',
  taskVisibilityInternal: 'Interne',
  taskVisibilityShared: 'Partagée',
  taskComments: 'Commentaires',
  taskSelectForComments: 'Sélectionnez une tâche pour voir les commentaires.',
  taskCommentsEmpty: 'Pas encore de commentaire.',
  taskCommentPlaceholder: 'Ajouter un commentaire…',
  taskCommentAdd: 'Commenter',
  taskCommentAdded: 'Commentaire ajouté',
  navSettings: 'Paramètres',
  navChangelog: 'Nouveautés',
  changelogTitle: 'Nouveautés',
  changelogDesc: 'Ce qui a changé dans le kit (demo app-owned).',
  changelogEmpty: 'Aucune note de version pour le moment.',
  navDesignSystem: 'Design system',
  navPlatform: 'Plateforme',
  navSecondary: 'Plus',
  navAdmin: 'Back-office',
  navApp: 'Espace client',
  navOrgs: 'Organisations',
  navUsers: 'Utilisateurs',
  navModules: 'Modules plateforme',
  navMembers: 'Membres',
  navAdminHome: 'Accueil BO',
  navAppHome: 'Accueil app',
  shellAdminSubtitle: 'Back-office plateforme',
  shellAppSubtitle: 'Espace client multi-tenant',
  orgPicker: 'Organisation active',
  orgPickerEmpty: 'Aucune organisation',
  adminOrgsDesc: 'Staff = memberships · super = catalogue',
  adminUsersDesc: 'Provisionner des comptes, plane et memberships',
  adminUserCreateTitle: 'Créer un utilisateur',
  adminUserCreateDesc: 'Compte BA + e-mail de première connexion (set password).',
  adminUserName: 'Nom',
  adminUserPlane: 'Plane (platformRole)',
  adminUserPlaneClient: 'Client (aucun)',
  adminUserOrg: 'Organisation (optionnel)',
  adminUserOrgNone: '— aucune —',
  adminUserSendEmail: 'Envoyer l’e-mail de bienvenue',
  adminUserSubmit: 'Créer et envoyer',
  adminUserCreated: 'Utilisateur créé',
  adminUserSearch: 'Rechercher…',
  adminUserLoadMore: 'Charger plus',
  adminUserLoadingMore: 'Chargement supplémentaire…',
  adminUserResend: 'Renvoyer welcome',
  adminUserWelcomeResent: 'E-mail de bienvenue renvoyé',
  orgCatalogueBadge: 'catalogue',
  orgCreate: 'Créer une organisation',
  orgCreateTitle: 'Nouvelle organisation',
  orgCreateDesc: 'Vous en serez le propriétaire. Le slug est dérivé du nom si vide.',
  orgName: 'Nom',
  orgSlug: 'Slug',
  orgSlugHint: 'Optionnel · a-z, 0-9, tirets',
  orgCreated: 'Organisation créée',
  orgNameRequired: 'Le nom est requis',
  switchToApp: 'Espace client',
  switchToAdmin: 'Back-office',
  online: 'API OK',
  offline: 'API hors ligne',
  account: 'Compte',
  displayName: 'Nom affiché',
  displayNameHint: 'Visible dans le shell et les e-mails kit.',
  profileSaved: 'Profil mis à jour',
  profileNameRequired: 'Le nom est requis',
  changePasswordTitle: 'Changer le mot de passe',
  changePasswordDesc: 'Session active — pas besoin de lien e-mail.',
  changePasswordCurrent: 'Mot de passe actuel',
  changePasswordNew: 'Nouveau mot de passe',
  changePasswordConfirm: 'Confirmer',
  changePasswordSubmit: 'Mettre à jour le mot de passe',
  changePasswordSuccess: 'Mot de passe mis à jour',
  changePasswordWrong: 'Mot de passe actuel incorrect',
  changePasswordReauth: 'Reconnectez-vous pour modifier le mot de passe',
  changePasswordRevokeOthers: 'Déconnecter les autres sessions',
  changePasswordTooShort: 'Au moins 8 caractères',
  changePasswordMismatch: 'Les mots de passe ne correspondent pas',
  changePasswordCurrentRequired: 'Mot de passe actuel requis',
  designSystem: 'Design system',
  designSystemDesc:
    'Catalogue shadcn Base (base-nova) · réservé plateforme · templates de page de référence',
  designSystemFooter: '100 % composants @kit/ui (registry shadcn + @base-ui/react)',
  dsFoundations: 'Fondations',
  dsFoundationsDesc: 'Tokens couleur, typo, radius (CSS variables shadcn)',
  dsForms: 'Formulaires',
  dsFeedback: 'Feedback',
  dsOverlays: 'Overlays',
  dsData: 'Data display',
  dsTanstack: 'TanStack',
  dsTanstackDesc:
    'Form + Table + Markdown (+ hotkeys dans main/notes) — dogfood headless pour products',
  dsTemplates: 'Templates de page',
  dsTemplatesDesc: 'Motifs d’écran SaaS réutilisables (auth, empty, settings, KPI, liste)',
  dsOnThisPage: 'Sur cette page',
  forbidden: 'Accès refusé',
  forbiddenDesc: 'Cette page est réservée aux administrateurs.',
  forbiddenPlatform: 'Accès back-office refusé',
  forbiddenPlatformDesc: 'Le back-office est réservé au staff et super admin plateforme.',
  errUnauthorized: 'Session expirée ou non authentifié',
  loginFailed: 'E-mail ou mot de passe incorrect',
  errForbidden: 'Action non autorisée',
  errNotFound: 'Ressource introuvable',
  errValidation: 'Données invalides',
  errConflict: 'Conflit — ressource déjà existante',
  errInternal: 'Erreur interne — réessayez plus tard',
  errRateLimited: 'Trop de requêtes — patientez un moment',
  errEmailInvalid: 'Adresse e-mail invalide',
  errPasswordRequired: 'Mot de passe requis',
  errTitleRequired: 'Titre requis',
  errSupportCta: 'Contacter le support',
  errPageTitle: 'Une erreur est survenue',
  envBannerLocal: 'Environnement local — données de démo uniquement',
  envBannerStaging: 'Environnement staging — ne pas utiliser pour de vraies données',
  envBannerAdmin: 'Compte admin seed',
  modulesTitle: 'Modules',
  modulesDesc: 'Activation des fonctionnalités optionnelles (D1 kit_modules)',
  moduleOn: 'Activé',
  moduleOff: 'Désactivé',
  moduleNotConfigured: 'Non configuré',
  backToSettings: 'Retour paramètres',
  errIntegrationNotConfigured: 'Configure l’intégration avant d’activer ce module',
  inviteTitle: 'Inviter un membre',
  inviteDesc: 'Envoi d’une invitation (e-mail log local / transport kit).',
  inviteRole: 'Rôle',
  roleOwner: 'Propriétaire',
  roleAdmin: 'Admin',
  roleMember: 'Membre',
  roleReader: 'Lecteur',
  inviteSubmit: 'Inviter',
  inviteSent: 'Invitation créée',
  invitePending: 'Invitations en attente',
  inviteEmpty: 'Aucune invitation en attente',
  inviteCancel: 'Révoquer',
  inviteCanceled: 'Invitation annulée',
  inviteNoPermission: 'Vous n’avez pas la permission de gérer les membres.',
  membersList: 'Membres',
  inviteAcceptTitle: 'Accepter l’invitation',
  inviteAcceptDesc: 'Compte de session',
  inviteAcceptSubmit: 'Rejoindre l’organisation',
  inviteAcceptMissing: 'Lien d’invitation invalide (invitationId manquant).',
  inviteAccepted: 'Invitation acceptée',
  orgRolesTitle: 'Rôles & grants (Phase B)',
  orgRolesDesc: 'Rôles système immuables · rôles custom + accès module (write|read|disabled)',
  orgRoleKey: 'Clé',
  orgRoleName: 'Nom',
  orgRoleCreate: 'Créer le rôle',
  orgRoleSystem: 'système',
  roleCreated: 'Rôle créé',
  roleDeleted: 'Rôle supprimé',
  accessWrite: 'écriture',
  accessRead: 'lecture',
  accessDisabled: 'désactivé',
  grantAccessLabel: 'Accès module {module}',
  orgRoleGrantsEmpty: 'Aucun grant module pour ce rôle',
  confirmDeleteRole:
    'Supprimer ce rôle custom ? Les membres qui l’utilisent doivent être réassignés.',
  membersEmpty: 'Aucun membre',
  inviteExpires: 'exp.',
  ...flowsFr,
}
