#!/usr/bin/env bash
# CP-MIGRATION-CONTRACT — self-test for scripts/kit/check-migrations-contract.ts (Roxabi/roxabi-boilerplate-cf#257).
#
# `migrations apply --remote` runs before `wrangler deploy`, so the old Worker serves the new
# schema for a while. A migration that removes what live code reads must be the *contract* step of
# expand → deploy → contract, marked `-- kit:contract released=<deployed commit>`. The gate applies
# each chain to SQLite and measures what disappeared. Fixtures live in temp trees only.
set -euo pipefail
# shellcheck source=lib/hermetic-git.sh
source "$(cd "$(dirname "$0")" && pwd -P)/lib/hermetic-git.sh"

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
CHECK="${ROOT}/scripts/kit/check-migrations-contract.ts"
[[ -f "$CHECK" ]] || {
  echo "missing ${CHECK}" >&2
  exit 1
}

PASS=0
FAIL=0
TMP="$(mktemp -d -t migrations-contract.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
M=apps/example-api/migrations

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | cut -d' ' -f1
  else
    shasum -a 256 -- "$1" | cut -d' ' -f1
  fi
}

# new_tree <name> — git repo: example-api with notes(id PK, body, email UNIQUE), an empty register and
# the kit's zero-edit zones (the kit-app list), committed as the "released" base. Prints the tree path.
new_tree() {
  local t="${TMP}/$1"
  mkdir -p "$t/$M" "$t/config/kit"
  printf 'name = "example-api"\n[[d1_databases]]\nbinding = "DB"\n' >"$t/apps/example-api/wrangler.toml"
  printf 'CREATE TABLE "notes" ("id" text PRIMARY KEY, "body" text, "email" text UNIQUE);\nCREATE VIEW "v_notes" AS SELECT "id" FROM "notes";\n' >"$t/$M/0001_init.sql"
  : >"$t/config/kit/migrations-contract-grandfathered.txt"
  cp "${ROOT}/config/kit/zero-edit-zones.json" "$t/config/kit/zero-edit-zones.json"
  git init -q -b main "$t"
  git -C "$t" config user.email kit@example.com
  git -C "$t" config user.name kit
  git -C "$t" config commit.gpgsign false
  git -C "$t" add -A
  git -C "$t" commit -q -m base
  printf '%s\n' "$t"
}

plant() {
  mkdir -p "$(dirname "$1/$2")"
  printf '%s\n' "$3" >"$1/$2"
}

# Marked contract for the no-baseline snapshot cases (Roxabi/roxabi-boilerplate-cf#591).
UNKNOWN_SHA=0123456789abcdef0123456789abcdef01234567
marked_drop() {
  printf '%s\n' "-- kit:contract released=${1}" 'DROP VIEW "v_notes";' 'DROP TABLE "notes";'
}

fixture_ko() {
  echo "FAIL: $1" >&2
  FAIL=$((FAIL + 1))
}

# expect <name> <0|1> <tree> [text that must appear in the output]
expect() {
  local name="$1" want="$2" tree="$3" marker="${4:-}" out rc=0
  out="$(MIGRATIONS_CONTRACT_ROOT="$tree" bun "$CHECK" 2>&1)" || rc=$?
  if [[ "$rc" -eq "$want" && ( -z "$marker" || "$out" == *"$marker"* ) ]]; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (want rc=$want${marker:+ and '$marker'}, got rc=$rc)" >&2
    echo "$out" >&2
    FAIL=$((FAIL + 1))
  fi
}

# case_sql <name> <want> <sql> [marker] — one new 0002 migration in a fresh tree.
case_sql() {
  local t
  t="$(new_tree "$1")"
  plant "$t" "$M/0002_change.sql" "$3"
  expect "$1" "$2" "$t" "${4:-}"
}

echo "== migrations contract self-test =="

