---
summary: Ledger integration tests are flaky in parallel; run with --runInBand
tags: [gotcha]
related: [note/ledger]
---
The [[note/ledger]] integration tests fail intermittently when run in parallel. Run them with `--runInBand`.
