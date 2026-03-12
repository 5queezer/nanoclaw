---
name: add-lancedb-memory
description: Add semantic memory to container agents using LanceDB + Gemini embeddings. Agents get 4 MCP tools (memory_store, memory_search, memory_delete, memory_count) for persistent vector-based recall across sessions.
---

# Add Semantic Memory (LanceDB + Gemini)

This skill adds persistent semantic memory to container agents via 4 MCP tools. Agents can store facts, decisions, and preferences, then retrieve them by semantic similarity across sessions.

Tools added:
- `memory_store` — store a memory with category and importance
- `memory_search` — search by semantic similarity (natural language)
- `memory_delete` — delete a memory by ID
- `memory_count` — count total stored memories

Uses LanceDB for vector storage and Gemini `embedding-001` for 3072-dimensional embeddings. Supports local storage (default) or LanceDB Cloud.

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/memory.ts` exists. If it does, skip to Phase 3 (Configure).

### Check prerequisites

A Gemini API key is required for embeddings. Ask the user:

> Do you have a Gemini API key? If not, get one free at https://aistudio.google.com/apikey
>
> The free tier includes 1,500 requests/day for embedding — more than enough for personal use.

Wait for the user to provide the key.

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/add-lancedb-memory
git merge upstream/skill/add-lancedb-memory
```

This merges in:
- `container/agent-runner/src/memory.ts` (LanceDB + Gemini embedding logic)
- Memory MCP tools in `container/agent-runner/src/ipc-mcp-stdio.ts` (memory_store, memory_search, memory_delete, memory_count)
- `@lancedb/lancedb` and `apache-arrow` dependencies in `container/agent-runner/package.json`
- `GEMINI_API_KEY`, `LANCEDB_URI`, `LANCEDB_API_KEY` env passthrough in `src/container-runner.ts`
- `scripts/migrate-memories.mjs` (optional migration tool for OpenClaw backups)

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Copy the new files:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/memory.ts "$dir/"
  cp container/agent-runner/src/ipc-mcp-stdio.ts "$dir/"
done
```

### Validate code changes

```bash
npm run build
./container/build.sh
```

Build must be clean before proceeding.

## Phase 3: Configure

### Set Gemini API key

Add to `.env`:

```bash
GEMINI_API_KEY=your-gemini-api-key-here
```

### LanceDB Cloud (optional)

By default, memories are stored locally in each group's workspace at `/workspace/group/memory/lancedb`. For cloud storage, add:

```bash
LANCEDB_URI=db://your-database
LANCEDB_API_KEY=your-lancedb-api-key
```

The local path can be overridden per-container with the `MEMORY_LANCEDB_DIR` environment variable.

### Sync environment

```bash
mkdir -p data/env && cp .env data/env/env
```

### Restart the service

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
# systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test via messaging

Tell the user:

> Send a message like: "Remember that my favorite language is TypeScript"
>
> Then in a later message: "What's my favorite language?"
>
> The agent should use `memory_store` to save the fact, and `memory_search` to retrieve it.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i memory
```

Look for:
- `memory_store` / `memory_search` in container logs — agent used memory tools
- Errors with "GEMINI_API_KEY" — key not set or invalid

## Troubleshooting

### "GEMINI_API_KEY not set"

The key isn't reaching the container. Verify:
1. `.env` has `GEMINI_API_KEY=...`
2. `data/env/env` is synced: `cp .env data/env/env`
3. Service was restarted after changing `.env`

### "Gemini embedding failed (400)"

Usually means the text is too long. Gemini `embedding-001` has an 8192-token limit per request. If storing very long memories, truncate or summarize first.

### Memories not persisting across sessions

Each group stores memories in its own workspace. If the group folder is deleted or recreated, memories are lost. For persistent storage across reinstalls, use LanceDB Cloud (`LANCEDB_URI`).

### Agent doesn't use memory tools

The agent may not know about the tools. Try being explicit: "use the memory_store tool to remember that..." or check that the MCP server is registered in the container's agent-runner.

## Migration

To import memories from an OpenClaw JSONL backup:

```bash
GEMINI_API_KEY=your-key node scripts/migrate-memories.mjs path/to/backup.jsonl
```

This re-embeds each memory with Gemini and stores it in LanceDB.

## Removal

To remove semantic memory:

1. Remove `memory.ts` from `container/agent-runner/src/`
2. Remove memory tool registrations from `container/agent-runner/src/ipc-mcp-stdio.ts` (the 4 `server.tool` blocks for `memory_store`, `memory_search`, `memory_delete`, `memory_count` and the `import` line)
3. Remove `@lancedb/lancedb` and `apache-arrow` from `container/agent-runner/package.json`
4. Remove `GEMINI_API_KEY` / `LANCEDB_URI` / `LANCEDB_API_KEY` passthrough from `src/container-runner.ts`
5. Remove env vars from `.env` and `data/env/env`
6. Rebuild: `npm run build && ./container/build.sh`
7. Restart service
