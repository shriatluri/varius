/**
 * Embeddings are the recall half of hybrid retrieval — they are what makes
 * "the auth thing" find "rejected session cookies because…".
 *
 * Pluggable and optional by design: with no key configured the index and the
 * search still work, lexically. The provider is a `.env` line, never a code
 * change (architecture.md §11's "keep that seam clean").
 */
export interface Embedder {
  model: string;
  dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

const BATCH = 64;

interface ProviderSpec {
  url: string;
  key: string;
  model: string;
  dims: number;
}

function spec(): ProviderSpec | null {
  const provider = process.env.VARIUS_EMBED_PROVIDER
    ?? (process.env.VOYAGE_API_KEY ? 'voyage' : process.env.OPENAI_API_KEY ? 'openai' : 'none');

  if (provider === 'none') return null;
  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('VARIUS_EMBED_PROVIDER=openai but OPENAI_API_KEY is unset');
    return {
      url: 'https://api.openai.com/v1/embeddings',
      key,
      model: process.env.VARIUS_EMBED_MODEL ?? 'text-embedding-3-small',
      dims: 1536,
    };
  }
  if (provider === 'voyage') {
    const key = process.env.VOYAGE_API_KEY;
    if (!key) throw new Error('VARIUS_EMBED_PROVIDER=voyage but VOYAGE_API_KEY is unset');
    return {
      url: 'https://api.voyageai.com/v1/embeddings',
      key,
      model: process.env.VARIUS_EMBED_MODEL ?? 'voyage-3.5-lite',
      dims: 1024,
    };
  }
  throw new Error(`unknown VARIUS_EMBED_PROVIDER "${provider}" (openai | voyage | none)`);
}

/** Null when no provider is configured — callers degrade to lexical-only. */
export function loadEmbedder(): Embedder | null {
  const provider = spec();
  if (!provider) return null;

  return {
    model: provider.model,
    dims: provider.dims,
    async embed(texts: string[]): Promise<number[][]> {
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        const res = await fetch(provider.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.key}` },
          body: JSON.stringify({ model: provider.model, input: batch }),
        });
        if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const body = (await res.json()) as { data: { embedding: number[]; index?: number }[] };
        const sorted = [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        vectors.push(...sorted.map((d) => d.embedding));
      }
      return vectors;
    },
  };
}
