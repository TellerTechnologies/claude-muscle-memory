---
name: status
description: Show all learned muscle memory patterns grouped by strength tier
user_invocable: true
---

# Muscle Memory Status

Show the user their learned muscle memory patterns.

## Steps

1. Call the `muscle_memory_status` MCP tool with no filters to get all patterns
2. Present the results to the user, organized by strength tier:
   - **Reflex** (0.8-1.0): Strong habits followed automatically
   - **Active** (0.5-0.8): Established preferences injected at session start
   - **Emerging** (0.2-0.5): Patterns forming but not yet active
   - **Dormant** (0.0-0.2): Stored but inactive
3. Include the total observation count and pattern count
4. If no patterns exist, let the user know that patterns will emerge as they use Claude
