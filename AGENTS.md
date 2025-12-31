# AGENTS.md

## Build & Test Commands

- **Build**: `mise run build` or `bun build ./src/index.ts --outdir dist --target bun`
- **Test**: `mise run test` or `bun test`
- **Lint**: `mise run lint` (eslint)
- **Fix Lint**: `mise run lint:fix` (eslint --fix)
- **Format**: `mise run format` (prettier)

## Code Style Guidelines

### Imports & Module System

- Use ES6 `import`/`export` syntax (module: "ESNext", type: "module")
- Group imports: external libraries first, then internal modules

### Formatting (Prettier)

- **Single quotes** (`singleQuote: true`)
- **Line width**: 100 characters
- **Tab width**: 2 spaces
- **Trailing commas**: ES5
- **Semicolons**: enabled

### TypeScript & Naming

- **NeverNesters**: avoid deeply nested structures. Always exit early.
- **Strict mode**: enforced (`"strict": true`)
- **Explicit types**: prefer explicit type annotations over inference

### Error Handling

- Check error type before accessing properties: `error instanceof Error ? error.toString() : String(error)`
- Empty catch blocks use `/* intentionally ignored */` pattern

### Linting Rules

- `@typescript-eslint/no-explicit-any`: warn
- `no-console`: error
- `prettier/prettier`: error

## Project Context

- **Type**: ES Module package for OpenCode plugin system
- **Target**: Bun runtime, ES2021+
- **Purpose**: Continuation enforcement for beads task management

## Architecture

The plugin uses OpenCode's `event` hook to listen for:

- `session.idle` - Triggers beads check and countdown
- `session.error` - Tracks errors for cooldown
- `message.updated` - Clears error state on user messages
- `message.part.updated` - Cancels countdown while assistant types
- `tool.execute.before/after` - Cancels countdown during tool execution
- `session.deleted` - Cleanup

Key functions:

- `isBeadsInitialized()` - Checks if `bd status` succeeds
- `getInProgressBeads()` - Runs `bd list --status=in_progress --json`
- `getReadyBeads()` - Runs `bd ready --json`
- `getEpicIdFromBranch()` - Extracts `bd-XXXXXX` from git branch name
- `injectContinuation()` - Sends prompt via `ctx.client.session.prompt()`