case_sql "additive-only migration passes" 0 'ALTER TABLE "notes" ADD COLUMN "title" text;
CREATE INDEX "notes_title" ON "notes" ("title");'
case_sql "DROP TABLE fails" 1 'DROP TABLE IF EXISTS "notes";' "table notes is gone"
case_sql "DROP COLUMN fails" 1 'ALTER TABLE `notes` DROP COLUMN `body`;' "column notes.body is gone"
case_sql "RENAME COLUMN fails" 1 'ALTER TABLE notes RENAME COLUMN body TO text;' "column notes.body is gone"
case_sql "renaming a live table fails" 1 'ALTER TABLE "notes" RENAME TO "memos";' "table notes is gone"
case_sql "DROP VIEW fails" 1 'DROP VIEW "v_notes";' "view v_notes is gone"
case_sql "dropping a UNIQUE constraint (rebuild) fails" 1 'CREATE TABLE "n2" ("id" text PRIMARY KEY, "body" text, "email" text);
INSERT INTO "n2" SELECT * FROM "notes";
DROP VIEW "v_notes";
DROP TABLE "notes";
ALTER TABLE "n2" RENAME TO "notes";
CREATE VIEW "v_notes" AS SELECT "id" FROM "notes";' "UNIQUE(email) on notes is gone"
case_sql "SQLite table rebuild fails" 1 'CREATE TABLE "notes_new" ("id" text PRIMARY KEY, "body" text NOT NULL, "email" text UNIQUE);
INSERT INTO "notes_new" SELECT * FROM "notes";
DROP VIEW "v_notes";
DROP TABLE "notes";
ALTER TABLE "notes_new" RENAME TO "notes";
CREATE VIEW "v_notes" AS SELECT "id" FROM "notes";' "table notes was rebuilt"
case_sql "a table created and dropped in the same migration passes" 0 'CREATE TABLE "__guard" ("x" integer);
INSERT INTO "__guard" VALUES (1);
DROP TABLE "__guard";
ALTER TABLE "notes" ADD COLUMN "flag" integer;'
case_sql "destructive DDL inside comments passes" 0 '-- To undo: ALTER TABLE "notes" DROP COLUMN "title";
/* DROP TABLE "notes"; */
ALTER TABLE "notes" ADD COLUMN "title" text;'
case_sql "a destructive statement after a comment line fails" 1 '-- retire the legacy column
ALTER TABLE "notes" DROP COLUMN "body";' "column notes.body is gone"

# Shapes that fooled the text-matching version: measured, they are all destructive.
case_sql "CREATE IF NOT EXISTS then DROP of a live table fails" 1 'CREATE TABLE IF NOT EXISTS notes (x);
DROP VIEW v_notes;
DROP TABLE notes;' "table notes is gone"
case_sql "a TEMP shadow does not hide dropping the live table" 1 'CREATE TEMP TABLE notes (a);
DROP TABLE notes;
DROP VIEW v_notes;
DROP TABLE notes;' "table notes is gone"
case_sql "schema-qualified, single-quoted and unspaced names are caught" 1 'DROP VIEW "main"."v_notes";
ALTER TABLE'"'"'notes'"'"'DROP COLUMN"body";' "column notes.body is gone"
case_sql "string literals with -- or ; do not hide a DROP" 1 'CREATE TABLE "log" ("m" text);
INSERT INTO "log" VALUES ('"'"'a--b; CREATE TABLE notes (x)'"'"');
DROP VIEW "v_notes";
DROP TABLE "notes";' "table notes is gone"
t="$(new_tree unique-index)"
plant "$t" "$M/0002_idx.sql" 'CREATE UNIQUE INDEX "notes_body_u" ON "notes" ("body");'
git -C "$t" add -A
git -C "$t" commit -q -m idx
plant "$t" "$M/0003_drop_idx.sql" 'DROP INDEX "notes_body_u";'
expect "dropping a UNIQUE index fails" 1 "$t" "UNIQUE(body) on notes is gone"
case_sql "a migration SQLite cannot apply fails closed" 1 'ALTER TABLE "missing" ADD COLUMN "x" text;' "cannot be applied"
# Each file runs in one transaction, as D1 applies it: a runtime error mid-file is not swallowed.
case_sql "a runtime error before the last statement fails closed" 1 'INSERT INTO "notes" VALUES ('"'"'1'"'"', '"'"'a'"'"', '"'"'x'"'"');
INSERT INTO "notes" VALUES ('"'"'2'"'"', '"'"'b'"'"', '"'"'x'"'"');
ALTER TABLE "notes" ADD COLUMN "title" text;' "cannot be applied"
t="$(new_tree fk-defer)"
plant "$t" "$M/0002_fk.sql" 'CREATE TABLE "parent" ("id" integer PRIMARY KEY, "n" text);
CREATE TABLE "child" ("id" integer PRIMARY KEY, "pid" integer REFERENCES "parent" ("id"));'
plant "$t" "$M/0003_drop.sql" 'PRAGMA defer_foreign_keys = ON;
INSERT INTO "parent" VALUES (1, NULL);
INSERT INTO "child" VALUES (1, 1);
DROP TABLE "parent";
PRAGMA defer_foreign_keys = OFF;'
expect "a deferred-FK DROP TABLE is measured, not swallowed" 1 "$t" "table parent is gone"
plant "$t" "$M/0003_drop.sql" 'INSERT INTO "parent" VALUES (1, NULL);
INSERT INTO "child" VALUES (1, 1);
PRAGMA defer_foreign_keys = true;
CREATE TABLE "parent_new" ("id" integer PRIMARY KEY, "n" text NOT NULL DEFAULT '"'"''"'"');
INSERT INTO "parent_new" SELECT "id", coalesce("n", '"'"''"'"') FROM "parent";
DROP TABLE "parent";
ALTER TABLE "parent_new" RENAME TO "parent";
PRAGMA defer_foreign_keys = false;'
expect "the D1-documented rebuild with a seeded child applies and is judged a rebuild" 1 "$t" "table parent was rebuilt"
case_sql "narrowing a view fails" 1 'DROP VIEW "v_notes";
CREATE VIEW "v_notes" AS SELECT "body" FROM "notes";' "column v_notes.id is gone"
case_sql "a column dropped and re-added with another type fails" 1 'ALTER TABLE "notes" DROP COLUMN "body";
ALTER TABLE "notes" ADD COLUMN "body" integer;' "column notes.body changed"
t="$(new_tree d1-prefixed)"
plant "$t" "$M/0002_d1.sql" 'CREATE TABLE "d1_sessions" ("id" text);'
plant "$t" "$M/0003_drop.sql" 'DROP TABLE "d1_sessions";'
expect "dropping a user table named d1_* fails" 1 "$t" "table d1_sessions is gone"
t="$(new_tree nested-config)"
mkdir -p "$t/apps/acme-api/cron"
printf 'name = "acme-cron"\n[[d1_databases]]\nbinding = "DB"\n' >"$t/apps/acme-api/cron/wrangler.toml"
plant "$t" "apps/acme-api/cron/migrations/0001_init.sql" 'CREATE TABLE "jobs" ("id" text);'
plant "$t" "apps/acme-api/cron/migrations/0002_drop.sql" 'DROP TABLE "jobs";'
expect "a nested wrangler config's migrations are checked" 1 "$t" "apps/acme-api/cron/migrations/0002_drop.sql"

