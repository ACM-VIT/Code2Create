#!/usr/bin/env bash
set -euo pipefail

C2C_RESOURCE_GROUP="rg-code2create-production"
C2C_LOCATION="centralindia"
C2C_VM_NAME="vm-c2c-production-app"
C2C_WORKSPACE_NAME="log-c2c-production"
C2C_ACTION_GROUP_NAME="ag-c2c-production"
C2C_DCE_NAME="dce-c2c-production"
C2C_DCR_NAME="dcr-c2c-production-vm"
C2C_DCR_ASSOCIATION_NAME="dcr-c2c-production-vm"
C2C_CONTAINER_TABLE_NAME="C2CContainerLog_CL"

C2C_VM_ID="$(
  az vm show \
    --resource-group "${C2C_RESOURCE_GROUP}" \
    --name "${C2C_VM_NAME}" \
    --query id \
    --output tsv
)"
C2C_WORKSPACE_ID="$(
  az monitor log-analytics workspace show \
    --resource-group "${C2C_RESOURCE_GROUP}" \
    --workspace-name "${C2C_WORKSPACE_NAME}" \
    --query id \
    --output tsv
)"
C2C_ACTION_GROUP_ID="$(
  az monitor action-group show \
    --resource-group "${C2C_RESOURCE_GROUP}" \
    --name "${C2C_ACTION_GROUP_NAME}" \
    --query id \
    --output tsv
)"
C2C_TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${C2C_TEMP_DIR}"
}
trap cleanup EXIT

jq --null-input --arg tableName "${C2C_CONTAINER_TABLE_NAME}" '{
  properties: {
    plan: "Analytics",
    retentionInDays: 30,
    totalRetentionInDays: 30,
    schema: {
      name: $tableName,
      columns: [
        { name: "TimeGenerated", type: "dateTime" },
        { name: "Computer", type: "string" },
        { name: "FilePath", type: "string" },
        { name: "Stream", type: "string" },
        { name: "Log", type: "string" }
      ]
    }
  }
}' >"${C2C_TEMP_DIR}/container-log-table.json"

az rest \
  --method put \
  --uri "${C2C_WORKSPACE_ID}/tables/${C2C_CONTAINER_TABLE_NAME}?api-version=2026-03-01" \
  --body "@${C2C_TEMP_DIR}/container-log-table.json" \
  --output none

az monitor data-collection endpoint create \
  --resource-group "${C2C_RESOURCE_GROUP}" \
  --name "${C2C_DCE_NAME}" \
  --location "${C2C_LOCATION}" \
  --kind Linux \
  --public-network-access Enabled \
  --output none

C2C_DCE_ID="$(
  az monitor data-collection endpoint show \
    --resource-group "${C2C_RESOURCE_GROUP}" \
    --name "${C2C_DCE_NAME}" \
    --query id \
    --output tsv
)"

jq \
  --null-input \
  --arg endpointId "${C2C_DCE_ID}" \
  --arg workspaceId "${C2C_WORKSPACE_ID}" \
  '{
    properties: {
      description: "Production VM performance, warning-level syslog, and filtered container logs.",
      dataCollectionEndpointId: $endpointId,
      streamDeclarations: {
        "Custom-C2CContainerText": {
          columns: [
            { name: "TimeGenerated", type: "datetime" },
            { name: "RawData", type: "string" },
            { name: "FilePath", type: "string" },
            { name: "Computer", type: "string" }
          ]
        }
      },
      dataSources: {
        performanceCounters: [
          {
            name: "productionVmPerformance",
            streams: ["Microsoft-Perf"],
            samplingFrequencyInSeconds: 60,
            counterSpecifiers: [
              "\\Processor(_Total)\\% Processor Time",
              "\\Memory\\Available MBytes",
              "\\Memory\\% Available Memory",
              "\\Logical Disk(*)\\% Used Space",
              "\\Logical Disk(*)\\Free Megabytes",
              "\\System\\Uptime"
            ]
          }
        ],
        syslog: [
          {
            name: "productionVmWarnings",
            streams: ["Microsoft-Syslog"],
            facilityNames: ["auth", "authpriv", "cron", "daemon", "kern", "syslog", "user"],
            logLevels: ["Warning", "Error", "Critical", "Alert", "Emergency"]
          }
        ],
        logFiles: [
          {
            name: "productionContainerJson",
            streams: ["Custom-C2CContainerText"],
            filePatterns: ["/var/lib/docker/containers/*/*-json.log"],
            format: "text",
            settings: {
              text: {
                recordStartTimestampFormat: "ISO 8601"
              }
            }
          }
        ]
      },
      destinations: {
        logAnalytics: [
          {
            name: "productionWorkspace",
            workspaceResourceId: $workspaceId
          }
        ]
      },
      dataFlows: [
        {
          streams: ["Microsoft-Perf"],
          destinations: ["productionWorkspace"],
          transformKql: "source",
          outputStream: "Microsoft-Perf"
        },
        {
          streams: ["Microsoft-Syslog"],
          destinations: ["productionWorkspace"],
          transformKql: "source",
          outputStream: "Microsoft-Syslog"
        },
        {
          streams: ["Custom-C2CContainerText"],
          destinations: ["productionWorkspace"],
          transformKql: "source | where RawData contains \"ERROR\" or RawData contains \"WARN\" or RawData contains \"FATAL\" or RawData contains \"PANIC\" | extend Docker=parse_json(RawData) | project TimeGenerated=todatetime(Docker[\"time\"]), Computer, FilePath, Stream=tostring(Docker[\"stream\"]), Log=tostring(Docker[\"log\"])",
          outputStream: "Custom-C2CContainerLog_CL"
        }
      ]
    }
  }' >"${C2C_TEMP_DIR}/vm-dcr.json"

