// The Azure setup (BUILD_PLAN Step 8; decisions 011, 016, 017): logs, the Container Apps
// environment, the identity the apps read their secrets with, Key Vault and the database (the
// base), then the API, the worker and the two jobs (database setup, migrations). Production
// only, in the resource group's region (UK South). The alerts come next.
//
// Applied by the Deploy workflow (Actions > Deploy), never by hand: "infrastructure-what-if"
// shows what would change and changes nothing.

@description('Where everything runs: the resource group\'s region.')
param location string = resourceGroup().location

@description('Prefix for every name.')
param name string = 'callmate'

@secure()
@description('The database server\'s admin password: a GitHub environment secret, never in the repo.')
param postgresAdminPassword string

@description('Phil\'s Entra user object ID: allowed to add and change the secrets in Key Vault.')
param keyVaultAdminObjectId string

@description('The image the apps and jobs run, as the Deploy workflow just built it. Empty: no jobs or apps.')
param image string = ''

@description('Create or update the API and the worker as well: only once Key Vault holds every secret they read, or they can\'t start.')
param deployApps bool = false

@description('Settings in Key Vault beyond the required ones, by Key Vault name (for example "retell-webhook-key").')
param optionalSecretNames array = []

@description('The service\'s own address, such as "app.brockersby.co.uk" (RUNBOOK section 16, the domain). Empty: Azure\'s generated address only.')
param customDomain string = ''

@allowed(['add', 'bind', 'live'])
@description('How far along the custom domain is. "add": the hostname is on the API with no certificate, so the DNS records can be validated. "bind": Azure\'s free certificate is issued and bound, so HTTPS works there. "live": the apps use it as their own address too (webhook signatures, links, the dashboard\'s origin).')
param customDomainStage string = 'add'

// Key Vault and database names are global across Azure: a short suffix from the resource
// group's ID keeps ours unique and the same on every run.
var suffix = take(uniqueString(resourceGroup().id), 8)

// ─── Logs ─────────────────────────────────────────────────────────────────────────────────
// The first 5 GB a month are free; we expect well under 1 (decision 011).
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ─── Container Apps environment ───────────────────────────────────────────────────────────
// Consumption only (no workload profiles): billed per second of use, with no environment fee.
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

// ─── The apps' identity ───────────────────────────────────────────────────────────────────
// One identity for the API, the worker and the jobs, made before them so Key Vault can trust
// it first: an app can't start until it can read its secrets.
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${name}-apps'
  location: location
}

// ─── Key Vault ────────────────────────────────────────────────────────────────────────────
// Phil enters the live secrets himself (CLAUDE.md); the apps read them through the identity
// above. Access by Azure roles, not access policies. Public endpoint for now, like the
// database (decision 017).
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-${name}-${suffix}'
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // A deleted secret or vault can be recovered for 90 days, and can't be purged before then.
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

var keyVaultSecretsUser = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var keyVaultSecretsOfficer = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
)

// The apps may read secrets, and nothing else.
resource appsReadSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, appIdentity.id, keyVaultSecretsUser)
  properties: {
    roleDefinitionId: keyVaultSecretsUser
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Phil may add and change them. Even a subscription owner needs this with role-based access.
resource philManagesSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, keyVaultAdminObjectId, keyVaultSecretsOfficer)
  properties: {
    roleDefinitionId: keyVaultSecretsOfficer
    principalId: keyVaultAdminObjectId
    principalType: 'User'
  }
}

// ─── Database ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL 16, the smallest burstable size (decision 011: about £10.44 a month plus
// £3.20 for 32 GB), seven days of backups. Option A (decision 017): a public endpoint that
// only Azure can reach, encrypted connections only (the server's default), password logins.
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-${name}-${suffix}'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: 'callmateadmin'
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32 }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
    authConfig: {
      passwordAuth: 'Enabled'
      activeDirectoryAuth: 'Disabled'
    }
  }
}

resource callmateDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'callmate'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// 0.0.0.0 to 0.0.0.0 is Azure's "allow public access from any Azure service": every
// connection from inside Azure, including other customers' subscriptions, gets as far as the
// password check (Microsoft's firewall docs; the trade-off decision 017 accepts for now).
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// What the next step and Phil need: where to put the secrets, and the database's address.
output keyVaultName string = vault.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output environmentDomain string = environment.properties.defaultDomain
output appIdentityClientId string = appIdentity.properties.clientId