# The contract marker: released=<commit> deployed before this migration existed.
t="$(new_tree marked)"
base="$(git -C "$t" rev-parse HEAD)"
git -C "$t" update-ref refs/remotes/origin/deploy/main "$base"
plant "$t" "$M/0002_drop.sql" "-- kit:contract released=${base}
DROP VIEW \"v_notes\";
DROP TABLE \"notes\";"
expect "destructive migration marked with a deployed release passes" 0 "$t"

plant "$t" "$M/0002_drop.sql" '-- kit:contract released=<ref>
DROP VIEW "v_notes";
DROP TABLE "notes";'
expect "a placeholder released= fails" 1 "$t" "not a full 40-hex commit sha"

plant "$t" "$M/0002_drop.sql" '-- kit:contract released=HEAD~1
DROP VIEW "v_notes";
DROP TABLE "notes";'
expect "a moving ref as released= fails" 1 "$t" "not a full 40-hex commit sha"

plant "$t" "$M/0002_drop.sql" '-- kit:contract released=0123456789abcdef0123456789abcdef01234567
DROP VIEW "v_notes";
DROP TABLE "notes";'
expect "an unknown released= fails" 1 "$t" "does not resolve"

plant "$t" "$M/0002_drop.sql" '-- kit:contract
ALTER TABLE "notes" ADD COLUMN "title" text;'
expect "a marker without released= fails even on an additive file" 1 "$t" "needs released="

plant "$t" "$M/0002_drop.sql" "-- kit:contract released=${base}
DROP VIEW \"v_notes\";
DROP TABLE \"notes\";"
git -C "$t" add -A
git -C "$t" commit -q -m same-push
head="$(git -C "$t" rev-parse HEAD)"
sed -i.bak "s/released=${base}/released=${head}/" "$t/$M/0002_drop.sql"
rm -f "$t/$M/0002_drop.sql.bak"
expect "released= naming the commit that adds the migration fails" 1 "$t" "already contains"

