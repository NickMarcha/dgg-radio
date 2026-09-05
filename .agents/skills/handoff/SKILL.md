---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
---

Update `docs/handoff.md`, the one rolling handoff, so a fresh agent can pick the
work up. Rewrite the sections this session changed rather than appending to them,
and do not create a second handoff anywhere else — not in the workspace, and not
in the OS temporary directory. A handoff outside the repository is one nobody
finds: the next session reads the repository, and a file in `%TEMP%` is invisible
to every search scoped to the project.

Session narrative belongs in git history. What belongs here is the state of the
room, what is waiting on a person, and the things that are true but not visible
in the code.

Include a "Suggested skills" section naming which skills the next agent should
call the Skill tool for.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs,
issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally
identifiable information.

If the user passed arguments, treat them as a description of what the next
session will focus on and weight the document accordingly.
