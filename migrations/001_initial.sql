-- Migration 001 is executed idempotently by src/db.js.
-- The authoritative schema uses STRICT tables, WAL, scaled signed 64-bit integers,
-- half-open query windows, and stable per-market source-key uniqueness.
-- Inspect live schema with: sqlite3 data/skyterminal.db '.schema'
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
-- See the SQL constant in src/db.js; schema_migrations version 1 records application.