t="$(new_tree not-deployed)"
base="$(git -C "$t" rev-parse HEAD)"
git -C "$t" update-ref refs/remotes/origin/deploy/main "$base"
plant "$t" "other.txt" "x"
git -C "$t" add -A
git -C "$t" commit -q -m undeployed
undeployed="$(git -C "$t" rev-parse HEAD)"
plant "$t" "$M/0002_drop.sql" "-- kit:contract released=${undeployed}
DROP VIEW \"v_notes\";
DROP TABLE \"notes\";"
expect "released= a commit never deployed fails" 1 "$t" "not deployed on origin/deploy/main"

# Every environment that applies the file must run the release first: a staging train is not enough.
git -C "$t" update-ref refs/remotes/origin/deploy/staging "$undeployed"
expect "released= deployed on staging only fails" 1 "$t" "not deployed on origin/deploy/main"
git -C "$t" update-ref refs/remotes/origin/deploy/main "$undeployed"
expect "released= deployed on every deploy branch passes" 0 "$t"

# Before the Deploy gate cutover, Cloudflare builds origin/main (and origin/staging): same-push fails.
t="$(new_tree pre-cutover)"
base="$(git -C "$t" rev-parse HEAD)"
git -C "$t" update-ref refs/remotes/origin/main "$base"
plant "$t" "other.txt" "code stops reading notes"
git -C "$t" add -A
git -C "$t" commit -q -m code
code="$(git -C "$t" rev-parse HEAD)"
plant "$t" "$M/0002_drop.sql" "-- kit:contract released=${code}
DROP VIEW \"v_notes\";
DROP TABLE \"notes\";"
expect "pre-cutover: released= in the same push as the contract fails" 1 "$t" "not deployed on origin/main"
git -C "$t" update-ref refs/remotes/origin/staging "$code"
git -C "$t" update-ref refs/remotes/origin/main "$code"
expect "pre-cutover: released= already on origin/main and origin/staging passes" 0 "$t"
git -C "$t" update-ref -d refs/remotes/origin/main
git -C "$t" update-ref -d refs/remotes/origin/staging
expect "released= with no deploy branch nor origin/main fails closed" 1 "$t" "cannot be checked"

# A contract already on every deploy branch is applied: it is not re-judged against the branches.
git -C "$t" add -A
git -C "$t" commit -q -m contract
git -C "$t" update-ref refs/remotes/origin/deploy/main HEAD
git -C "$t" switch -q -c side "$base"
plant "$t" "side.txt" "x"
git -C "$t" add -A
git -C "$t" commit -q -m side
side="$(git -C "$t" rev-parse HEAD)"
git -C "$t" switch -q main
sed -i.bak "s/released=${code}/released=${side}/" "$t/$M/0002_drop.sql"
rm -f "$t/$M/0002_drop.sql.bak"
git -C "$t" commit -q -am cherry
git -C "$t" update-ref refs/remotes/origin/deploy/main HEAD
expect "a contract already on every deploy branch is not re-judged" 0 "$t"

# In a product, a kit app's contract was judged in the kit: its released= is not a product commit.
t="$(new_tree product-kit-contract)"
git -C "$t" update-ref refs/remotes/origin/deploy/main HEAD
plant "$t" "$M/0002_drop.sql" '-- kit:contract released=0123456789abcdef0123456789abcdef01234567
DROP VIEW "v_notes";
DROP TABLE "notes";'
expect "kit repo: a kit contract naming an unknown release fails" 1 "$t" "does not resolve"
plant "$t" "config/product/inheritance.json" '{"version":1}'
expect "product: a kit app's marked contract passes without its kit release" 0 "$t"
plant "$t" "$M/0002_drop.sql" 'DROP VIEW "v_notes";
DROP TABLE "notes";'
expect "product: an unmarked destructive kit app migration still fails" 1 "$t" "table notes is gone"

# Grandfathered = applied migrations pinned by path + sha256.
t="$(new_tree grandfathered)"
plant "$t" "$M/0002_legacy.sql" 'DROP VIEW "v_notes";
DROP TABLE "notes";'
printf '%s %s\n' "$M/0002_legacy.sql" "$(sha256_of "$t/$M/0002_legacy.sql")" >"$t/config/kit/migrations-contract-grandfathered.txt"
expect "grandfathered migration (path + sha256) passes" 0 "$t"
printf '%s\n' '-- edited' >>"$t/$M/0002_legacy.sql"
expect "an edited grandfathered migration fails" 1 "$t" "an applied migration was edited"
printf '%s\n' "$M/0002_legacy.sql not-a-sha" >"$t/config/kit/migrations-contract-grandfathered.txt"
expect "a malformed register line is a config error" 1 "$t" "config error"

