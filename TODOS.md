# Strava Hub — Engineering & Product Backlog (TODOS)

This backlog documents agreed-upon feature expansions, architecture enhancements, and commercial capabilities deferred from current sprint plans.

---

## [TODO-001] Direct Strava Bulk ZIP Ingestion
- **What**: Implement pre-signed S3 upload URL and archive extraction Lambda to ingest Strava's bulk account data ZIP export.
- **Why**: Strava API limits (1,000 req/day) prevent full 5–10 year history backfill via REST API. Strava's free bulk export ZIP contains all original `.fit.gz` and `.gpx` files since day 1. Ingesting this directly takes under 30 seconds with 0 Strava API calls.
- **Pros**: Enables true lifetime athlete archive ingestion without rate limit starvation; delivers on the 30-second onboarding vision.
- **Cons**: Requires zip decompression in Lambda and parsing multi-format fit/gpx streams.
- **Context**: S3 pre-signed upload URL -> S3 `ObjectCreated` event -> Parser Lambda -> DynamoDB metadata + S3 raw files.
- **Priority**: P1 | **Effort**: M (human: ~1.5 weeks / CC: ~35 min)
- **Blocked By**: None.

---

## [TODO-002] Stripe Checkout & Customer Billing Portal
- **What**: Stripe Checkout integration (`POST /api/billing/checkout` + Stripe webhook) to monetize lifetime data archive access.
- **Why**: Monetizes the platform for Tier 2 Pro ($35/year or $3.99/month) and Tier 3 Vault Unlock ($29 one-time).
- **Pros**: Generates recurring MRR and captures one-time payments from athletes who reject subscriptions.
- **Cons**: Adds Stripe SDK dependency and webhook handling.
- **Context**: Gated via `Athlete.tier` (`free` vs `pro`). Free tier gets rolling 60-day sync; Pro unlocks automated full backfill, continuous backups, and bulk exports.
- **Priority**: P1 | **Effort**: M (human: ~1.5 weeks / CC: ~30 min)
- **Blocked By**: None (schema groundwork already established in `Athlete.tier`).

---

## [TODO-003] One-Click Portable Archive Exporter (SQLite & Parquet)
- **What**: On-demand packaging endpoint (`POST /user/export`) that generates a self-contained `.sqlite` database and `.parquet` file.
- **Why**: Athletes wanting "better access to their data" want a portable file they can open directly in DuckDB, Datasette, Excel, or Python.
- **Pros**: Delivers ultimate data sovereignty and portability.
- **Cons**: Requires bundling SQLite / Parquet generation libraries in an exporter Lambda.
- **Context**: Packages DynamoDB activity metadata + summary polylines into SQLite schema and returns pre-signed S3 download link.
- **Priority**: P2 | **Effort**: S (human: ~3 days / CC: ~20 min)
- **Blocked By**: None.

---

## [TODO-004] Personal Model Context Protocol (MCP) Server
- **What**: Authenticated Model Context Protocol (MCP) server for Strava Hub enabling Claude and ChatGPT to query athlete training history.
- **Why**: Strava introduced an official MCP server for subscribers; personal AI training analysis is the highest-demand consumer use case.
- **Pros**: Creates a powerful continuous engagement loop that prevents subscription churn.
- **Cons**: Requires maintaining an MCP protocol endpoint and query tools.
- **Context**: Exposes tools `query_activities`, `get_training_summary`, `get_activity_splits` connected to DynamoDB/S3.
- **Priority**: P2 | **Effort**: M (human: ~1 week / CC: ~25 min)
- **Blocked By**: Summary backfill or bulk ZIP ingestion.