// ─── Settings the apps read from Key Vault ────────────────────────────────────────────────
// One rule maps each Key Vault secret to the setting the code reads: "database-url" is
// DATABASE_URL (Key Vault names can't have underscores). Phil adds them (RUNBOOK section 16).
// An app can't start while a secret it names is missing, so this list is what must be there.
var requiredSecretNames = [
  'database-url'
  'admin-database-url'
  'retell-api-key'
  'twilio-account-sid'
  'twilio-auth-token'
  'fallback-voicemail-url'
  'anthropic-api-key'
  'twilio-sms-from'
  'signing-secret'
  'postmark-server-token'
  'postmark-webhook-secret'
  'email-from'
  'clerk-secret-key'
]
var appSecretNames = concat(requiredSecretNames, optionalSecretNames)

// Each list twice over: as the app's secrets (read from Key Vault with the apps' identity),
// and as its settings (each pointing at one of those secrets).
var appSecrets = map(appSecretNames, secretName => {
  name: secretName
  keyVaultUrl: '${vault.properties.vaultUri}secrets/${secretName}'
  identity: appIdentity.id
})
var appSecretEnv = map(appSecretNames, secretName => {
  name: toUpper(replace(secretName, '-', '_'))
  secretRef: secretName
})

// The database-setup job: the server's admin login, and the three logins it sets up.
var setupSecretNames = ['postgres-admin-url', 'migration-database-url', 'database-url', 'admin-database-url']
var setupSecrets = map(setupSecretNames, secretName => {
  name: secretName
  keyVaultUrl: '${vault.properties.vaultUri}secrets/${secretName}'
  identity: appIdentity.id
})
var setupEnv = map(setupSecretNames, secretName => {
  name: toUpper(replace(secretName, '-', '_'))
  secretRef: secretName
})

// Container Apps names its default address after the app: known before the app exists. Once
// the custom domain is live, that is the service's own address instead; the generated one
// keeps working (the uptime check uses it).
var apiName = '${name}-api'
var customDomainOn = deployApps && image != '' && customDomain != ''
var generatedBaseUrl = 'https://${apiName}.${environment.properties.defaultDomain}'
var customBaseUrl = 'https://${customDomain}'
var publicBaseUrl = customDomainOn && customDomainStage == 'live' ? customBaseUrl : generatedBaseUrl
// The API's other address, once both work (from "bind", when the custom domain has its
// certificate): Twilio's signatures made for it are accepted too, so calls carry on while the
// number is re-pointed, and the dashboard opened there moves to PUBLIC_BASE_URL. That's the
// generated address once the domain is live, and the domain itself before (or after an undo).
// It stays set while the domain is live: the fallback TwiML Bin, made before the move, still
// reports its voicemail recordings to the generated address.
var alternateBaseUrl = customDomainOn && customDomainStage != 'add'
  ? (customDomainStage == 'live' ? generatedBaseUrl : customBaseUrl)
  : ''

var plainEnv = concat(
  [
    { name: 'NODE_ENV', value: 'production' }
    { name: 'PORT', value: '3000' }
    // Twilio's signatures are checked against this, and texts link to call pages under it.
    { name: 'PUBLIC_BASE_URL', value: publicBaseUrl }
    // The API serves the dashboard itself, at the same address.
    { name: 'DASHBOARD_ORIGIN', value: publicBaseUrl }
  ],
  alternateBaseUrl == '' ? [] : [{ name: 'ALTERNATE_BASE_URL', value: alternateBaseUrl }]
)

var identity = {
  type: 'UserAssigned'
  userAssignedIdentities: { '${appIdentity.id}': {} }
}

// ─── The custom domain ────────────────────────────────────────────────────────────────────
// Azure's free certificate for it, issued once the domain's CNAME points at the API and the
// asuid TXT record carries the verification ID (output below). Microsoft documents the
// portal and CLI flows, not templates; this follows the same order in three stages: the
// hostname on the API first ("add"), then the certificate and its binding ("bind").
resource customDomainCertificate 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' = if (customDomainOn && customDomainStage != 'add') {
  parent: environment
  name: '${name}-${replace(customDomain, '.', '-')}'
  location: location
  properties: {
    subjectName: customDomain
    domainControlValidation: 'CNAME'
  }
}

