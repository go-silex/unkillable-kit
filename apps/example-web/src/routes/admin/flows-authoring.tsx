import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label } from '@kit/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiErrorToMessage } from '../../lib/api'
import { flowPlansQueryKey, postFlowPlan, postFlowPlanCheck } from '../../lib/flows'
import { useLocale } from '../../lib/locale'

const SAMPLE_YAML = `# Generic dogfood plan — zero product domain strings (ADR-0005).
flows: v0
plan:
  id: demo-echo
  model: kit-infer
  description: Echo text then single-shot infer summary (kit dogfood)
  max_tokens: 2000
permits:
  tools:
    - echo
tasks:
  echo_hello:
    invoke:
      tool: echo
      args:
        text: hello-flows
  summarize:
    after:
      - echo_hello
    infer:
      prompt: "Summarize the previous echo output in one short sentence."
      max_tokens: 128
`

export function FlowsAuthoringCard({ orgId }: { orgId: string }) {
  const { m } = useLocale()
  const qc = useQueryClient()
  const [yaml, setYaml] = useState(SAMPLE_YAML)

  const check = useMutation({
    mutationFn: (input: { orgId: string; yaml: string }) =>
      postFlowPlanCheck(input.orgId, input.yaml),
    onSuccess: () => toast.success(m.flowsCheckOk),
    onError: (err) => toast.error(m.error, { description: apiErrorToMessage(err, m) }),
  })

  const save = useMutation({
    mutationFn: (input: { orgId: string; yaml: string }) => postFlowPlan(input.orgId, input.yaml),
    onSuccess: async (_data, input) => {
      toast.success(m.flowsPlanSaved)
      await qc.invalidateQueries({ queryKey: flowPlansQueryKey(input.orgId) })
    },
    onError: (err) => toast.error(m.error, { description: apiErrorToMessage(err, m) }),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{m.flowsAuthoring}</CardTitle>
        <CardDescription>{m.flowsAuthoringDesc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="flow-plan-yaml">{m.flowsYamlLabel}</Label>
          <textarea
            id="flow-plan-yaml"
            className="min-h-48 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            spellCheck={false}
            aria-label={m.flowsYamlLabel}
            placeholder={m.flowsYamlPlaceholder}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={check.isPending || !yaml.trim()}
            onClick={() => check.mutate({ orgId, yaml })}
          >
            {m.flowsCheck}
          </Button>
          <Button
            type="button"
            disabled={save.isPending || !yaml.trim()}
            onClick={() => save.mutate({ orgId, yaml })}
          >
            {m.flowsSavePlan}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
