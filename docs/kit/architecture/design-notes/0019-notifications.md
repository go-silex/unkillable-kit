# ADR-0019 design note

Non-normative. Extracted from ADR-0019 on 2026-11-14. Binding only once an accepted ADR amendment adopts it when the code is implemented.

## Administration routes

| Method and path                                                      | Request                         | 200 response / authorization                                                                                       |
| -------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GET `/api/orgs/{orgId}/notification-destinations`                    | Page query                      | `Page<DestinationDto>`; manage_notifications                                                                       |
| POST `/api/orgs/{orgId}/notification-destinations`                   | `{channel,externalId,selector}` | **201** `{destination:DestinationDto,requestId}`; manage_notifications; validate installed address and type opt-in |
| PUT `/api/orgs/{orgId}/notification-destinations/{destinationId}`    | `{selector}`                    | `{destination:DestinationDto,requestId}`; address identity immutable                                               |
| DELETE `/api/orgs/{orgId}/notification-destinations/{destinationId}` | No body                         | `{ok:true,requestId}`; manage_notifications                                                                        |

## Slack Channel

| Owner                      | Interface responsibility                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@kit/slack/notifications` | Implements the Channel interface with a **type-only** import from notifications; notifications never imports Slack |

## Destination DTO

```ts
type DestinationDto = {
  id: string; channel: string; externalId: string; selector: Selector
  createdAt: number; updatedAt: number
}
```
