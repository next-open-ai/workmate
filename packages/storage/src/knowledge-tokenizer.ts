/** Version 1: deterministic tokens, no native extension or locale-dependent dictionary. */
export function knowledgeTokens(input: string, query = false): string[] {
  const tokens: string[] = [];
  const encode = (prefix: string, value: string) => prefix + Buffer.from(value).toString('hex');
  for (const run of input.normalize('NFKC').toLowerCase().match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu) ?? []) {
    if (/^\p{Script=Han}/u.test(run)) {
      const chars = [...run];
      if (!query || chars.length === 1) tokens.push(...chars.map((char) => encode('u', char)));
      for (let i = 0; i + 1 < chars.length; i++) tokens.push(encode('b', chars[i] + chars[i + 1]));
    } else tokens.push(encode('w', run));
  }
  return query ? [...new Set(tokens)].slice(0, 64) : tokens;
}