var customDomains = customDomainOn
  ? [
      customDomainStage == 'add'
        ? { name: customDomain, bindingType: 'Disabled' }
        : { name: customDomain, bindingType: 'SniEnabled', certificateId: customDomainCertificate.id }
    ]
  : []

// ─── The API ──────────────────────────────────────────────────────────────────────────────
// Always one replica: a call's webhook must never wait for a cold start (BUILD_PLAN Step 8).
resource api 'Microsoft.App/containerApps@2024-03-01' = if (deployApps && image != '') {
  name: apiName
  location: location
  identity: identity
  dependsOn: [appsReadSecrets]
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        customDomains: customDomains
      }
      secrets: appSecrets
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          env: concat(plainEnv, appSecretEnv)
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          probes: [
            // Alive: answers at all. Ready: the database answers too.
            { type: 'Liveness', httpGet: { path: '/healthz', port: 3000 }, periodSeconds: 10 }
            { type: 'Readiness', httpGet: { path: '/readyz', port: 3000 }, periodSeconds: 10 }
          ]
        }
      ]
      // One copy: the database connection budget (apps/api/src/db/pool.ts) and the per-copy
      // counters (spike alerts, alert throttling) both assume it, and the load test passes on one.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

// ─── The worker ───────────────────────────────────────────────────────────────────────────
// The same image with the worker's command. One replica: its jobs are idempotent, but one is
// all the load needs, and it checks in every 30 seconds (GET /healthz/worker).
resource worker 'Microsoft.App/containerApps@2024-03-01' = if (deployApps && image != '') {
  name: '${name}-worker'
  location: location
  identity: identity
  dependsOn: [appsReadSecrets]
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      secrets: appSecrets
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: image
          command: ['node', 'apps/api/src/worker.ts']
          env: concat(plainEnv, appSecretEnv)
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

// ─── The jobs, run by the Deploy workflow ─────────────────────────────────────────────────
// Database setup, once: the three logins with their passwords (what roles.sql does locally),
// as the server's admin (scripts/setup-database-roles.ts).
resource databaseSetup 'Microsoft.App/jobs@2024-03-01' = if (image != '') {
  name: '${name}-db-setup'
  location: location
  identity: identity
  dependsOn: [appsReadSecrets]
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 300
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: setupSecrets
    }
    template: {
      containers: [
        {
          name: 'db-setup'
          image: image
          command: ['node', 'apps/api/src/scripts/setup-database-roles.ts']
          env: setupEnv
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
    }
  }
}

// Migrations, before every release: as the owner role, with dbmate (decision 004).
resource migrate 'Microsoft.App/jobs@2024-03-01' = if (image != '') {
  name: '${name}-migrate'
  location: location
  identity: identity
  dependsOn: [appsReadSecrets]
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: [
        {
          name: 'migration-database-url'
          keyVaultUrl: '${vault.properties.vaultUri}secrets/migration-database-url'
          identity: appIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: image
          command: [
            'dbmate'
            '--env'
            'MIGRATION_DATABASE_URL'
            '--migrations-dir'
            'apps/api/src/db/migrations'
            '--no-dump-schema'
            'up'
          ]
          env: [{ name: 'MIGRATION_DATABASE_URL', secretRef: 'migration-database-url' }]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
    }
  }
}

// A script against production, by hand: the Deploy workflow's "task" step sets this job's
// command to the script named (invite-user, create-demo-business, live-configure-number...)
// and starts it. Same image and settings as the apps, so a script sees exactly what they
// see. The command here is the runner with no script: started untouched, it says so and stops.
resource task 'Microsoft.App/jobs@2024-03-01' = if (image != '') {
  name: '${name}-task'
  location: location
  identity: identity
  dependsOn: [appsReadSecrets]
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: appSecrets
    }
    template: {
      containers: [
        {
          name: 'task'
          image: image
          command: ['node', 'apps/api/src/scripts/run-task.ts']
          env: concat(appSecretEnv, plainEnv)
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
    }
  }
}

output publicBaseUrl string = publicBaseUrl
// What the custom domain's asuid TXT record must hold (RUNBOOK section 16, the domain).
output customDomainVerificationId string = deployApps && image != ''
  ? api.properties.customDomainVerificationId
  : ''
