---
name: train
description: Manually teach muscle memory a pattern or preference
user_invocable: true
---

# Muscle Memory Train

Manually reinforce or create a pattern in muscle memory.

## Usage

`/muscle-memory:train <description of the pattern>`

Examples:
- `/muscle-memory:train always run tests after editing`
- `/muscle-memory:train prefer TypeScript over JavaScript`
- `/muscle-memory:train use pnpm instead of npm`

## Steps

1. Take the user's description from the command arguments
2. Call the `muscle_memory_train` MCP tool with the description
3. Report whether an existing pattern was reinforced or a new one was created
4. Show the new strength value