# Product apps: every wrangler form is read, the product register takes product paths only.
t="$(new_tree product)"
mkdir -p "$t/apps/acme-api/db" "$t/apps/acme-web/sql"
printf 'name = "acme-api"\n[env.production]\nd1_databases = [{ binding = "DB", migrations_dir = '"'"'db'"'"' }]\n' >"$t/apps/acme-api/wrangler.toml"
printf '{ // product web worker\n  "d1_databases": [{ "binding": "DB", "migrations_dir": "sql" }]\n}\n' >"$t/apps/acme-web/wrangler.jsonc"
plant "$t" "apps/acme-api/db/1000_init.sql" 'CREATE TABLE "legacy_items" ("id" text);'
plant "$t" "apps/acme-api/db/1001_drop.sql" 'DROP TABLE "legacy_items";'
plant "$t" "apps/acme-web/sql/1000_init.sql" 'CREATE TABLE "a" ("id" text);'
plant "$t" "apps/acme-web/sql/1001_drop.sql" 'DROP TABLE "a";'
expect "product migrations (single-quoted TOML, inline table) fail unmarked" 1 "$t" "apps/acme-api/db/1001_drop.sql"
expect "product migrations (wrangler.jsonc) fail unmarked" 1 "$t" "apps/acme-web/sql/1001_drop.sql"
mkdir -p "$t/config/product"
{
  printf '%s %s\n' "apps/acme-api/db/1001_drop.sql" "$(sha256_of "$t/apps/acme-api/db/1001_drop.sql")"
  printf '%s %s\n' "apps/acme-web/sql/1001_drop.sql" "$(sha256_of "$t/apps/acme-web/sql/1001_drop.sql")"
} >"$t/config/product/migrations-contract-grandfathered.txt"
expect "product register grandfathers applied product migrations" 0 "$t"
printf '%s %s\n' "$M/0001_init.sql" "$(sha256_of "$t/$M/0001_init.sql")" >>"$t/config/product/migrations-contract-grandfathered.txt"
expect "product register naming a kit path is a config error" 1 "$t" "config/product/migrations-contract-grandfathered.txt"

# Roxabi/roxabi-boilerplate-cf#318: the kit register takes kit app paths only. A product pin there escaped the product's own
# register check (the product cannot edit config/kit/) and was grandfathered anyway.
printf '%s %s\n' "apps/acme-api/db/1001_drop.sql" "$(sha256_of "$t/apps/acme-api/db/1001_drop.sql")" \
  >"$t/config/product/migrations-contract-grandfathered.txt"
printf '%s %s\n' "apps/acme-web/sql/1001_drop.sql" "$(sha256_of "$t/apps/acme-web/sql/1001_drop.sql")" \
  >"$t/config/kit/migrations-contract-grandfathered.txt"
expect "kit register naming a product app path is a config error" 1 "$t" \
  "config/kit/migrations-contract-grandfathered.txt:1: apps/acme-web/sql/1001_drop.sql is not a kit app path"

# RC-3: kit apps are the zero-edit protected_prefixes, not a name pattern. A product app named
# example-* is a product app: neither the kit register nor the product-mode released= skip covers it.
t="$(new_tree example-named-product)"
git -C "$t" update-ref refs/remotes/origin/deploy/main HEAD
plant "$t" "config/product/inheritance.json" '{"version":1}'
mkdir -p "$t/apps/example-acme-api/migrations"
printf 'name = "example-acme-api"\n[[d1_databases]]\nbinding = "DB"\n' >"$t/apps/example-acme-api/wrangler.toml"
plant "$t" "apps/example-acme-api/migrations/0001_init.sql" 'CREATE TABLE "jobs" ("id" text);'
plant "$t" "apps/example-acme-api/migrations/0002_drop.sql" 'DROP TABLE "jobs";'
printf '%s %s\n' "apps/example-acme-api/migrations/0002_drop.sql" \
  "$(sha256_of "$t/apps/example-acme-api/migrations/0002_drop.sql")" >"$t/config/kit/migrations-contract-grandfathered.txt"
