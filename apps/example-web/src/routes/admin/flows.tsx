/**
 * ADR-0005 D6
 * List stays read-only for HITL; approve lives on run detail (Roxabi/roxabi-boilerplate-cf#288).
 */
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kit/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { PageHeader } from '../../components/app-shell'
import { apiErrorToMessage } from '../../lib/api'
import {
  fetchFlowPlans,
  fetchFlowRuns,
  flowPlansQueryKey,
  flowRunsQueryKey,
  patchPlanEnabled,
  postFlowRun,
} from '../../lib/flows'
import { useLocale } from '../../lib/locale'
import { useOrgContext } from '../../lib/org-context'
import { FlowsAuthoringCard } from './flows-authoring'
import { FlowsQueryError } from './flows-denial'
import { FlowsPlansCard, FlowsRunsCard } from './flows-panels'

export function AdminFlowsPage() {
  const { m } = useLocale()
  const { orgs, activeOrg, activeOrgId, setActiveOrgId } = useOrgContext()
  const orgId = activeOrgId
  const qc = useQueryClient()

  const plans = useQuery({
    queryKey: orgId ? flowPlansQueryKey(orgId) : ['flows', 'plans', 'none'],
    enabled: Boolean(orgId),
    queryFn: () => fetchFlowPlans(orgId!),
  })
  const runs = useQuery({
    queryKey: orgId ? flowRunsQueryKey(orgId) : ['flows', 'runs', 'none'],
    enabled: Boolean(orgId),
    queryFn: () => fetchFlowRuns(orgId!),
  })

  const toggle = useMutation({
    mutationFn: (vars: { orgId: string; planId: string; enabled: boolean }) =>
      patchPlanEnabled(vars.orgId, vars.planId, vars.enabled),
    onSuccess: async (_data, vars) => {
      await qc.invalidateQueries({ queryKey: flowPlansQueryKey(vars.orgId) })
    },
    onError: (err) => toast.error(m.error, { description: apiErrorToMessage(err, m) }),
  })

  const queueRun = useMutation({
    mutationFn: (vars: { orgId: string; planId: string }) => postFlowRun(vars.orgId, vars.planId),
    onSuccess: async (_data, vars) => {
      toast.success(m.flowsRunQueued)
      await qc.invalidateQueries({ queryKey: flowRunsQueryKey(vars.orgId) })
    },
    onError: (err) => toast.error(m.error, { description: apiErrorToMessage(err, m) }),
  })

  if (!orgId) {
    return (
      <div>
        <PageHeader title={m.navFlows} description={m.flowsDesc} />
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{m.flowsNeedOrg}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  const orgItems = orgs.map((org) => ({ value: org.id, label: org.name }))
  const denial = plans.error ?? runs.error
  const ops = plans.data?.allowedOperations
  const canToggle = ops?.setPlanEnabled === true
  const canCreate = ops?.createPlan === true
  const canRun = ops?.createRun === true

  return (
    <div className="space-y-6">
      <PageHeader
        title={m.navFlows}
        description={m.flowsDesc}
        actions={
          orgs.length > 1 ? (
            <Select
              items={orgItems}
              value={orgId}
              onValueChange={(value) => {
                if (value) setActiveOrgId(value)
              }}
            >
              <SelectTrigger className="w-48" aria-label={m.orgPicker}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {orgItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm text-muted-foreground">{activeOrg?.name}</p>
          )
        }
      />

      {denial ? (
        <FlowsQueryError
          error={denial}
          onRetry={() => {
            void plans.refetch()
            void runs.refetch()
          }}
        />
      ) : (
        <>
          {canCreate ? <FlowsAuthoringCard key={orgId} orgId={orgId} /> : null}
          <FlowsPlansCard
            orgId={orgId}
            orgName={activeOrg?.name}
            plans={plans}
            canToggle={canToggle}
            canRun={canRun}
            toggle={toggle}
            queueRun={queueRun}
            m={m}
          />
          <FlowsRunsCard runs={runs} m={m} />
        </>
      )}
    </div>
  )
}
