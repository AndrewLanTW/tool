#!/usr/bin/env node
/**
 * 小红书图文排版工具 - 本地服务 v7 · 通义万相版
 * 改造：从腾讯混元切换到阿里通义万相 (wanx-v1)
 *   - 直接 HTTPS 调用 DashScope API（不再 spawn python）
 *   - 支持结果缓存（同 prompt 24h 内复用）
 *   - 保留异步任务池、取消、超时、自动重试
 *
 * API:
 *   POST /api/gen-image  { prompt }   → { job_id }
 *   GET  /api/job/:id                 → { status, result?, error?, rateLimited? }
 *   POST /api/cancel     { job_id? }  → { cancelled: [...] }
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 7788;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || 'sk-1737a28fa93646a7a20e362875bbaf0c';
const WANX_MODEL = process.env.WANX_MODEL || 'wanx-v1';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen-turbo';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

// 任务池：{ jobId -> { status, result?, error?, endAt?, abort? } }
const JOBS = new Map();
// 结果缓存：{ promptHash -> { url, cachedAt } }，24h 有效
const CACHE = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ------------------------ 工具 ------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function hashPrompt(p, style = '<photography>') {
  return crypto.createHash('md5').update(p + '|' + style).digest('hex').slice(0, 16);
}

function isRateLimitedErr(msg) {
  if (!msg) return false;
  return /throttling|rate.?limit|concurrent|concurrency|slot limit|too many|429|QPS|任务上限|限流/i.test(String(msg));
}

// HTTPS JSON 请求封装
function httpsJson({ url, method = 'GET', headers = {}, body = null, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'Accept': 'application/json', ...headers },
      timeout
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => (buf += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* 保留原文 */ }
        resolve({ status: res.statusCode, data: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ------------------------ 通义万相调用 ------------------------
async function wanxCreateTask(prompt, style = '<photography>') {
  const resp = await httpsJson({
    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + DASHSCOPE_API_KEY,
      'X-DashScope-Async': 'enable'
    },
    body: {
      model: WANX_MODEL,
      input: { prompt },
      parameters: {
        style: style,
        size: '1024*1024',
        n: 1
      }
    }
  });
  if (resp.status !== 200) {
    const err = resp.data || {};
    const msg = err.message || err.code || resp.raw || `HTTP ${resp.status}`;
    const rateLimited = resp.status === 429 || isRateLimitedErr(msg) || isRateLimitedErr(err.code);
    const e = new Error(msg);
    e.rateLimited = rateLimited;
    e.code = err.code || 'CREATE_TASK_FAIL';
    throw e;
  }
  const taskId = resp.data && resp.data.output && resp.data.output.task_id;
  if (!taskId) throw new Error('通义返回未包含 task_id: ' + resp.raw);
  return taskId;
}

async function wanxQueryTask(taskId) {
  const resp = await httpsJson({
    url: 'https://dashscope.aliyuncs.com/api/v1/tasks/' + encodeURIComponent(taskId),
    headers: { 'Authorization': 'Bearer ' + DASHSCOPE_API_KEY }
  });
  if (resp.status !== 200) {
    throw new Error(`查询任务失败 HTTP ${resp.status}: ${resp.raw}`);
  }
  return resp.data && resp.data.output;
}

// ------------------------ 通义千问文案生成 ------------------------
async function generateCopy(topic) {
  if (!DASHSCOPE_API_KEY) {
    throw new Error('未配置 DASHSCOPE_API_KEY');
  }
  const prompt = `你是一位小红书爆款文案专家，擅长创作吸引人点击的标题、副标题、标签和配图描述。
请根据用户提供的主题，生成2套不同风格的小红书图文笔记文案方案。
每套方案必须包含以下字段：
1. title：主标题（10-20字，要有爆款感，可以使用数字、反常识、情绪钩子、利益点等技巧）
2. subtitle：副标题（20-40字，补充说明、场景描述、干货价值）
3. pretitle：前缀标签（2-5个字，例如「干货」、「必看」、「种草」）
4. imagePrompt：图片描述（用于AI生图的详细英文描述，需包含构图、光线、风格等细节，参考小红书摄影风格）
5. tags：话题标签（5个标签，以#开头，用空格分隔）

主题：${topic}

请严格输出JSON格式，是一个包含2个对象的数组，每个对象包含上述5个字段。不要有任何额外解释。

示例格式：
[
  {
    "title": "...",
    "subtitle": "...",
    "pretitle": "...",
    "imagePrompt": "...",
    "tags": "#标签1 #标签2 #标签3 #标签4 #标签5"
  },
  {
    "title": "...",
    "subtitle": "...",
    "pretitle": "...",
    "imagePrompt": "...",
    "tags": "..."
  }
]`;

  const resp = await httpsJson({
    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + DASHSCOPE_API_KEY
    },
    body: {
      model: QWEN_MODEL,
      input: {
        messages: [
          { role: 'system', content: '你是一位小红书爆款文案专家，输出严格的JSON格式，不包含任何额外文本。' },
          { role: 'user', content: prompt }
        ]
      },
      parameters: {
        result_format: 'message',
        temperature: 0.8,
        top_p: 0.9
      }
    }
  });
  if (resp.status !== 200) {
    throw new Error(`文案生成失败 HTTP ${resp.status}: ${resp.raw}`);
  }
  const content = resp.data?.output?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('API响应中没有找到文案内容');
  }
  // 尝试解析JSON，如果失败则尝试提取JSON部分
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length >= 2) {
      return parsed.slice(0, 2);
    } else {
      throw new Error('返回的JSON不是数组或长度不足2');
    }
  } catch (e) {
    // 尝试提取 ```json ... ``` 或数组部分
    const match = content.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        return parsed.slice(0, 2);
      }
    }
    throw new Error('无法解析返回的文案JSON: ' + content.slice(0, 200));
  }
}

