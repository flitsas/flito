import https from 'https';

export interface DownloadOptions {
  allowedHostMatcher: (host: string) => boolean;
  maxBytes: number;
  maxRedirects?: number;
  timeoutMs?: number;
  userAgent?: string;
  acceptHeader?: string;
}

/**
 * Descarga HTTPS con guardas: whitelist de hosts (incluso tras redirects), límite de tamaño,
 * tope de redirects, timeout. Devuelve el cuerpo como string UTF-8.
 */
export async function downloadWithGuards(url: string, opts: DownloadOptions): Promise<string> {
  const max = opts.maxRedirects ?? 5;
  return downloadInternal(url, opts, 0, max);
}

function downloadInternal(url: string, opts: DownloadOptions, redirects: number, max: number): Promise<string> {
  if (redirects > max) return Promise.reject(new Error('demasiados redirects'));
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') return Promise.reject(new Error(`protocolo no permitido (${parsed.protocol})`));
  if (!opts.allowedHostMatcher(parsed.host)) return Promise.reject(new Error(`host no permitido (${parsed.host})`));

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': opts.userAgent ?? 'Kyverum-Operaciones/1.0',
    };
    if (opts.acceptHeader) headers['Accept'] = opts.acceptHeader;

    const req = https.get(url, { timeout: opts.timeoutMs ?? 60_000, headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        downloadInternal(next, opts, redirects + 1, max).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (c: Buffer) => {
        bytes += c.length;
        if (bytes > opts.maxBytes) {
          req.destroy(new Error(`descarga excede ${opts.maxBytes} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('download timeout')); });
  });
}
