import type { EmailLocale } from '@kit/email'
import { notificationMessages } from '../messages'

/** Example product policy. Replace the resolver with the product's recipient preferences. */
export const emailConfig = {
  productName: 'App',
  fallbackLocale: notificationMessages.defaultLocale,
  resolveRecipientLocale: (_email: string): EmailLocale | null => null,
}

export async function emailTemplateOptions(email: string) {
  return {
    productName: emailConfig.productName,
    locale: (await emailConfig.resolveRecipientLocale(email)) ?? emailConfig.fallbackLocale,
  }
}