expect "kit register naming an example-* product app is a config error" 1 "$t" \
  "apps/example-acme-api/migrations/0002_drop.sql is not a kit app path"
: >"$t/config/kit/migrations-contract-grandfathered.txt"
plant "$t" "apps/example-acme-api/migrations/0002_drop.sql" '-- kit:contract released=0123456789abcdef0123456789abcdef01234567
DROP TABLE "jobs";'
expect "product: an example-* product app's released= is still judged" 1 "$t" "does not resolve"
rm "$t/config/kit/zero-edit-zones.json"
expect "missing zero-edit zones fail closed" 1 "$t" "config error: config/kit/zero-edit-zones.json"

t="$(new_tree broken-wrangler)"
printf 'd1_databases = [\n' >"$t/apps/example-api/wrangler.toml"
expect "an unparseable wrangler config fails closed" 1 "$t" "unparseable"

# A kit-schema-sync copy (4-line header + kit bytes) of a catalog module is judged at the kit source.
t="$(new_tree kit-module-copy)"
mkdir -p "$t/apps/acme-api/migrations"
plant "$t" "apps/acme-api/migrations/0001_kit_init.sql" 'CREATE TABLE "api_keys" ("id" text, "org" text);'
printf 'DROP TABLE "api_keys";\n' >"${TMP}/kit-source.sql"
{
  printf -- '-- kit-schema: api_keys_rebuild\n-- kit-sha256: %s\n-- kit-source: apps/example-api/migrations/0015_x.sql\n' "$(sha256_of "${TMP}/kit-source.sql")"
  printf -- '-- Do not edit this file. Kit changes ship as a new module id.\n\n'
  cat "${TMP}/kit-source.sql"
} >"$t/apps/acme-api/migrations/0002_kit_api_keys_rebuild.sql"
printf '{"version":1,"modules":[{"id":"api_keys_rebuild","file":"0015_x.sql","kitSha256":"%s"}]}\n' \
  "$(sha256_of "${TMP}/kit-source.sql")" >"$t/config/kit/kit-schema-modules.json"
expect "a headed kit-schema-sync copy of a catalog module passes" 0 "$t"
printf '%s\n' '-- product edit' >>"$t/apps/acme-api/migrations/0002_kit_api_keys_rebuild.sql"
expect "an edited kit module copy is judged like any product migration" 1 "$t" "0002_kit_api_keys_rebuild.sql"

# The starter is a kit app, but its canonical headed copies are judged at the kit source.
t="$(new_tree starter-kit-module-copy)"
mkdir -p "$t/apps/starter-api/migrations"
printf 'name = "starter-api"\n[[d1_databases]]\nbinding = "DB"\n' >"$t/apps/starter-api/wrangler.toml"
plant "$t" "apps/starter-api/migrations/0001_init.sql" 'CREATE TABLE "api_keys" ("id" text, "org" text);'
printf '{"version":1,"modules":[{"id":"api_keys_rebuild","file":"0015_x.sql","kitSha256":"%s"}]}\n' \
  "$(sha256_of "${TMP}/kit-source.sql")" >"$t/config/kit/kit-schema-modules.json"
{
  printf -- '-- kit-schema: api_keys_rebuild\n-- kit-sha256: %s\n-- kit-source: apps/example-api/migrations/0015_x.sql\n' "$(sha256_of "${TMP}/kit-source.sql")"
  printf -- '-- Do not edit this file. Kit changes ship as a new module id.\n\n'
  cat "${TMP}/kit-source.sql"
} >"$t/apps/starter-api/migrations/0002_kit_api_keys_rebuild.sql"
expect "starter: headed catalog copy passes" 0 "$t"
printf '%s\n' '-- edited' >>"$t/apps/starter-api/migrations/0002_kit_api_keys_rebuild.sql"
expect "starter: edited payload is judged" 1 "$t" "0002_kit_api_keys_rebuild.sql"
cp "${TMP}/kit-source.sql" "$t/apps/starter-api/migrations/0002_kit_api_keys_rebuild.sql"
expect "starter: unheaded catalog bytes are judged" 1 "$t" "0002_kit_api_keys_rebuild.sql"
{
  printf '%s\n\n' '-- kit-schema: api_keys_rebuild' '-- malformed header'
  cat "${TMP}/kit-source.sql"
} >"$t/apps/starter-api/migrations/0002_kit_api_keys_rebuild.sql"
expect "starter: malformed header is judged" 1 "$t" "0002_kit_api_keys_rebuild.sql"

