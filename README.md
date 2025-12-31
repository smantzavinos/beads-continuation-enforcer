# opencode-beads-enforcer

Continuation enforcement for beads task management in OpenCode.

> An OpenCode plugin that monitors for in-progress beads and injects continuation prompts to prevent premature stopping.

## What it does

When using the `beads` task management system (`bd` CLI), this plugin:

1. Monitors for `session.idle` events
2. Checks if there are beads with `in_progress` status via `bd list --status=in_progress`
3. Shows a countdown toast notification
4. Injects a continuation prompt reminding the agent to complete the current bead

This is similar to Oh-My-OpenCode's `todo-continuation-enforcer`, but for beads instead of the built-in todo system.

## Prerequisites

- `bd` CLI (beads) must be installed and available in PATH
- Project must be initialized with `bd init`

## Installation

Add to your OpenCode config (`~/.config/opencode/config.json`):

```json
{
  "plugins": ["opencode-beads-enforcer"]
}
```

Or for project-level installation, add to `.opencode/config.json`:

```json
{
  "plugins": ["opencode-beads-enforcer"]
}
```

## Configuration

No configuration required. The plugin automatically:

- Skips injection if beads is not initialized in the project
- Respects error cooldowns (3 seconds)
- Cancels countdowns when the assistant is actively working
- Extracts epic context from git branch names (pattern: `bd-XXXXXX`)

## Development

- `mise run build` - Build the plugin
- `mise run test` - Run tests
- `mise run lint` - Lint code
- `mise run lint:fix` - Fix linting issues
- `mise run format` - Format code with Prettier

## License

MIT License. See the [LICENSE](LICENSE) file for details.
