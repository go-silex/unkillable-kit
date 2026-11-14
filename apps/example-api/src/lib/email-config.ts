import { type AuthEmailConfig, resolveRecipientEmailLocale } from '@kit/auth/factory'
import { notificationMessages } from '../messages'

/** Example product policy. Replace the resolver with the product's recipient preferences. */
export const emailConfig: AuthEmailConfig = {
  productName: notificationMessages.t(notificationMessages.defaultLocale).emailBrand,
  fallbackLocale: notificationMessages.defaultLocale,
  resolveRecipientLocale: (_email: string) => null,
}

export async function emailTemplateOptions(email: string) {
  return {
    productName: emailConfig.productName,
    locale: await resolveRecipientEmailLocale(emailConfig, email),
  }
}
