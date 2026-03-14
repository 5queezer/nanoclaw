/**
 * Access tracker stub for memory retrieval pipeline.
 * Tracks memory access patterns for reinforcement-based time decay.
 */

export interface AccessMetadata {
  accessCount: number;
  lastAccessedAt: number;
}

/**
 * Parse access metadata from a memory entry's metadata JSON string.
 */
export function parseAccessMetadata(metadata?: string): AccessMetadata {
  if (!metadata) return { accessCount: 0, lastAccessedAt: 0 };
  try {
    const parsed = JSON.parse(metadata);
    return {
      accessCount: typeof parsed._accessCount === "number" ? parsed._accessCount : 0,
      lastAccessedAt: typeof parsed._lastAccessedAt === "number" ? parsed._lastAccessedAt : 0,
    };
  } catch {
    return { accessCount: 0, lastAccessedAt: 0 };
  }
}

/**
 * Compute effective half-life for time decay, extended by access frequency.
 * More frequently accessed memories decay slower.
 */
export function computeEffectiveHalfLife(
  baseHalfLife: number,
  accessCount: number,
  _lastAccessedAt: number,
  reinforcementFactor: number,
  maxMultiplier: number,
): number {
  if (accessCount <= 0 || reinforcementFactor <= 0) return baseHalfLife;
  const multiplier = Math.min(
    1 + reinforcementFactor * Math.log2(1 + accessCount),
    maxMultiplier,
  );
  return baseHalfLife * multiplier;
}

/**
 * Tracks memory access patterns to reinforce frequently recalled memories.
 */
export class AccessTracker {
  private accessLog = new Map<string, { count: number; lastAt: number }>();

  recordAccess(ids: string[]): void {
    const now = Date.now();
    for (const id of ids) {
      const existing = this.accessLog.get(id);
      this.accessLog.set(id, {
        count: (existing?.count ?? 0) + 1,
        lastAt: now,
      });
    }
  }

  getAccessInfo(id: string): { count: number; lastAt: number } | undefined {
    return this.accessLog.get(id);
  }
}
