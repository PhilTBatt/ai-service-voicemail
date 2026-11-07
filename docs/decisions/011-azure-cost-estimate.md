# 011: Azure hosting, estimated monthly cost (Step 8 gate)

- **Date:** 2026-11-08
- **Status:** proposed. 🛑 BUILD_PLAN Step 8: Phil approves this before any `az` command or deploy that creates resources. No Azure resource exists yet.
- **Code:** none yet. `infra/` (Bicep) follows approval.

## 1. What gets built (from BUILD_PLAN Step 8)

Per environment (staging and production), in UK South:

- a Container Apps environment with two apps, `api` and `worker`, each 0.25 vCPU and 0.5 GiB
- Azure Database for PostgreSQL Flexible Server, smallest burstable tier, backups on, no open public access
- Key Vault, read by the apps through managed identity
- Log Analytics for logs and the five alerts
- a container registry (shared by both environments)
- an external uptime check on `/healthz`

Production's `api` must never cold-start (webhooks), so both production apps keep one replica running. Staging can scale its API to zero.

## 2. Where the prices come from

Azure's pricing web pages don't render figures without a browser, so every price below comes from Microsoft's public **Azure Retail Prices API**, filtered to `armRegionName eq 'uksouth'` and `currencyCode='GBP'`, read on **2026-11-08**:

