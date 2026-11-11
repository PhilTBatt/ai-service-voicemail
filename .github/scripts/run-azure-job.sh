#!/usr/bin/env bash
# Starts a Container Apps job (infra/main.bicep) and waits for it to finish, failing the deploy if
# it doesn't succeed. Used by .github/workflows/deploy.yml. Needs RESOURCE_GROUP and an Azure
# sign-in. Microsoft's CLI reference doesn't spell out what "job start" prints or every status
# an execution can have, so this reads the newest execution from the job's own list, and treats
# anything but "Succeeded" at the end as a failure. On a failure it prints the job's own output
# here, so the cause is in the Actions log and not only in the Azure portal.
#   run-azure-job.sh <job name> <container name> [command and arguments...]
# With a command, that execution runs it instead of the job's own (the callmate-task job exists
# for this: any script in the image, against production).
set -euo pipefail

job="$1"
container="$2"
shift 2
timeout_seconds=600

# A command is set on the job itself, then the job is started plainly. Overriding it at start
# instead makes Azure treat the container as described from scratch: it then asks for an
# image too (ContainerAppImageRequired), and the job's settings would go the same way.
if [ "$#" -gt 1 ]; then
  echo "Setting $job's command to: $*"
  az containerapp job update --name "$job" --resource-group "$RESOURCE_GROUP" \
    --command "$1" --args "${@:2}" --output none
elif [ "$#" -eq 1 ]; then
  echo "Setting $job's command to: $1"
  az containerapp job update --name "$job" --resource-group "$RESOURCE_GROUP" \
    --command "$1" --output none
fi
before="$(date -u +%Y-%m-%dT%H:%M:%S)"
started="$(az containerapp job start --name "$job" --resource-group "$RESOURCE_GROUP" --output json)"
echo "Started $job"

# Follow this execution, never an earlier one: the newest in the list could still be the last
# run's for a few seconds, and a release would then take the last migration's success for this
# one's and move the apps on. The start's own answer names it, when it carries a name (the
# reference doesn't say); otherwise only an execution that began after the start counts.
execution="$(printf '%s' "$started" | jq -r '.name // empty' 2>/dev/null || true)"
tries=0
while [ -z "$execution" ] && [ "$tries" -lt 12 ]; do
  sleep 5
  tries=$((tries + 1))
  execution="$(az containerapp job execution list --name "$job" --resource-group "$RESOURCE_GROUP" \
    --query "sort_by([?properties.startTime >= '$before'], &properties.startTime)[-1].name" \
    --output tsv)"
done
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
    Succeeded)
      echo "::group::$job output"
      az containerapp job logs show --name "$job" --resource-group "$RESOURCE_GROUP" \
        --execution "$execution" --container "$container" --format text --tail 300 \
        || echo "(couldn't fetch the output here)"
      echo "::endgroup::"
      exit 0
      ;;
    Failed | Stopped | Degraded)
      echo "::error::$job ended as $status. Its output follows, if Azure still has it; otherwise it's in the Azure portal: $job, Execution history, Console."
      echo "::group::$job output"
      # Preview command (containerapp extension 2.79+). Its failure mustn't hide the job's.
      az containerapp job logs show --name "$job" --resource-group "$RESOURCE_GROUP" \
        --execution "$execution" --container "$container" --format text --tail 300 \
        || echo "(couldn't fetch the output here)"
      echo "::endgroup::"
      exit 1
      ;;
  esac
  sleep 10
  waited=$((waited + 10))
done

echo "::error::$job didn't finish within $timeout_seconds seconds"
exit 1
