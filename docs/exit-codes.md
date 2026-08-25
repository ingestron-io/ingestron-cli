# Machine output and exit codes

`--output json` emits exactly one `ingestron.cli-output/v1` envelope. Human text
is not a machine contract.

| Exit | Meaning                                                          |
| ---: | ---------------------------------------------------------------- |
|    0 | Success                                                          |
|    2 | Usage, config, recipe, contract, package or version check failed |
|    3 | Explicit confirmation is required                                |
|    4 | Azure CLI, identity, deployment or runtime check failed          |
|    5 | Bundle/artefact tamper, cost, drift, ownership or teardown gate  |
|   10 | Unexpected internal failure                                      |
