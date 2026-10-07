# Source snapshot

- Source environment: isolated legacy API deployment server
- Source component: `/legacy-api`
- Retrieval mode: read-only SSH/SCP
- Snapshot date: 2026-07-31
- Git metadata: source deployment directory had no `.git`

Excluded before transfer:

- `.env` and environment variants
- keys, certificates, tokens and credential files
- `data`, `uploads`, reports, customer material and databases
- logs, caches, temporary files and `node_modules`

The snapshot inventory was checked for private-key/API-key patterns after transfer.
No production secret was copied. Runtime data and customer reports are not part of
this local working copy.
