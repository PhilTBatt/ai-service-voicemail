# 016: Where the container image lives (Step 8)

- **Date:** 2026-11-09
- **Status:** accepted 2026-11-09 (Phil: "if it's cheaper")
- **Code:** `Dockerfile`, `.github/workflows/deploy.yml`

## 1. What's decided

The one image the service runs (the API with its dashboard, the worker, the migrations) is published to **GitHub's container registry**, as `ghcr.io/philtbatt/ai-service-voicemail:<commit>`, by the Deploy workflow. Azure pulls it from there.

## 2. Options

| Option                                 | Cost                               | Why not                                                                         |
| -------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| **GitHub container registry (chosen)** | Free for a public package          | (chosen)                                                                        |
| Azure Container Registry, Basic        | about £3.81 a month (decision 011) | Costs money for nothing we need yet; one more Azure resource and role to manage |
| Docker Hub                             | Free tier, with pull rate limits   | A third account, and its rate limits could stop Azure pulling during a deploy   |

## 3. Public or private

GitHub publishes a new package as **private** ("When you first publish a package, the default visibility is private"). Azure can pull a **public** image with no login ("public packages allow anonymous access"), so after the first build Phil sets the package to public: the package's page, **Package settings**, then under **Danger Zone**, **Change visibility**, **Public** ([GitHub's docs](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)).

- **That can't be undone:** "Once you make a package public, you cannot make it private again." The image holds nothing secret: the code is already public, and the one setting baked in is Clerk's publishable key, which is public by design. Every secret reaches the running container from Key Vault.
- **If the repository goes private later:** publish under a new package name, keep it private, and give Azure a GitHub token with read access to packages, stored in Key Vault. Or move to Azure's registry.

## 4. Confidence and the case against

- **High.** It costs nothing and uses the account Phil already has.
- **The strongest case against:** two providers instead of one. If GitHub's registry is down during a deploy, the deploy waits. Running containers aren't affected: Azure already has the image.

Docs read 2026-11-09:

- [Working with the container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Publishing a package with GitHub Actions](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions)
- [Access control and visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
