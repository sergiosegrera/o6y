const words = (text: string) => text.toLowerCase().match(/[a-z]{3,}/g) ?? [];

/** A stand-in for Cohere: hashed bag-of-words embeddings, word-overlap rerank. Records every call. */
export function fakeCohere() {
  const calls: { endpoint: string; body: any }[] = [];
  const embed = (text: string) => {
    const v = new Array(64).fill(0);
    for (const w of words(text)) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 64, 7)] += 1;
    return v;
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const endpoint = url.split("/v2/")[1]!;
    const body = JSON.parse(String(init.body));
    calls.push({ endpoint, body });
    if (endpoint === "embed") return Response.json({ embeddings: { float: body.texts.map(embed) } });
    const q = new Set(words(body.query));
    const results = body.documents
      .map((d: string, index: number) => ({ index, relevance_score: [...new Set(words(d))].filter((w) => q.has(w)).length / Math.max(q.size, 1) }))
      .sort((a: any, b: any) => b.relevance_score - a.relevance_score)
      .slice(0, body.top_n);
    return Response.json({ results });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl, embedded: () => calls.filter((c) => c.endpoint === "embed" && c.body.input_type === "search_document").flatMap((c) => c.body.texts) };
}