// ------------------------ Job 管理 ------------------------
function startImageJob(prompt, style = '<photography>') {
  const jobId = 'img_' + crypto.randomBytes(6).toString('hex');

  // 1) 命中缓存直接完成（缓存键包含prompt+style）
  const cacheKey = hashPrompt(prompt, style);
  const ch = CACHE.get(cacheKey);
  if (ch && Date.now() - ch.cachedAt < CACHE_TTL_MS) {
    JOBS.set(jobId, {
      status: 'done',
      cached: true,
      result: { result_url: ch.url },
      endAt: Date.now()
    });
    return jobId;
  }

  // 2) 真实调用
  const job = { status: 'running', startAt: Date.now(), cancelled: false };
  JOBS.set(jobId, job);

  (async () => {
    try {
      // 提交任务
      const taskId = await wanxCreateTask(prompt, style);
      if (job.cancelled) return;
      job.taskId = taskId;

      // 轮询
      const maxWait = 180 * 1000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        if (job.cancelled) return;
        await new Promise(r => setTimeout(r, 3000));
        if (job.cancelled) return;
        const output = await wanxQueryTask(taskId);
        const status = output && output.task_status;
        if (status === 'SUCCEEDED') {
          const urls = (output.results || []).map(r => r.url).filter(Boolean);
          const first = urls[0];
          if (first) CACHE.set(cacheKey, { url: first, cachedAt: Date.now() });
          Object.assign(job, {
            status: 'done',
            result: { result_url: urls },
            endAt: Date.now()
          });
          return;
        }
        if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
          const msg = (output && output.message) || (output && output.code) || status;
          Object.assign(job, {
            status: 'error',
            error: output && output.code || status,
            message: msg,
            rateLimited: isRateLimitedErr(msg),
            endAt: Date.now()
          });
          return;
        }
      }
      // 超时
      Object.assign(job, {
        status: 'error',
        error: 'TIMEOUT',
        message: '任务超过 3 分钟仍未完成',
        endAt: Date.now()
      });
    } catch (e) {
      if (job.cancelled) return;
      Object.assign(job, {
        status: 'error',
        error: e.code || 'API_ERROR',
        message: e.message || String(e),
        rateLimited: !!e.rateLimited,
        endAt: Date.now()
      });
    }
  })();

  return jobId;
}

