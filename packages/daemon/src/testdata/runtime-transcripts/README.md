These redacted JSONL snippets are synthetic local fixtures for runtime stall
detection tests. They preserve only event shape, timing, role, and tool names
needed to exercise negative-control transcript checks; private prompts,
reasoning content, command output, and absolute paths are intentionally omitted.

Codex no longer uses transcript mtime as a liveness source. Its internal
progress is driven by raw response item events instead.