t="$(new_tree kit-source-in-catalog)"
plant "$t" "$M/0002_drop.sql" 'DROP VIEW "v_notes";'
printf '{"version":1,"modules":[{"id":"x","file":"0002_drop.sql","kitSha256":"%s"}]}\n' \
  "$(sha256_of "$t/$M/0002_drop.sql")" >"$t/config/kit/kit-schema-modules.json"
expect "a kit source module is checked even though the catalog lists it" 1 "$t" "view v_notes is gone"
{
  printf -- '-- kit-schema: x\n-- kit-sha256: %s\n-- kit-source: apps/example-api/migrations/0002_drop.sql\n' "$(sha256_of "$t/$M/0002_drop.sql")"
  printf -- '-- Do not edit this file. Kit changes ship as a new module id.\n\n'
  cat "$t/$M/0002_drop.sql"
} >"${TMP}/headed-kit-source.sql"
cp "${TMP}/headed-kit-source.sql" "$t/$M/0002_drop.sql"
expect "a headed copy in another kit app remains independently checked" 1 "$t" "view v_notes is gone"


# Roxabi/roxabi-boilerplate-cf#591 — empty baseline is an initial snapshot only when the raw
# worktree bytes match a reachable parentless commit. Not a deploy proof.
t="$(new_tree snapshot-root)"
plant "$t" "$M/0002_drop.sql" "$(marked_drop "$UNKNOWN_SHA")"
git -C "$t" add -A
git -C "$t" commit -q --amend -m root
expect "snapshot: marked destructive file in the parentless root passes" 0 "$t"
plant "$t" "apps/example-api/src/extra.ts" 'export const extra = 1'
git -C "$t" add -A
git -C "$t" commit -q -m code-only
expect "snapshot: a code-only descendant of that root still passes" 0 "$t"

t="$(new_tree snapshot-missing-marker)"
plant "$t" "$M/0002_drop.sql" 'DROP VIEW "v_notes";
DROP TABLE "notes";'
git -C "$t" add -A
git -C "$t" commit -q --amend -m root
expect "snapshot: missing marker still fails" 1 "$t" "table notes is gone"

t="$(new_tree snapshot-malformed-marker)"
plant "$t" "$M/0002_drop.sql" '-- kit:contract released=<ref>
DROP VIEW "v_notes";
DROP TABLE "notes";'
git -C "$t" add -A
git -C "$t" commit -q --amend -m root
expect "snapshot: a non-sha released= still fails" 1 "$t" "not a full 40-hex"

t="$(new_tree snapshot-already-contains)"
plant "$t" "$M/0002_drop.sql" "$(marked_drop "$UNKNOWN_SHA")"
git -C "$t" add -A
git -C "$t" commit -q --amend -m root
root="$(git -C "$t" rev-parse HEAD)"
plant "$t" "$M/0002_drop.sql" "$(marked_drop "$root")"
git -C "$t" add -A
git -C "$t" commit -q --amend -m root
expect "snapshot: released= naming a commit that already contains the file fails" 1 "$t" "already contains"

# Clean filter strips DIRTY on add and on hash-object, not on hash-object --no-filters.
t="$(new_tree snapshot-dirty-filter)"
printf '%s\n' '*.sql filter=sqlnorm' >"$t/.gitattributes"
git -C "$t" config filter.sqlnorm.clean "sed 's/DIRTY//g'"
plant "$t" "$M/0002_drop.sql" "-- kit:contract released=${UNKNOWN_SHA}
DROP VIEW \"v_notes\";
DROP TABLE \"notes\";
-- DIRTY"
git -C "$t" add -A
git -C "$t" commit -q --amend -m root
root_blob="$(git -C "$t" rev-parse "HEAD:$M/0002_drop.sql")"
filtered="$(git -C "$t" hash-object -- "$M/0002_drop.sql")"
raw="$(git -C "$t" hash-object --no-filters -- "$M/0002_drop.sql")"
if [[ "$filtered" == "$root_blob" && "$raw" != "$root_blob" ]]; then
  echo "PASS: clean filter normalizes dirty SQL to the root blob"
  PASS=$((PASS + 1))
else
  fixture_ko "clean filter fixture (filtered=${filtered} raw=${raw} root=${root_blob})"
fi
expect "snapshot: dirty SQL a clean filter would normalize still fails" 1 "$t" "cannot be checked"