function cancelJobs(targetId) {
  const cancelled = [];
  for (const [id, job] of JOBS.entries()) {
    if (targetId && id !== targetId) continue;
    if (job.status === 'running') {
      job.cancelled = true;
      job.status = 'cancelled';
      job.endAt = Date.now();
      cancelled.push(id);
    }
  }
  return cancelled;
}

// 定期清理 10 分钟以上的老任务
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of JOBS.entries()) {
    const t = job.endAt || job.startAt || now;
    if (now - t > 10 * 60 * 1000) JOBS.delete(id);
  }
}, 60 * 1000);

// ------------------------ HTTP 服务 ------------------------
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  // 静态资源
  if (req.method === 'GET' && !url.startsWith('/api/')) {
    let filePath = url === '/' ? '/index.html' : url;
    const full = path.join(__dirname, filePath);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      return fs.createReadStream(full).pipe(res);
    }
  }

  // 提交生图任务（异步，立刻返回 jobId）
  if (req.method === 'POST' && url === '/api/gen-image') {
    try {
      const body = await readBody(req);
      const { prompt, style } = JSON.parse(body || '{}');
      if (!prompt) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'prompt required' }));
      }
      if (!DASHSCOPE_API_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          error: 'MISSING_KEY',
          message: '未配置 DASHSCOPE_API_KEY，请先设置环境变量后重启服务'
        }));
      }

      // 清理prompt：移除可能错误拼接的 style=... 部分
      let cleanPrompt = prompt;
      const styleMatch = prompt.match(/style\s*=\s*<[^>]+>/i);
      if (styleMatch) {
        cleanPrompt = prompt.replace(/style\s*=\s*<[^>]+>/i, '').trim();
        console.log('[gen-image] 清理prompt：移除错误拼接的style信息');
      }

      const finalStyle = style || '<photography>';
      console.log('[gen-image] model=%s prompt=%s style=%s', WANX_MODEL, cleanPrompt.slice(0, 60), finalStyle);
      const jobId = startImageJob(cleanPrompt, finalStyle);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ job_id: jobId }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // AI 文案生成（同步）
  if (req.method === 'POST' && url === '/api/gen-copy') {
    try {
      const body = await readBody(req);
      const { topic } = JSON.parse(body || '{}');
      if (!topic) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'topic required' }));
      }
      if (!DASHSCOPE_API_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          error: 'MISSING_KEY',
          message: '未配置 DASHSCOPE_API_KEY，请先设置环境变量后重启服务'
        }));
      }
      console.log('[gen-copy] topic=%s', topic.slice(0, 60));
      const aiCopies = await generateCopy(topic);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ copies: aiCopies }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 查询任务状态
  if (req.method === 'GET' && url.startsWith('/api/job/')) {
    const jobId = url.slice('/api/job/'.length);
    const job = JOBS.get(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ status: 'not_found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      status: job.status,
      result: job.result,
      error: job.error,
      message: job.message,
      rateLimited: job.rateLimited,
      cached: job.cached,
      elapsedMs: (job.endAt || Date.now()) - (job.startAt || Date.now())
    }));
  }

  // 取消任务
  if (req.method === 'POST' && url === '/api/cancel') {
    try {
      const body = await readBody(req);
      const { job_id } = JSON.parse(body || '{}');
      const cancelled = cancelJobs(job_id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ cancelled, count: cancelled.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`✅ 小红书图文排版工具 v7（通义万相）启动：http://localhost:${PORT}`);
  console.log(`   模型：${WANX_MODEL}   |   Key：${DASHSCOPE_API_KEY ? '已配置 ✓' : '⚠️ 未配置 DASHSCOPE_API_KEY'}`);
});