az monitor data-collection rule create \
  --resource-group "${C2C_RESOURCE_GROUP}" \
  --name "${C2C_DCR_NAME}" \
  --location "${C2C_LOCATION}" \
  --kind Linux \
  --rule-file "${C2C_TEMP_DIR}/vm-dcr.json" \
  --output none

C2C_DCR_ID="$(
  az monitor data-collection rule show \
    --resource-group "${C2C_RESOURCE_GROUP}" \
    --name "${C2C_DCR_NAME}" \
    --query id \
    --output tsv
)"

az vm extension set \
  --resource-group "${C2C_RESOURCE_GROUP}" \
  --vm-name "${C2C_VM_NAME}" \
  --publisher Microsoft.Azure.Monitor \
  --name AzureMonitorLinuxAgent \
  --enable-auto-upgrade true \
  --output none

az monitor data-collection rule association create \
  --name "${C2C_DCR_ASSOCIATION_NAME}" \
  --resource "${C2C_VM_ID}" \
  --rule-id "${C2C_DCR_ID}" \
  --output none

az rest \
  --method patch \
  --uri "${C2C_VM_ID}?api-version=2026-04-01" \
  --body '{"properties":{"diagnosticsProfile":{"bootDiagnostics":{"enabled":true}}}}' \
  --output none

create_metric_alert() {
  local name="$1"
  local description="$2"
  local condition="$3"
  az monitor metrics alert create \
    --resource-group "${C2C_RESOURCE_GROUP}" \
    --name "${name}" \
    --scopes "${C2C_VM_ID}" \
    --condition "${condition}" \
    --window-size 5m \
    --evaluation-frequency 1m \
    --severity 2 \
    --description "${description}" \
    --action "${C2C_ACTION_GROUP_ID}" \
    --output none
}

create_metric_alert \
  "c2c-production-vm-cpu" \
  "Production VM CPU remained above 80 percent for five minutes." \
  "avg Percentage CPU > 80"
create_metric_alert \
  "c2c-production-vm-memory" \
  "Production VM available memory remained below 15 percent for five minutes." \
  "avg Available Memory Percentage < 15"
create_metric_alert \
  "c2c-production-vm-os-disk-iops" \
  "Production VM OS disk IOPS consumption remained above 80 percent for five minutes." \
  "avg OS Disk IOPS Consumed Percentage > 80"
create_metric_alert \
  "c2c-production-vm-os-disk-bandwidth" \
  "Production VM OS disk bandwidth consumption remained above 80 percent for five minutes." \
  "avg OS Disk Bandwidth Consumed Percentage > 80"

az monitor scheduled-query create \
  --resource-group "${C2C_RESOURCE_GROUP}" \
  --name "c2c-production-vm-root-filesystem" \
  --scopes "${C2C_WORKSPACE_ID}" \
  --condition "count 'filesystem' > 0" \
  --condition-query filesystem='Perf | where ObjectName == "Logical Disk" and CounterName == "% Used Space" and InstanceName == "/" | summarize UsedPercent=max(CounterValue) | where UsedPercent >= 80' \
  --window-size 10m \
  --evaluation-frequency 5m \
  --severity 2 \
  --description "Production VM root filesystem usage is at least 80 percent." \
  --action-groups "${C2C_ACTION_GROUP_ID}" \
  --skip-query-validation true \
  --output none

az monitor scheduled-query create \
  --resource-group "${C2C_RESOURCE_GROUP}" \
  --name "c2c-production-container-errors" \
  --scopes "${C2C_WORKSPACE_ID}" \
  --condition "count 'errors' > 5" \
  --condition-query errors='C2CContainerLog_CL | where (Log contains "ERROR" and Log !contains "Caught occ error") or Log contains "FATAL" or Log contains "PANIC"' \
  --window-size 5m \
  --evaluation-frequency 5m \
  --severity 2 \
  --description "Production containers emitted more than five error-level records in five minutes." \
  --action-groups "${C2C_ACTION_GROUP_ID}" \
  --skip-query-validation true \
  --output none

az monitor scheduled-query create \
  --resource-group "${C2C_RESOURCE_GROUP}" \
  --name "c2c-production-vm-heartbeat" \
  --scopes "${C2C_WORKSPACE_ID}" \
  --condition "count 'heartbeat' < 1" \
  --condition-query heartbeat="Heartbeat | where Computer =~ '${C2C_VM_NAME}'" \
  --window-size 5m \
  --evaluation-frequency 5m \
  --severity 1 \
  --description "Azure Monitor has not received a production VM heartbeat for five minutes." \
  --action-groups "${C2C_ACTION_GROUP_ID}" \
  --skip-query-validation true \
  --output none

echo "Production VM observability is configured."