- API reference: https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices
- Example query: `https://prices.azure.com/api/retail/prices?currencyCode='GBP'&$filter=armRegionName eq 'uksouth' and serviceName eq 'Azure Container Apps'`
- Pricing pages for the same services, for reading in a browser: [Container Apps](https://azure.microsoft.com/en-gb/pricing/details/container-apps/), [PostgreSQL Flexible Server](https://azure.microsoft.com/en-gb/pricing/details/postgresql/flexible-server/), [Key Vault](https://azure.microsoft.com/en-gb/pricing/details/key-vault/), [Azure Monitor](https://azure.microsoft.com/en-gb/pricing/details/monitor/), [Container Registry](https://azure.microsoft.com/en-gb/pricing/details/container-registry/), [free services](https://azure.microsoft.com/en-gb/pricing/free-services/)

Container Apps compute meters are so small per second that the API returns them as 0 in GBP; those are taken in US dollars and converted at Azure's own implied rate of **£0.752 per $1** (from two meters it prices in both currencies: requests £0.3007 against $0.40, Key Vault operations £0.0226 against $0.03). Azure bills in dollars converted at London closing rates, so the pound figures move with the exchange rate.

## 3. Unit prices (UK South)

| Meter                                             | Price                                                         | Note                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Container Apps, active vCPU                       | $0.000034 per vCPU-second (£0.0000256)                        | Consumption plan                                                                                                                              |
| Container Apps, active memory                     | $0.000004 per GiB-second (£0.0000030)                         |                                                                                                                                               |
| Container Apps, idle vCPU and memory              | $0.000004 per second (£0.0000030)                             | A replica with no requests is billed at the idle rate                                                                                         |
| Container Apps, requests                          | £0.3007 per million                                           |                                                                                                                                               |
| Container Apps, free grant per month              | 180,000 vCPU-seconds, 360,000 GiB-seconds, 2 million requests | Always free, per subscription                                                                                                                 |
| Container Apps, "Environment Management Hour"     | £0.0752 per hour                                              | New meter dated 2026-11-01. **Unclear whether it applies to a consumption-only environment** or only to workload-profile ones; see section 6  |
| PostgreSQL Flexible Server, B1ms (1 vCore, 2 GiB) | £0.0143 per hour, about £10.44 a month                        |                                                                                                                                               |
| PostgreSQL Flexible Server, B2s (2 vCores, 4 GiB) | £0.0571 per hour, about £41.70 a month                        | If B1ms proves too small                                                                                                                      |
| PostgreSQL storage                                | £0.10 per GB a month                                          | Minimum 32 GB: £3.20                                                                                                                          |
| PostgreSQL backup storage                         | £0.0752 per GB a month                                        | Flexible Server includes backup storage up to the provisioned size at no charge (my understanding of the product; not confirmed from the API) |
| Key Vault Standard                                | £0.0226 per 10,000 operations                                 | Pennies                                                                                                                                       |
| Log Analytics ingestion                           | first 5 GB a month free, then £2.1653 per GB                  | We'll stay under 1 GB; 31 days' retention included                                                                                            |
| Alerts, metric                                    | first 10 free, then £0.0752 a month each                      |                                                                                                                                               |
| Alerts, log search, every 5 minutes               | £1.1278 a month each                                          | Every 15 minutes: £0.3759                                                                                                                     |
| Container Registry Basic                          | £0.1253 a day, about £3.81 a month                            | 10 GB included                                                                                                                                |

## 4. Production estimate

Both apps on one replica each, 0.25 vCPU and 0.5 GiB, for a 730-hour month (2,628,000 seconds):

| Item                                                                                                                              | Low (apps mostly idle) | High (apps fully active) |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------ |
| Container Apps, two apps, after the free grant                                                                                    | £10.20                 | £35.80                   |
| PostgreSQL B1ms plus 32 GB storage                                                                                                | £13.64                 | £13.64                   |
| Container Registry Basic                                                                                                          | £3.81                  | £3.81                    |
| Alerts: one metric (5xx rate), four log searches (dead letter, fallback voicemails, signature failures, sync errors) at 5 minutes | £4.51                  | £4.51                    |
| Key Vault, logs, bandwidth                                                                                                        | about £1               | about £1                 |
| **Production total**                                                                                                              | **about £33**          | **about £59**            |

At our traffic the apps sit idle nearly all the time, so expect the low end. If the environment management meter applies to consumption environments, add £55 a month per environment (section 6).

## 5. Staging estimate

Staging exists to test deploys and migrations, not to carry traffic:

| Item                                                                             | Monthly                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------- |
| API scaled to zero (cold starts are fine in staging); worker on one idle replica | about £5                                 |
| Database: a second database on the production server, or its own B1ms server     | £0, or £13.64                            |
| Registry, logs                                                                   | shared with production: £0               |
| **Staging total**                                                                | **about £5, or £19 with its own server** |

My recommendation is its own B1ms server from the start: £14 a month buys a staging environment that can't touch production data, and migrations get rehearsed against a separate server, which is what staging is for.

**Both environments, steady state: about £52 a month on the low estimates (£33 plus £19), rising towards £78 if the apps are busy.** The Twilio, Retell and Anthropic costs per call are separate and already modelled in the profit scenarios.

## 6. What could move the number

- **The environment management meter.** Azure's price list shows a £0.0752-per-hour "Environment Management Hour" effective 2026-11-01. Historically only environments with dedicated workload profiles paid a management fee, and consumption-only environments were free apart from compute. I can't tell from the price list which it is now. The Bicep `what-if` won't show it either; the first invoice will. If it applies, the cheapest shape is one environment holding both staging and production apps (saves £55 a month) at the cost of some blast-radius separation.
- **A new Azure account's free tier.** The free-services page lists 750 hours a month of a B1ms server with 32 GB storage and 32 GB backup, free for 12 months, plus $200 of credit for the first 30 days. If Phil's personal account qualifies, production's database costs nothing for a year, about £164 saved.
- **Networking (plan asks for the cheapest secure option, with reasons).** Three ways to keep the database off the public internet:
  1. **VNet integration (recommended):** the Container Apps environment in a virtual network, and the database with private access in a delegated subnet. No extra charge; the database has no public endpoint at all. The cost is Bicep complexity (a VNet, two subnets, a private DNS zone).
  2. **Private endpoint:** also no public endpoint, but the endpoint itself is metered (roughly £5 a month plus data processing; price not pulled). No reason to pay it when option 1 exists.
  3. **Public endpoint with a firewall** allowing only the environment's outbound IPs, with TLS required. Free and simple, but still a public listener, and the outbound IPs can change. Acceptable for staging if option 1 proves awkward; not for production.
- **High availability** for the database doubles its compute. Not proposed: backups and a single zone are enough for the launch.
- **Container registry:** ACR Basic at £3.81, or GitHub's registry. GitHub's is free for the sizes involved, but Azure would pull with a stored token; ACR pulls with the apps' managed identity and no secret anywhere. ACR, for £3.81.
- **Uptime check:** an external free tier (UptimeRobot or Better Stack both offer one) at £0; chosen in Step 8.
- **Alert delivery:** Azure Monitor action groups can push to the Azure mobile app and send email at no charge; SMS is metered (UK price not pulled). Push plus email first; SMS only if push proves unreliable.

## 7. What I'm asking Phil to approve

Creating, in a personal Azure subscription with a budget alert set first:

- one resource group in UK South for staging and one for production
- the resources in section 1, sized as in sections 4 and 5, with staging on its own B1ms server
- an estimated **£52 a month for both environments** at list prices, less for the first year if the free tier applies, with the environment-management meter as the known unknown

Nothing runs until Phil says yes. The first deploy will include the Bicep `what-if` output, and the first invoice should be checked against this table.
