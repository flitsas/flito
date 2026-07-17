/** Extrae texto de bloques `content` de la respuesta Anthropic Messages API. */
export function extractAnthropicText(data: unknown): string {
  const blocks = (data as { content?: unknown })?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b): b is { type?: string; text: string } => {
      if (!b || typeof b !== 'object') return false;
      const block = b as { type?: string; text?: string };
      return typeof block.text === 'string' && (!block.type || block.type === 'text');
    })
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Parsea JSON biométrico aunque venga con markdown o texto alrededor. */
export function parseBiometricJson(raw: string): Record<string, unknown> | null {
  if (!raw?.trim()) return null;

  const candidates: string[] = [];
  const trimmed = raw.trim();
  candidates.push(trimmed);
  candidates.push(trimmed.replace(/```json\s*/gi, '').replace(/```/g, '').trim());

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // siguiente candidato
    }
  }
  return null;
}