t="$(new_tree snapshot-later)"
plant "$t" "$M/0002_drop.sql" "$(marked_drop "$UNKNOWN_SHA")"
git -C "$t" add -A
git -C "$t" commit -q -m contract
expect "snapshot: a marked destructive file added after the root fails closed" 1 "$t" "cannot be checked"

src="$(new_tree shallow-src)"
plant "$src" "$M/0002_drop.sql" "$(marked_drop "$UNKNOWN_SHA")"
git -C "$src" add -A
git -C "$src" commit -q -m contract
shallow="${TMP}/shallow-non-root"
git clone -q --depth 1 --no-local "file://${src}" "$shallow"
git -C "$shallow" remote remove origin
if [[ "$(git -C "$shallow" rev-parse --is-shallow-repository)" != true ]]; then
  fixture_ko "shallow fixture is not shallow"
fi
if [[ -n "$(git -C "$shallow" for-each-ref --format='%(refname)' refs/remotes)" ]]; then
  fixture_ko "shallow fixture still has remote-tracking refs"
fi
if ! git -C "$shallow" --no-replace-objects cat-file commit HEAD | awk 'BEGIN{p=0} /^$/{exit} /^parent /{p=1} END{exit !p}'; then
  fixture_ko "shallow tip object has no parent header"
fi
expect "snapshot: a shallow non-root does not waive" 1 "$shallow" "cannot be checked"

t="$(new_tree snapshot-unreachable)"
plant "$t" "$M/0002_drop.sql" "$(marked_drop "$UNKNOWN_SHA")"
git -C "$t" add -A
git -C "$t" commit -q -m contract
hidden="$(git -C "$t" commit-tree 'HEAD^{tree}' -m hidden-root)"
git -C "$t" update-ref refs/heads/hidden "$hidden"
if ! git -C "$t" cat-file -e "${hidden}^{commit}"; then
  fixture_ko "unreachable root object is missing"
fi
if git -C "$t" merge-base --is-ancestor "$hidden" HEAD; then
  fixture_ko "hidden root is reachable from HEAD"
fi
expect "snapshot: an unreachable matching root does not waive" 1 "$t" "cannot be checked"

t="$(new_tree snapshot-graft)"
plant "$t" "$M/0002_drop.sql" "$(marked_drop "$UNKNOWN_SHA")"
git -C "$t" add -A
git -C "$t" commit -q --amend -m root
root="$(git -C "$t" rev-parse HEAD)"
plant "$t" "apps/example-api/src/extra.ts" 'export const extra = 1'
git -C "$t" add -A
git -C "$t" commit -q -m code-only
mkdir -p "$t/.git/info"
printf '%s %s\n' "$(git -C "$t" rev-parse HEAD)" "$root" >"$t/.git/info/grafts"
if [[ "$(git -C "$t" rev-list --max-parents=0 HEAD)" != "$root" ]]; then
  fixture_ko "grafted walk does not expose the matching actual root"
fi
expect "snapshot: an active graft does not waive" 1 "$t" "cannot be checked"

t="$(new_tree snapshot-replace)"
plant "$t" "$M/0002_drop.sql" "$(marked_drop "$UNKNOWN_SHA")"
git -C "$t" add -A
git -C "$t" commit -q --amend -m root
empty="$(git -C "$t" mktree </dev/null)"
repl="$(git -C "$t" commit-tree "$empty" -m replace)"
git -C "$t" replace HEAD "$repl"
if [[ -z "$(git -C "$t" for-each-ref --format='%(refname)' refs/replace)" ]]; then
  fixture_ko "replace fixture created no refs/replace"
fi
expect "snapshot: an active replace ref does not waive" 1 "$t" "cannot be checked"

t="$(new_tree snapshot-baseline-lacks-file)"
plant "$t" "$M/0002_drop.sql" "$(marked_drop "$UNKNOWN_SHA")"
git -C "$t" add -A
git -C "$t" commit -q --amend -m root
empty="$(git -C "$t" mktree </dev/null)"
other="$(git -C "$t" commit-tree "$empty" -m other)"
git -C "$t" update-ref refs/remotes/origin/main "$other"
if git -C "$t" cat-file -e "refs/remotes/origin/main:$M/0002_drop.sql" 2>/dev/null; then
  fixture_ko "baseline fixture contains the migration"
fi
expect "snapshot: a baseline that lacks the file does not waive" 1 "$t" "does not resolve"
echo "migrations contract self-test: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
