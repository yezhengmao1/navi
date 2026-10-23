// Intentionally conservative: deterministic routing of explicit review requests,
// not a claim to recognize arbitrary natural language or to authorize execution.
export function routeReview(text) {
  if (typeof text !== 'string' || text.startsWith('/') || text.includes('[magic-review routed]')) return null;
  const intent = text.split('\n')[0].slice(0, 200);
  // Implementation/delegation prompts may quote review keywords as data. Never
  // rewrite their task into a review, especially in inherited team sessions.
  if (/implement|develop|build|write|实现|开发|编写|不要|别审|不需要|don't|do not|how to|怎么(?:做|实现)|如何(?:做|实现)/i.test(intent)) return null;
  if (!/(?:review|审查|审一下|审稿|检查|评审)/i.test(intent)) return null;
  const paper = /(?:\.tex\b|论文|paper|latex)/i.test(intent);
  const code = /(?:commit|提交|代码|\bcode\b)/i.test(intent);
  if (paper === code) return null;
  const kind = paper ? 'paper' : 'code';
  const team = /(?:\bteam\b|团队|多(?:个)?\s*agent)/i.test(text);
  return { kind, team };
}

export function decodeEvidence(text) {
  return JSON.parse(text, (_key, value) => value && value.encoding === 'concatenate-chunks' && Array.isArray(value.chunks)
    ? value.chunks.join('') : value);
}
