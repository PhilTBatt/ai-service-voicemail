#!/usr/bin/env bash
# Starts a Container Apps job (infra/main.bicep) and waits for it to finish, failing the deploy if
# it doesn't succeed. Used by .github/workflows/deploy.yml. Needs RESOURCE_GROUP and an Azure
# sign-in. Microsoft's CLI reference doesn't spell out what "job start" prints or every status
# an execution can have, so this reads the newest execution from the job's own list, and treats
# anything but "Succeeded" at the end as a failure.
set -euo pipefail

job="$1"
timeout_seconds=600

az containerapp job start --name "$job" --resource-group "$RESOURCE_GROUP" --output none
echo "Started $job"
sleep 5

# The execution just started is the newest one.
execution="$(az containerapp job execution list --name "$job" --resource-group "$RESOURCE_GROUP" \
  --query "sort_by(@, &properties.startTime)[-1].name" --output tsv)"
if [ -z "$execution" ]; then
  echo "::error::Couldn't find the execution of $job that was just started"
  exit 1
fi

waited=0
while [ "$waited" -lt "$timeout_seconds" ]; do
  status="$(az containerapp job execution show --name "$job" --resource-group "$RESOURCE_GROUP" \
    --job-execution-name "$execution" --query properties.status --output tsv)"
  echo "$job ($execution): $status"
  case "$status" in
    Succeeded) exit 0 ;;
    Failed | Stopped | Degraded)
      echo "::error::$job ended as $status. Its output is in the logs: Azure portal, $job, Execution history."
      exit 1
      ;;
  esac
  sleep 10
  waited=$((waited + 10))
done

echo "::error::$job didn't finish within $timeout_seconds seconds"
exit 1
