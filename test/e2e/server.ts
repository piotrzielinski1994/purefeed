import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { basename, extname, join, normalize } from 'node:path';
import { GENERATED_DIR } from '../../scripts/generate-assets.ts';

export type RequestLogEntry = {
  host: string;
  path: string;
  bytesSent: number;
  hasBody: boolean;
  fromExtension: boolean;
  status: number;
  range: string | null;
  origin: string | null;
  referer: string | null;
};

export type FixtureServer = { port: number; log: RequestLogEntry[]; close(): Promise<void> };

const ROOT = join(import.meta.dirname, '..', '..');
const CERT_DIR = join(ROOT, '.cache', 'e2e-cert');
const FIXTURES_DIR = join(ROOT, 'test', 'fixtures');
const NO_CORS_HOST = 'media2.test';
const CHUNK_BYTES = 64 * 1024;
const PAGES = new Map<string, string>();

export function servePage(url: string, html: string): void {
  const u = new URL(url);
  PAGES.set(`${u.hostname}${u.pathname}${u.search}`, html);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function ensureCert(): { key: Buffer; cert: Buffer } {
  const keyPath = join(CERT_DIR, 'key.pem');
  const certPath = join(CERT_DIR, 'cert.pem');
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    mkdirSync(CERT_DIR, { recursive: true });
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-days',
        '3650',
        '-subj',
        '/CN=purefeed-e2e',
        '-keyout',
        keyPath,
        '-out',
        certPath,
      ],
      { stdio: 'ignore' },
    );
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

const header = (req: IncomingMessage, name: string): string | null => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
};

function isFromExtension(req: IncomingMessage): boolean {
  const origin = header(req, 'origin') ?? '';
  const referer = header(req, 'referer') ?? '';
  if (origin.startsWith('chrome-extension://') || referer.startsWith('chrome-extension://')) return true;
  return referer === '' && header(req, 'sec-fetch-site') === 'none' && header(req, 'sec-fetch-dest') !== 'document';
}

function resolveFile(host: string, pathname: string): string | null {
  if (pathname.startsWith('/fixture/')) {
    const relative = normalize(pathname.slice('/fixture/'.length));
    if (relative.startsWith('..')) return null;
    const file = join(FIXTURES_DIR, relative);
    return existsSync(file) ? file : null;
  }
  const file = join(GENERATED_DIR, basename(pathname));
  return host && existsSync(file) && statSync(file).isFile() ? file : null;
}

function parseRange(range: string | null, size: number): { start: number; end: number } | null {
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, from, to] = match;
  if (from === '') {
    const suffix = Number(to);
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  return start <= end && start < size ? { start, end } : null;
}

function sendFile(req: IncomingMessage, res: ServerResponse, entry: RequestLogEntry, file: string): void {
  const size = statSync(file).size;
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const range = parseRange(entry.range, size);
  const { start, end } = range ?? { start: 0, end: size - 1 };
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', String(end - start + 1));
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  entry.status = range ? 206 : 200;
  res.writeHead(entry.status);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end, highWaterMark: CHUNK_BYTES });
  stream.on('data', (chunk) => {
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (!res.write(chunk, () => (entry.bytesSent += size))) {
      stream.pause();
      res.once('drain', () => stream.resume());
    }
  });
  stream.on('end', () => res.end());
  res.on('close', () => stream.destroy());
}

function handle(req: IncomingMessage, res: ServerResponse, log: RequestLogEntry[], hanging: Set<ServerResponse>): void {
  const host = (header(req, 'host') ?? '').replace(/:\d+$/, '');
  const url = new URL(req.url ?? '/', `https://${host}`);
  const entry: RequestLogEntry = {
    host,
    path: `${url.pathname}${url.search}`,
    bytesSent: 0,
    hasBody: Number(header(req, 'content-length') ?? 0) > 0 || header(req, 'transfer-encoding') !== null,
    fromExtension: isFromExtension(req),
    status: 0,
    range: header(req, 'range'),
    origin: header(req, 'origin'),
    referer: header(req, 'referer'),
  };
  log.push(entry);
  const page = PAGES.get(`${host}${url.pathname}${url.search}`);
  if (page !== undefined) {
    entry.status = 200;
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(page, () => (entry.bytesSent += Buffer.byteLength(page)));
    return;
  }
  if (host !== NO_CORS_HOST && url.pathname.startsWith('/redirect-nocors/')) {
    entry.status = 302;
    res.writeHead(302, { Location: `https://${NO_CORS_HOST}/${basename(url.pathname)}` });
    res.end();
    return;
  }
  if (url.pathname.startsWith('/stall/')) {
    entry.status = 200;
    res.writeHead(200, { 'Content-Type': MIME[extname(url.pathname)] ?? 'application/octet-stream', 'Content-Length': '10000000' });
    res.write(Buffer.alloc(16), () => (entry.bytesSent += 16));
    hanging.add(res);
    return;
  }
  const file = resolveFile(host, url.pathname);
  if (!file) {
    entry.status = 404;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  sendFile(req, res, entry, file);
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const log: RequestLogEntry[] = [];
  const hanging = new Set<ServerResponse>();
  const sockets = new Set<Socket>();
  const server = createServer(ensureCert(), (req, res) => handle(req, res, log, hanging));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of hanging) res.destroy();
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
