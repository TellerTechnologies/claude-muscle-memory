---
name: forget
description: Remove a learned pattern from muscle memory
user_invocable: true
---

# Muscle Memory Forget

Remove a learned pattern from muscle memory.

## Usage

`/muscle-memory:forget <description or ID>`

Examples:
- `/muscle-memory:forget cargo test` — removes a pattern matching "cargo test"
- `/muscle-memory:forget 7` — removes pattern with ID 7

## Steps

1. Take the user's input from the command arguments
2. Call the `muscle_memory_forget` MCP tool with the pattern description or ID
3. Confirm to the user which pattern was removed, or report if no match was found
