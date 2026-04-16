import dns from 'node:dns/promises';
import net from 'node:net';
import { URL } from 'node:url';
import * as cheerio from 'cheerio';
import { logger } from './logger.js';

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_BYTES = 512 * 1024;

const PRIVATE_IP_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|fc|fd|fe80|::1|100\.(6[4-9]|[7-9]\d|1[0-2]\d))/i;

async function isSafeUrl(urlStr: string): Promise<boolean> {
  try {
    const parsed = new URL(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname;
    if (hostname === 'localhost' || hostname === '[::1]') return false;
    if (net.isIP(hostname) && PRIVATE_IP_RE.test(hostname)) return false;
    const { address } = await dns.lookup(hostname);
    if (PRIVATE_IP_RE.test(address)) return false;
    return true;
  } catch {
    return false;
  }
}

export interface EnrichedUrl {
  url: string;
  title: string | null;
}

export async function enrichUrls(text: string): Promise<EnrichedUrl[]> {
  const found = Array.from(new Set(text.match(URL_RE) ?? []));
  if (found.length === 0) return [];
  // Keep it bounded — only look at the first 3 urls to avoid abuse.
  const targets = found.slice(0, 3);
  const results = await Promise.all(targets.map((u) => fetchTitle(u)));
  return results;
}

async function fetchTitle(url: string): Promise<EnrichedUrl> {
  try {
    if (!(await isSafeUrl(url))) {
      logger.debug({ url }, 'url blocked by SSRF filter');
      return { url, title: null };
    }
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
      headers: {
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return { url, title: null };
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('xml')) return { url, title: null };
    const buf = await readBounded(res, MAX_BYTES);
    const html = new TextDecoder('utf-8').decode(buf);
    const $ = cheerio.load(html);
    const og = $('meta[property="og:title"]').attr('content')?.trim();
    const twitter = $('meta[name="twitter:title"]').attr('content')?.trim();
    const tag = $('title').first().text().trim();
    const title = (og || twitter || tag) ?? null;
    return { url, title: title && title.length > 0 ? title.slice(0, 300) : null };
  } catch (err) {
    logger.debug({ err, url }, 'url enrich failed');
    return { url, title: null };
  }
}

async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* noop */
      }
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    if (off + c.byteLength > maxBytes) {
      out.set(c.subarray(0, maxBytes - off), off);
      break;
    }
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function augmentTextWithUrls(text: string, enriched: EnrichedUrl[]): string {
  const withTitle = enriched.filter((e): e is EnrichedUrl & { title: string } => !!e.title);
  if (withTitle.length === 0) return text;
  const extras = withTitle
    .map((e) => `[Attached URL] ${e.url}\nTitle: ${e.title}`)
    .join('\n');
  return `${text}\n\n${extras}`;
}

export function urlsAsNotes(enriched: EnrichedUrl[]): string {
  return enriched
    .map((e) => (e.title ? `🔗 ${e.title}\n${e.url}` : `🔗 ${e.url}`))
    .join('\n');
}
