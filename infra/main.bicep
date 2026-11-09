// The base of the Azure setup (BUILD_PLAN Step 8; decisions 011, 016, 017): logs, the Container
// Apps environment, the identity the apps read their secrets with, Key Vault, and the database.
// Production only, in the resource group's region (UK South). The apps themselves, the
// migration job and the alerts come next, once Key Vault holds the secrets they read.
//
// Applied by the Deploy workflow (Actions > Deploy > "infrastructure-apply"), never by hand.
// "infrastructure-what-if" shows what would change and changes nothing.

@description('Where everything runs: the resource group\'s region.')
param location string = resourceGroup().location

@description('Prefix for every name.')
param name string = 'callmate'

@secure()
@description('The database server\'s admin password: a GitHub environment secret, never in the repo.')
param postgresAdminPassword string

@description('Phil\'s Entra user object ID: allowed to add and change the secrets in Key Vault.')
param keyVaultAdminObjectId string

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
