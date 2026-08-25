# ADF lifecycle

The managed profile bundle installs a namespaced child pipeline and, only for
transient transfer, namespaced Binary datasets plus one parameterised SAS linked
service. It never owns or edits the user's linked services. Hosted profiles call
`https://api.ingestron.io/v1/jobs`; customer-managed uses its selected endpoint.
Every call uses the factory managed identity. Endpoint, Entra audience, recipe
and storage mappings are compiled from reviewed config, so none of the five
historical Ingestron/job/storage ADF globals is needed.

```sh
ingestron adf init --factory-resource-id /subscriptions/.../factories/my-adf \
  --profile hosted-transient --recipe recipe.yaml
ingestron adf connection discover --config ingestron.yaml
ingestron adf connection add finance --config ingestron.yaml \
  --linked-service finance-landing --store blob \
  --namespace finance --capability read
ingestron adf connection add governed --config ingestron.yaml \
  --linked-service governed-lake --store adls \
  --namespace governed --capability write
ingestron adf connection plan --config ingestron.yaml
ingestron adf connection test finance --config ingestron.yaml
ingestron adf plan --config ingestron.yaml
ingestron adf install --config ingestron.yaml --yes
ingestron adf status --config ingestron.yaml
ingestron adf verify --config ingestron.yaml
ingestron adf plan-uninstall --config ingestron.yaml
ingestron adf uninstall --config ingestron.yaml --yes
```

Mutations always re-check the active Azure subscription and run Resource Manager
what-if. `--yes` is explicit CI/non-interactive confirmation, not a bypass. The
v2 bundle declares and pins all three profile templates. What-if may change only
the exact namespaced IDs calculated for that profile. Drift, a different active
subscription, a changed recipe, a changed bundle digest or lock ownership fails
closed.

`upgrade` snapshots the last verified applied config before mutation. `rollback`
checks that snapshot against the same installation/factory, preserves the failed
source config for audit and re-enters the same plan/apply/verify lifecycle. A v1
config migration creates a non-overwritten `.v1.bak`; connection aliases must be
reviewed before the upgraded bundle can plan.
