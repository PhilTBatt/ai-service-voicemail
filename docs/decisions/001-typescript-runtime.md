# 001: How TypeScript is run and checked

- **Date:** 2026-11-04
- **Status:** accepted
- **Note:** BUILD_PLAN.md names the voice platform decision `001-voice-platform.md`. It takes the next free number instead.

## Context

The repo needs one way to run TypeScript that works in `npm run dev`, in tests, in CI and in the production container, across three workspaces (`apps/api`, `apps/web`, `packages/shared`).

What I checked on 2026-11-04:
- **Node 26** became the Active LTS on 2026-10-28. Node 24 is now in maintenance, and so is Node 22, which is what the laptop currently has. Source: [Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json).
- **Type stripping** is stable in Node 26. Node runs `.ts` files by replacing type annotations with spaces. It doesn't type-check, and it doesn't support syntax that generates code (`enum`, namespaces with values, parameter properties). It refuses `.ts` files inside `node_modules`. Source: [Node 26 TypeScript docs](https://nodejs.org/docs/latest-v26.x/api/typescript.html).
- **TypeScript 7.0** (the native compiler) is now `latest` on npm, but `typescript-eslint` 8.72 supports `typescript >=4.8.4 <6.1.0` (`npm view typescript-eslint peerDependencies`).

## Decision

1. **Node runs the `.ts` source directly**, in dev (`node --watch`) and in production (`node src/server.ts`). There's no build step for the API.
2. **`tsc` only type-checks** (`noEmit`). `erasableSyntaxOnly` makes it reject any syntax that Node can't strip, so it fails at typecheck time instead of at runtime.
3. **Workspace packages export their TypeScript source** (`"exports": { ".": "./src/index.ts" }`). The workspace symlink in `node_modules/@callmate/` resolves to the real folder, which is outside `node_modules`, so type stripping is allowed. Verified on 2026-11-04.
4. **Pinned versions:**
   - Node `^26.0.0` in `engines`, enforced by `engine-strict=true` in `.npmrc`
   - TypeScript `~6.0.3`: patch updates only, staying inside typescript-eslint's range

## Options considered

1. **tsx in dev, compile with `tsc` to `dist/` for production** (the old app's approach, and the tool BUILD_PLAN.md names).
   - Discarded: a build step, and every shared package has to be built before anything that imports it, which is the usual workspace pain. Node 26 now does what tsx was doing here.
2. **tsx everywhere, including production.**
   - Discarded: a runtime dependency that does what Node now does itself.
3. **Bundle the API with esbuild or tsup.**
   - Discarded: it's the most robust choice for production, but it's one more tool and config to learn and maintain, with no current benefit.
4. **TypeScript 7.**
   - Discarded for now: linting would break. Revisit when typescript-eslint supports it.

**Confidence:** medium-high. The Node feature is documented as stable, and the workspace link was tested. What isn't tested yet is vitest and ESLint against this setup; that comes in the next change.

**Strongest case against:** we're one week into Node 26 LTS, and running uncompiled source in production is less common than shipping compiled JavaScript. If a dependency or tool doesn't cope, the fallback is option 3 (bundling). That change touches the build scripts and the Dockerfile, but not the application code.

**Gotchas this creates:**
- Use `const` objects or arrays with `as const` instead of `enum`.
- Import types with `import type` (enforced by `verbatimModuleSyntax`).
- Relative imports need the real extension: `import { x } from "./x.ts"`.
- tsconfig `paths` aliases don't work at runtime. Use workspace packages instead.

**My addition:** `.npmrc` with `engine-strict=true`. Without it, npm only warns when the Node version is wrong.
