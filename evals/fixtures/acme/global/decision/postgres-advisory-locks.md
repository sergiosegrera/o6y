---
summary: Postgres advisory locks, not Redis locks, for payment dedup
date: 2026-03-01
status: accepted
---
Redis failovers caused double charges (a lock could be lost and re-acquired). Payment dedup uses
Postgres advisory locks, atomic with the payment transaction. Applies to [[note/payments-api]].
