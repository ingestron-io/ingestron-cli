# Ingestron CLI engineering instructions

This public repository owns the Apache-2.0 cross-platform `ingestron` command UX,
secret-free configuration and ownership locks, stable machine output, local
validation, and safe orchestration over versioned Ingestron artefacts under
PB-041/PD-066.

PB-053/PD-080 additionally authorises the historical plan-only `product` client
for the separately versioned private Blueprint engine.

PB-056/PD-089 now makes this CLI the shared semantic and generation boundary for
the private Studio implementation. It owns the safe multi-file contract-base
loader, `$ref` composition, constrained Jinja-style declared-input resolution,
validation, reproducibility lock and independently versioned built-in generator
modules. Studio, local terminal and CI must use the same machine contract. A
credential-free `deploy plan`/handoff may describe customer-side work, but target
mutation still belongs to an explicitly authorised customer execution context.

Contracts owns job/package semantics. `ingestron-azure` owns Profile J Bicep,
change policy, and deployment helpers. Do not copy those semantics into
imperative CLI resource creation. Runtime object code remains separately licensed
under `LICENSE-RUNTIME-PREVIEW.md`; Apache-2.0 does not apply to it.

Do not add credentials, customer data, payload telemetry, hidden call-home,
automatic external mutation, private proof evidence, production/SLA claims, or general
hosted Jobs access. Examples use placeholders or synthetic data only. Public
contributions are reviewed but not accepted until the contribution policy is
explicitly changed.

Use Node.js 22 and pnpm. Run `pnpm validate`. Work on `codex/` or other
backlog-scoped branches and submit a pull request.
