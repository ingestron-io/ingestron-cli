# Keep reviewed standards-package versions locally

Source-only PB-060 functionality, 2026-09-05. Use this guide to inspect the actual
files in a standards package and retain multiple exact versions without replacing
an earlier release. No published release, cloud resource or paid service is needed.

This registry is separate from your contract base. Importing a package **does not
bind it to a product, change a project or enable its templates for generation**.
Those integration steps remain unimplemented. The current generators are still
the [CLI built-ins](generator-verification.md).

## Before you start

Use Node 22 and this CLI checkout with dependencies installed. Run commands from
the CLI repository. Allow a few minutes and use synthetic files only. Choose a
dedicated registry directory outside the source package, not a shared work folder.
Stop other writers while inspecting or importing; the lock coordinates CLI imports,
not arbitrary filesystem editors.

## Verify and import the first version

```sh
pnpm build
package_demo=$(mktemp -d)
node examples/create-standards-package.mjs "$package_demo/v1" 1.0.0
node dist/cli.js standards verify "$package_demo/v1" --output json
```

The fixture contains a standard YAML, a synthetic SQL/Jinja template and README.
The template is an inspection specimen, not a runnable ingestion pipeline.
Successful output has `result.valid: true`, `result.executable: false`, a file
inventory and `result.digest`. Unknown licence/output terms produce a warning;
they are not silently treated as permission to distribute.

Review the files and copy `result.digest` from the verification output into the
command below. Replace `<reviewed-sha256>` with the complete `sha256:…` value.
It identifies this exact manifest and its file bytes; it is not a secret.

```sh
node dist/cli.js standards import "$package_demo/v1" --registry "$package_demo/registry" --digest '<reviewed-sha256>' --output json
```

Expect `result.imported: true`. Repeating the command with identical bytes returns
`imported: false`, with the same digest. A changed package cannot replace an
existing `id/version`; create a new version and review it separately.

## Retain a second version and inspect an exact release

```sh
node examples/create-standards-package.mjs "$package_demo/v2" 1.1.0
node dist/cli.js standards verify "$package_demo/v2" --output json
node dist/cli.js standards import "$package_demo/v2" --registry "$package_demo/registry" --digest '<second-reviewed-sha256>' --output json
node dist/cli.js standards catalogue "$package_demo/registry" --output json
node dist/cli.js standards verify "$package_demo/registry/synthetic-relational/1.0.0" --digest '<first-reviewed-sha256>' --output json
```

Copy each digest from its corresponding verification result. The catalogue lists
both versions and rechecks their contents. Its ordering is lexical, not a semantic
version upgrade recommendation. No `latest` resolution or automatic upgrade occurs.
The final command verifies the exact first release against the previously reviewed
digest. Keep reviewed digests in trusted Git or another independent approval record,
not only alongside the mutable registry itself.

## Package format and limits

`standards-package.yaml` is the required manifest. Its exact top-level fields are:

| Field                      | Meaning                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `contract`                 | Exactly `ingestron.standards-package/v1`                                                                           |
| `id`, `version`            | Lower-case safe family ID; exact three-part semantic version with optional prerelease, no build metadata or ranges |
| `layer`                    | `organisation`, `infrastructure` or `elt`                                                                          |
| `publisher`                | Declared publisher text, not authenticated identity                                                                |
| `licence`, `outputLicence` | Explicit terms or `NOASSERTION`; declarations are not legal clearance                                              |
| `standard`                 | Path to a recorded standard YAML                                                                                   |
| `files`                    | All payload files, each with `path`, `role`, `digest`, `licence`, `outputLicence`                                  |

Supported file roles are `standard`, `template`, `schema`, `documentation` and
`licence`. The standard must have `apiVersion: ingestron.io/v1alpha1`,
`kind: StandardsPack`, and matching layer and `metadata.id/version`. An optional
[release inventory](standards-release.md) is validated too. Other standard-body
semantics and infrastructure compatibility are not evaluated by this command.

Every payload is hashed as raw bytes. The package digest hashes UTF-8 JSON of
`{manifestDigest, files: [{path, digest}, …]}` with files sorted by path using
lexical code-point order. Manifest whitespace and order therefore affect the
package digest. The manifest is not allowed to list itself. Empty directories are
not part of file identity and are not retained on import.

Limits: 512 payload files plus manifest; 1 MiB per file; 32 MiB total; 2,048
filesystem entries; paths at most 256 characters and 16 segments. Paths use safe
ASCII names and forward slashes, with no traversal, absolute paths, trailing dots,
Windows device names or case-insensitive collisions. Symbolic links, special files,
duplicate declarations, unknown manifest fields, missing hashes and extra files
are rejected. Catalogue listing is capped at 1,024 packages.

## Recover safely

- **Digest mismatch:** stop and compare against the reviewed source. Do not refresh
  a digest simply to bypass the failure.
- **Release conflict:** retain the existing release; publish the intended change
  under a new version. There is no force-overwrite option.
- **Registry locked:** confirm no CLI import is running before touching
  `.ingestron-registry.lock`. After a crash, preserve its `staged` contents if
  needed, then remove that stale lock directory using your file manager. Completed
  releases are outside the lock. Verify the destination release before retrying.
- **Stored package fails catalogue verification:** do not treat other entries as
  a clean catalogue result. Inspect the failed release and compare with a trusted
  original; this command does not automatically repair or delete it.

Imports stage and verify copied bytes before a same-filesystem rename. They never
overwrite an existing non-empty release through the normal CLI workflow. Manual
edits remain possible; this is not a tamper-proof storage service or a transaction
against hostile concurrent writers. Back up trusted sources and approval records.

When finished with this synthetic exercise, remove only the disposable directory
shown by `echo "$package_demo"`, using your file manager. No Azure cleanup is needed.

## Remaining boundaries

Verification is consistency against the supplied manifest and optional trusted
digest, not a signature, malware scan, complete SBOM, licence entitlement or native
workload proof. Templates are stored as inert bytes; nothing is rendered, imported
as JavaScript, executed in a shell or downloaded. Studio catalogue integration,
package-backed compiler selection and safe executable-module packaging remain open.
