'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { marked } = require('marked');
const mime = { '.md': 'text/markdown', '.markdown': 'text/markdown', '.html': 'text/html', '.htm': 'text/html', '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'text/plain', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.csv': 'text/plain', '.xml': 'text/plain', '.yaml': 'text/plain', '.yml': 'text/plain', '.py': 'text/plain', '.ts': 'text/plain', '.tsx': 'text/plain', '.jsx': 'text/plain', '.rs': 'text/plain', '.go': 'text/plain', '.java': 'text/plain', '.sh': 'text/plain', '.c': 'text/plain', '.cpp': 'text/plain', '.h': 'text/plain' };
const MAX_BYTES = 32 * 1024 * 1024;
const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function createDocumentProtocol(pathGuard) {
  const documents = new Map();
  async function prepare(cwd, raw) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof raw !== 'string' || !raw || raw.length > 4096 || raw.includes('\0')) throw new Error('Invalid file path');
    let target = raw;
    if (/^file:/i.test(raw)) { const url = new URL(raw); if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) throw new Error('Invalid file URL'); target = require('node:url').fileURLToPath(url); }
    else { target = raw.split('#')[0].split('?')[0]; try { target = decodeURIComponent(target); } catch { throw new Error('Invalid file path'); } }
    target = target.replace(/:(?:\d+)(?::\d+)?$/, '');
    if (target === '~' || target.startsWith('~/')) target = path.join(require('node:os').homedir(), target.slice(2));
    const file = pathGuard.resolveAllowed(path.resolve(cwd, target));
    if (!file) throw new Error('This file is outside accessible folders');
    const ext = path.extname(file).toLowerCase();
    if (!mime[ext]) throw new Error('This file type cannot be previewed');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('File is unavailable or too large to preview');
    const token = randomUUID(); documents.set(token, path.dirname(file));
    return { url: `synthesis-doc://${token}/${encodeURIComponent(path.basename(file))}`, path: file };
  }
  function owns(raw) { try { const url = new URL(raw); return url.protocol === 'synthesis-doc:' && documents.has(url.hostname); } catch { return false; } }
  function documentPath(raw) {
    try {
      const url = new URL(raw), root = documents.get(url.hostname);
      if (!root || url.protocol !== 'synthesis-doc:') return '';
      return pathGuard.resolveAllowed(path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''))) || '';
    } catch { return ''; }
  }
  async function handle(request) {
    try {
      const url = new URL(request.url), root = documents.get(url.hostname);
      if (!root || url.protocol !== 'synthesis-doc:') return new Response('Not found', { status: 404 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = pathGuard.resolveAllowed(path.resolve(root, relative));
      if (!file) return new Response('Access denied', { status: 403 });
      const ext = path.extname(file).toLowerCase(), type = mime[ext];
      if (!type) return new Response('Unsupported file', { status: 415 });
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) return new Response('File unavailable', { status: 404 });
      let data = await fs.readFile(file), contentType = type;
      const isMarkdown = type === 'text/markdown';
      if (isMarkdown) {
        const raw = url.searchParams.get('raw') === '1';
        const html = raw ? '<pre class="raw">' + escapeHtml(data.toString('utf8')) + '</pre>' : marked.parse(data.toString('utf8'));
        const toggle = new URL(url.href); toggle.search = raw ? '' : '?raw=1';
        data = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(path.basename(file))}</title><style>body{max-width:820px;margin:40px auto;padding:0 24px;font:15px/1.65 system-ui;color:#eae8ed;background:#242327;overflow-wrap:anywhere}a{color:#a9cfff;text-decoration:none}a:hover,a:focus-visible{text-decoration:underline}.mode{display:block;text-align:right}pre{overflow:auto;background:#19191c;padding:14px;border-radius:8px}code{font-family:ui-monospace,monospace}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #555;padding:6px 10px}</style></head><body><a class="mode" href="${escapeHtml(toggle.href)}">${raw ? 'Formatted' : 'Raw Markdown'}</a>${html}</body></html>`);
        contentType = 'text/html; charset=utf-8';
      }
      const headers = { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `sandbox allow-scripts${isMarkdown ? '' : ' allow-forms'}; default-src 'none'; script-src ${isMarkdown ? "'none'" : "'unsafe-inline' synthesis-doc:"}; style-src 'unsafe-inline' synthesis-doc:; img-src synthesis-doc: data:; font-src synthesis-doc: data:; connect-src 'none'; frame-src 'none'; base-uri 'none'` };
      return new Response(data, { status: 200, headers });
    } catch { return new Response('File unavailable', { status: 404 }); }
  }
  return { prepare, owns, handle, documentPath };
}
module.exports = { createDocumentProtocol };
