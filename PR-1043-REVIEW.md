# PR Review: feat: upgrade memory to memory-lancedb-pro (hybrid BM25+vector retrieval)

Solid upgrade from basic vector-only search to a hybrid retrieval system with BM25, reranking, recency boost, and MMR diversity. The public API is preserved, the SKILL.md is well-structured, and the container-runner env passthrough is clean. However, there are several issues that should be addressed before merge.

---

## Critical

**1. Missing `chunker.js` dependency — `memory-embedder.ts` will crash at import time**
- `memory-embedder.ts:3` imports `import { smartChunk } from "./chunker.js"`, but no `chunker.ts` or `chunker.js` exists anywhere in this branch. The module will fail to load at runtime, making the entire memory system non-functional.
- **Fix:** Add the missing `chunker.ts` file, or remove the import and disable the auto-chunking codepath.

**2. `migrate-memories.mjs` still uses `Float32Array` despite commit `6445f1b` fixing this**
- `scripts/migrate-memories.mjs:83` uses `new Float32Array(vector)`, but commit `6445f1b` ("fix: use plain array for LanceDB Cloud vector insert") was specifically about replacing typed arrays with plain arrays. The migration script was missed.
- **Fix:** Change to `vector: Array.from(vector)` for consistency with the main store.

---

## High

**3. SQL injection in `memory-store.ts` `bulkDelete()`**
- `beforeTimestamp` is interpolated directly into a SQL string: `` conditions.push(`timestamp < ${beforeTimestamp}`) ``. While typed as `number`, there's no runtime validation. A non-numeric value could alter the query.
- **Fix:** Guard with `Number.isFinite(beforeTimestamp)` before interpolation.

**4. `delete()` skips `escapeSqlLiteral` for full UUID IDs**
- The `isFullId` branch in `delete()` interpolates `id` directly into SQL: `` `.where(`id = '${id}'`)`` while every other method uses `escapeSqlLiteral`. Inconsistent defense-in-depth.
- **Fix:** Use `escapeSqlLiteral(id)` consistently.

**5. Non-atomic `update()` — delete-then-add can lose data**
- `update()` deletes the old entry then adds the new one. If the process crashes or `add()` fails after `delete()` succeeds, the memory entry is permanently lost.
- **Fix:** Wrap in try/catch that re-inserts the original on failure, or document the risk.

**6. "RRF fusion" in `memory-retriever.ts` is not actually RRF**
- Comments and trace labels reference "Reciprocal Rank Fusion," but the implementation uses a fixed 15% BM25 bonus on top of the vector score. Real RRF uses `1 / (k + rank)`. Either implement actual RRF or rename the method/comments to reflect the weighted boosting approach.

**7. N+1 sequential `hasId()` calls in `fuseResults()`**
- `memory-retriever.ts` ~line 723: every BM25-only result triggers an individual `await this.store.hasId(id)` inside a `for...of` loop. With many BM25-only hits, this serializes into many sequential store lookups.
- **Fix:** Batch-collect IDs, then validate in a single query or `Promise.all`.

**8. `embedSingle()` recursive chunking can stack-overflow**
- If `smartChunk` produces chunks that still exceed the provider's context limit, each chunk recursively calls `embedSingle` -> catches context error -> calls `smartChunk` -> recurses infinitely.
- **Fix:** Add a recursion depth guard or use a non-recursive approach for chunk embedding.

**9. `embedMany()` returns `[]` (empty array) for skipped texts**
- Callers expect a vector of length `dimensions`. Returning `[]` silently will cause downstream issues (LanceDB schema violations, undefined vector ops).
- **Fix:** Throw for empty texts, or return a zero-vector of correct dimensions.

---

## Medium

**10. No normalization of averaged chunk embeddings**
- When text is chunked and embeddings are averaged, the resulting vector is not L2-normalized. If the provider returns unit-norm vectors, the averaged result will have sub-unit norm, degrading cosine similarity quality.

**11. Cosine fallback reranker doesn't verify vector provenance**
- `memory-retriever.ts` ~line 906: `cosineSimilarity(queryVector, result.entry.vector)` assumes stored vectors use the same embedding model as the query. After a model upgrade, stored vectors would be from a different vector space, making cosine similarity meaningless.

**12. `list()` and `stats()` fetch entire dataset into memory**
- Both methods load all matching rows into JS arrays for app-layer sorting/counting. For stores with thousands of memories, this creates unnecessary memory pressure.

**13. Context-error detection regex is too broad**
- `/context|too long|exceed|length/i` matches unrelated errors (e.g., "invalid content-length header"). This could trigger the chunking fallback for non-context-limit errors.
- **Fix:** Tighten to `/context.length|token.limit|too.long|max.tokens.*exceeded/i`.

**14. `vectorSearch` score formula may not map cosine distance correctly**
- `score = 1 / (1 + distance)` with LanceDB cosine distance (range 0-2) maps distance=2 to score=0.33. The default `minScore: 0.3` therefore filters almost nothing.

**15. No batch size limit in `embedMany()`**
- The entire array is sent in one API call. Most embedding APIs cap batch sizes (e.g., OpenAI at 2048). Large batches will fail with opaque provider errors.

---

## Low / Nits

- **`metadata` field accepts arbitrary strings** — no JSON validation before storing. Invalid JSON could break consumers.
- **`bm25Search` query string not sanitized** — FTS operators (`AND`, `OR`, `*`) could alter query semantics.
- **Inconsistent vector return types** — `vectorSearch` returns raw Arrow references, `getById` uses `Array.from()`, `list` returns `[]`.
- **No `close()`/cleanup method** on `MemoryStore` — file handles and connections can leak.
- **Schema bootstrap creates then deletes a dummy `__schema__` row** — if delete fails, phantom entry appears in search results.
- **`importEntry` doesn't check for duplicate IDs** — calling twice creates duplicates.
- **Reranker timeout hardcoded at 5s** — should be configurable for slow networks/local models.
- **`loadLanceDB()` caches rejected import promises permanently** — transient import failures never recover.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 7 |
| Medium | 6 |
| Low | 8 |

**The missing `chunker.js` is a ship-blocker** — the memory system won't load at all without it. After fixing that, the most impactful changes are: the SQL injection in `bulkDelete`, the non-RRF fusion naming, the N+1 `hasId` calls, and the recursive chunking risk in the embedder.

The architecture and API design are sound. The SKILL.md installation guide is thorough. The `container-runner.ts` changes for env passthrough are clean and follow the existing `readEnvFile` pattern well.
