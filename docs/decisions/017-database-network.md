# 017: How the database is reached (Step 8)

- **Date:** 2026-11-09
- **Status:** accepted 2026-11-09 (Phil: "option A for now, we can always change it")
- **Code:** `infra/main.bicep`

## 1. What's decided

**Option A.** The database server has a public endpoint, and its firewall lets in only connections from inside Azure: the rule from 0.0.0.0 to 0.0.0.0, which Microsoft's firewall docs describe as "Allow public access from any Azure service within Azure to this server". Connections must be encrypted (the server's default), and every login needs a password: the admin's (a GitHub environment secret) and each app role's (in Key Vault). Key Vault keeps its public endpoint too, behind Azure sign-in and roles.

## 2. Options

| Option                                               | Cost                                                                     | Why not                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| **A: public endpoint, Azure-only firewall (chosen)** | Nothing extra                                                            | (chosen)                                                                            |
| B: private network (VNet, private endpoints)         | Extra for the network pieces, and a Container Apps environment on a VNet | More to build and pay for before there's a customer; can be moved to later          |
| C: public endpoint, firewall by IP address           | Nothing extra                                                            | Container Apps on the consumption plan don't have a fixed outgoing address to allow |

## 3. Confidence and the case against

- **Medium-high** for now, while the only data is test data.
- **The strongest case against:** "Allow Azure services" means every connection from Azure, including other customers' subscriptions, reaches the password check (Microsoft's own warning). The password is all that stands in the way. Strong, random passwords kept only in Key Vault and the GitHub environment are what make that acceptable for now.
- **Revisit** before the first paying customer's calls are stored: Option B.

Docs read 2026-11-09: [Firewall rules for Azure Database for PostgreSQL](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-firewall-rules), [flexible server Bicep reference](https://learn.microsoft.com/en-us/azure/templates/microsoft.dbforpostgresql/flexibleservers), [Key Vault Bicep reference](https://learn.microsoft.com/en-us/azure/templates/microsoft.keyvault/vaults).
