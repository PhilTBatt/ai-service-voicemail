#!/usr/bin/env bash
# The restore drill (BUILD_PLAN Step 14): "restore a production backup to a scratch server once,
# and record how long it took." Used by .github/workflows/deploy.yml (step "restore-drill").
# Needs RESOURCE_GROUP and an Azure sign-in that may create servers in it.
#
# 1. Restores the live database server, as it is now, to a new scratch server. Microsoft's docs
#    (read 2026-11-11): a restore always makes a new server and never touches the old one;
#    firewall rules and server parameters aren't copied; it takes "a few minutes up to a few
#    hours".
# 2. Gives the scratch server a fresh admin password of its own and opens it to this runner
#    only, then checks the copy: the newest migration, the businesses and calls, and the three
#    logins the app uses.
# 3. Deletes the scratch server, whatever happened above: it's charged until it's gone.
# Nothing here reads or changes the live server's data, password or firewall.
set -euo pipefail

source_server="$(az postgres flexible-server list --resource-group "$RESOURCE_GROUP" \
  --query "[?!contains(name, '-drill-')].name | [0]" --output tsv)"
if [ -z "$source_server" ]; then
  echo "::error::No database server found in $RESOURCE_GROUP"
  exit 1
fi
drill="${source_server}-drill-${GITHUB_RUN_NUMBER:-0}"

cleanup() {
  echo "Deleting the scratch server $drill"
  if ! az postgres flexible-server delete --resource-group "$RESOURCE_GROUP" --name "$drill" \
    --yes --output none 2>/dev/null; then
    if az postgres flexible-server show --resource-group "$RESOURCE_GROUP" --name "$drill" \
      --output none 2>/dev/null; then
      echo "::error::Couldn't delete $drill. Delete it by hand (Azure portal, $RESOURCE_GROUP): it's charged until it's gone."
    fi
  fi
}
trap cleanup EXIT

started="$(date +%s)"
echo "Restoring $source_server, as it is now, to $drill"
az postgres flexible-server restore --resource-group "$RESOURCE_GROUP" --name "$drill" \
  --source-server "$source_server" --output none
finished="$(date +%s)"
minutes=$(( (finished - started + 59) / 60 ))
echo "The restore took about $minutes minutes"

# Its own admin password, made here and never shown, so nothing depends on the live one's.
password="$(openssl rand -hex 24)"
echo "::add-mask::$password"
az postgres flexible-server update --resource-group "$RESOURCE_GROUP" --name "$drill" \
  --admin-password "$password" --output none
runner_ip="$(curl --silent --fail --max-time 15 https://api.ipify.org)"
az postgres flexible-server firewall-rule create --resource-group "$RESOURCE_GROUP" \
  --server-name "$drill" --name drill-runner \
  --start-ip-address "$runner_ip" --end-ip-address "$runner_ip" --output none
host="$(az postgres flexible-server show --resource-group "$RESOURCE_GROUP" --name "$drill" \
  --query fullyQualifiedDomainName --output tsv)"

command -v psql >/dev/null || sudo apt-get install --yes --quiet postgresql-client >/dev/null
export PGPASSWORD="$password"
admin_login="$(az postgres flexible-server show --resource-group "$RESOURCE_GROUP" \
  --name "$drill" --query administratorLogin --output tsv)"
query() {
  psql "host=$host port=5432 dbname=callmate user=$admin_login sslmode=require" \
    --no-psqlrc --tuples-only --no-align --quiet -c "$1"
}

# Every table makes its rows visible through row-level security, even to its owner; the admin
# role's policies see them all. On this scratch copy only, the server's admin takes that role.
query "GRANT callmate_admin TO CURRENT_USER" >/dev/null
as_admin() { query "SET ROLE callmate_admin; $1"; }

latest_migration="$(query "SELECT max(version) FROM schema_migrations")"
roles="$(query "SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('callmate_owner', 'callmate_app', 'callmate_admin')")"
businesses="$(as_admin "SELECT count(*) FROM tenants")"
calls="$(as_admin "SELECT count(*) FROM calls")"
newest_call="$(as_admin "SELECT coalesce(to_char(max(started_at) AT TIME ZONE 'Europe/London', 'YYYY-MM-DD HH24:MI'), 'none') FROM calls")"

echo "Latest migration: $latest_migration"
echo "Logins: $roles"
echo "Businesses: $businesses, calls: $calls (newest $newest_call, UK time)"

failed=0
if [ "$roles" != "callmate_admin,callmate_app,callmate_owner" ]; then
  echo "::error::The restored copy is missing a login: $roles"
  failed=1
fi
if [ -z "$latest_migration" ]; then
  echo "::error::The restored copy has no migrations recorded"
  failed=1
fi
if [ "$businesses" -lt 1 ]; then
  echo "::error::The restored copy has no businesses"
  failed=1
fi
if [ "$failed" -eq 0 ]; then
  echo "::notice::Restore drill passed: restored in about $minutes minutes; $businesses businesses, $calls calls, newest call $newest_call, migration $latest_migration."
fi
exit "$failed"
