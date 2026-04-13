<p align="center">
  <img src="https://img.shields.io/badge/Claude_Code-Plugin-blueviolet?style=for-the-badge" alt="Claude Code Plugin" />
  <img src="https://img.shields.io/badge/version-0.1.0-blue?style=for-the-badge" alt="Version" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="MIT License" />
</p>

<h1 align="center">
  <br>
  <code>claude-muscle-memory</code>
  <br>
</h1>

<p align="center">
  <strong>Patterns that sharpen through repetition.</strong>
  <br>
  A Claude Code plugin that observes your workflow and turns repeated patterns into automatic reflexes.
</p>

---

## The Problem

Claude has **memory** — CLAUDE.md files, memory records, project context. But it has no **muscle memory**. Every session starts equally naive about *how you work*. It knows what you told it, but it doesn't know what you *do*.

- You correct `grep` to `rg` every session
- You always run tests after editing
- You prefer pnpm, not npm
- You reach for the same commands in the same order

Claude never learns these patterns on its own. Until now.

## How It Works

```
                  ┌─────────────────────────────┐
                  │   You use Claude normally.   │
                  └──────────────┬──────────────┘
                                 │
                  ┌──────────────▼──────────────┐
                  │   Hooks silently observe     │
                  │   every tool use, prompt,    │
                  │   and correction.            │
                  └──────────────┬──────────────┘
                                 │
                  ┌──────────────▼──────────────┐
                  │   Pattern engine detects     │
                  │   repeated behaviors:        │
                  │   commands, workflows,       │
                  │   corrections, preferences.  │
                  └──────────────┬──────────────┘
                                 │
                  ┌──────────────▼──────────────┐
                  │   Patterns gain strength     │
                  │   through repetition.        │
                  │   They decay without it.     │
                  └──────────────┬──────────────┘
                                 │
                  ┌──────────────▼──────────────┐
                  │   Strong patterns inject     │
                  │   into future sessions       │
                  │   automatically.             │
                  └─────────────────────────────┘
```

### The Strength Ladder

Patterns move through four tiers. Repetition pushes them up. Absence lets them fade.

```
  ┌─────────────────────────────────────────────────────┐
  │  REFLEX      ████████████████████  0.8 — 1.0        │
  │  Injected as strong instruction. Automatic.         │
  ├─────────────────────────────────────────────────────┤
  │  ACTIVE      ██████████████░░░░░░  0.5 — 0.8        │
  │  Injected at session start. Claude follows these.   │
  ├─────────────────────────────────────────────────────┤
  │  EMERGING    ████████░░░░░░░░░░░░  0.2 — 0.5        │
  │  Visible in status. Building evidence.              │
  ├─────────────────────────────────────────────────────┤
  │  DORMANT     ███░░░░░░░░░░░░░░░░░  0.0 — 0.2        │
  │  Stored but invisible. Waiting for repetition.      │
  └─────────────────────────────────────────────────────┘

      +0.15 per observation    ×0.95 daily decay
      +0.30 per manual train
```

## What It Detects

| Detector | Example |
|----------|---------|
| **Command frequency** | "User frequently runs `cargo test` after editing .rs files" |
| **Edit sequences** | "Repeated workflow: Edit → Bash → Edit" |
| **Correction patterns** | "User corrects after Bash: 'no, use rg instead of grep'" |
| **Preference patterns** | "User frequently works with .ts files", "Heavy use of Bash tool" |

## Install

```bash
git clone https://github.com/tellertech/claude-muscle-memory.git
cd claude-muscle-memory/server
npm install && npm run build
```

Then add the plugin to Claude Code:

```bash
claude plugin add /path/to/claude-muscle-memory
```

That's it. The plugin starts observing immediately. No configuration needed.

## Usage

### Automatic (just use Claude)

The plugin works silently in the background. As you use Claude across sessions, it:

1. **Observes** every tool use and prompt via hooks
2. **Detects** patterns when new observations arrive
3. **Injects** active patterns at the start of each session

You don't need to do anything. Patterns emerge naturally.

### Skills

Check what muscle memory has learned:

```
/muscle-memory:status
```

Manually teach a preference:

```
/muscle-memory:train always run tests after editing
/muscle-memory:train prefer TypeScript over JavaScript
/muscle-memory:train use pnpm instead of npm
```

Remove a learned pattern:

```
/muscle-memory:forget cargo test
/muscle-memory:forget 7
```

### MCP Tools

The plugin exposes four tools that Claude can call mid-session:

| Tool | What it does |
|------|-------------|
| `muscle_memory_status` | List all patterns, filter by type or strength |
| `muscle_memory_train` | Reinforce or create a pattern manually |
| `muscle_memory_forget` | Remove a pattern by description or ID |
| `muscle_memory_suggest` | Get relevant patterns for the current context |

## Architecture

```
claude-muscle-memory/
├── .claude-plugin/
│   └── plugin.json              Plugin manifest
├── hooks/
│   └── hooks.json               PostToolUse + UserPromptSubmit + SessionStart
├── skills/
│   ├── status/SKILL.md          /muscle-memory:status
│   ├── train/SKILL.md           /muscle-memory:train
│   └── forget/SKILL.md          /muscle-memory:forget
├── .mcp.json                    MCP server config
├── bin/
│   └── muscle-memory            Shell wrapper → node CLI
└── server/
    └── src/
        ├── cli.ts               CLI: observe, analyze, inject, status, train, forget, reset
        ├── mcp-server.ts        MCP server with 4 tools (stdio transport)
        ├── patterns.ts          4 pattern detectors
        ├── strength.ts          Reinforcement + decay math
        ├── store.ts             SQLite store (~/.claude-muscle-memory/patterns.db)
        └── types.ts             Shared type definitions
```

**Data flow:**

```
 Hook fires                    Pattern engine               Session start
 (PostToolUse,      observe    detects habits    inject     injects active
  UserPromptSubmit) ───────►   from observations ────────►  patterns into
                               + applies decay              Claude's context
                    ┌──────────────────────────────────┐
                    │  ~/.claude-muscle-memory/         │
                    │  patterns.db (SQLite)             │
                    └──────────────────────────────────┘
```

## CLI Reference

```bash
bin/muscle-memory status          # Show all patterns by strength tier
bin/muscle-memory analyze         # Run pattern detection on new observations
bin/muscle-memory inject          # Output active patterns as session context
bin/muscle-memory train "desc"    # Manually teach a pattern (+0.30)
bin/muscle-memory forget "desc"   # Remove a pattern
bin/muscle-memory reset           # Clear all data
```

## Privacy

All data stays on your machine. Observations and patterns are stored in `~/.claude-muscle-memory/patterns.db` (SQLite). Nothing is sent anywhere. The database contains:

- **Observations**: tool names, commands, file paths, prompt text
- **Patterns**: detected habits with strength scores
- **No secrets**: the plugin stores commands and tool names, not file contents or credentials

Run `bin/muscle-memory reset` to wipe everything at any time.

## How It Compares

| Project | Approach | What it remembers |
|---------|----------|------------------|
| CLAUDE.md | Static config | What you wrote manually |
| claude-mem | Session replay | What was discussed |
| claude-supermemory | Cloud knowledge store | Facts and decisions |
| BrainBox | Hebbian learning | File co-access patterns |
| **muscle-memory** | **Behavioral pattern inference** | **How you work** |

Every existing tool remembers *what was said*. This one learns *what you do*.

## License

MIT

---

<p align="center">
  Built by <a href="https://github.com/tellertech">TellerTech</a>
</p>
