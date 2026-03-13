/**
 * Semantic memory powered by memory-lancedb-pro.
 * Hybrid retrieval: vector + BM25, cross-encoder reranking, recency boost.
 * Supports local (default) or cloud via LANCEDB_URI + LANCEDB_API_KEY.
 */

import { MemoryStore } from './memory-store.js';
import { MemoryRetriever } from './memory-retriever.js';
import { Embedder } from './memory-embedder.js';

// ── Config ────────────────────────────────────────────────────────────────────

const LANCEDB_URI     = process.env.LANCEDB_URI     || '';
const LANCEDB_API_KEY = process.env.LANCEDB_API_KEY || '';
const LOCAL_DB_DIR    = process.env.MEMORY_LANCEDB_DIR || '/workspace/group/memory/lancedb';

const GEMINI_API_KEY  = process.env.GEMINI_API_KEY  || '';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIM   = parseInt(process.env.EMBEDDING_DIM || '3072', 10);

// Gemini exposes an OpenAI-compatible embeddings endpoint
const GEMINI_OPENAI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai/';

// ── Singletons ────────────────────────────────────────────────────────────────

let _store: MemoryStore | null = null;
let _embedder: Embedder | null = null;
let _retriever: MemoryRetriever | null = null;

function getStore(): MemoryStore {
  if (!_store) {
    _store = new MemoryStore({
      dbPath:    LANCEDB_URI || LOCAL_DB_DIR,
      vectorDim: EMBEDDING_DIM,
      apiKey:    LANCEDB_URI ? (LANCEDB_API_KEY || undefined) : undefined,
    });
  }
  return _store;
}

function getEmbedder(): Embedder {
  if (!_embedder) {
    _embedder = new Embedder({
      apiKey:     GEMINI_API_KEY,
      baseURL:    GEMINI_OPENAI_BASE,
      model:      EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIM,
    });
  }
  return _embedder;
}

function getRetriever(): MemoryRetriever {
  if (!_retriever) {
    _retriever = new MemoryRetriever(getStore(), getEmbedder());
  }
  return _retriever;
}

// ── Public API (drop-in replacement for basic memory.ts) ─────────────────────

export async function memoryStore(
  text: string,
  category: string = 'general',
  importance: number = 0.7,
  meta: Record<string, unknown> = {},
): Promise<string> {
  const store = getStore();
  const embedder = getEmbedder();
  const vector = await embedder.embed(text);

  const entry = await store.store({
    text,
    category: normalizeCategory(category),
    scope: 'global',
    importance,
    metadata: JSON.stringify(meta),
    vector,
  });

  return entry.id;
}

export async function memorySearch(
  query: string,
  limit: number = 5,
  category?: string,
): Promise<Array<{
  id: string;
  text: string;
  category: string;
  importance: number;
  timestamp: number;
  metadata: string;
  _distance: number;
}>> {
  const retriever = getRetriever();

  const results = await retriever.retrieve({
    query,
    limit,
    scopeFilter: ['global'],
    ...(category ? { category: normalizeCategory(category) } : {}),
    source: 'manual',
  });

  return results.map(r => ({
    id:         r.entry.id,
    text:       r.entry.text,
    category:   r.entry.category,
    importance: r.entry.importance,
    timestamp:  r.entry.timestamp,
    metadata:   r.entry.metadata ?? '{}',
    _distance:  1 - r.score,
  }));
}

export async function memoryDelete(id: string): Promise<void> {
  const store = getStore();
  // store.delete() validates UUID format — strip the "mem-" prefix if present
  const uuid = id.startsWith('mem-') ? id.slice(4) : id;
  await store.delete(uuid);
}

export async function memoryCount(): Promise<number> {
  const store = getStore();
  const stats = await store.stats();
  return stats.totalCount;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type ProCategory = 'preference' | 'fact' | 'decision' | 'entity' | 'other' | 'reflection';

function normalizeCategory(cat: string): ProCategory {
  const map: Record<string, ProCategory> = {
    preference: 'preference',
    decision:   'decision',
    entity:     'entity',
    fact:       'fact',
    reflection: 'reflection',
    event:      'other',
    general:    'other',
  };
  return map[cat.toLowerCase()] ?? 'other';
}
