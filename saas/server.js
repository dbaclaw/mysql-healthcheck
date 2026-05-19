#!/usr/bin/env node
/**
 * mysql-healthcheck SaaS server
 *
 * 懒猫微服 OIDC 版：
 *   - 懒猫网关自动注入 X-HC-* 请求头标识登录用户
 *   - 报告封面可配置：公司名称、Logo、编制人、报告标题
 *   - 支持懒猫动态部署参数（lzc-deploy-params.yml）
 *
 * 启动：node saas/server.js
 *
 * 提供：
 *   - 静态网页（/）         拖拽上传 *.txt → 生成 docx + 自动下载
 *   - REST API（/api/v1）  程序化对接
 *   - 健康检查（/api/v1/health）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const cookieSession = require('cookie-session');
const { Issuer, generators } = require('openid-client');

const { JobStore, STATUS } = require('./lib/jobs');
const { generateReport } = require('./lib/runner');
const { HistoryStore } = require('./lib/history');

const PORT = Number(process.env.PORT) || 3000;
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(__dirname, 'storage');
const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');
const REPORTS_DIR = path.join(STORAGE_ROOT, 'reports');
const MAX_FILES = Number(process.env.MAX_FILES) || 16;
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB) || 50;

function _env(key, fallback) {
  const v = process.env[key] || '';
  // 懒猫 manifest 模板对空值渲染为字面量 "<no value>"，过滤掉
  return (v && v !== '<no value>') ? v : fallback;
}

// 懒猫 OIDC / 动态部署参数（从 manifest 环境变量注入）
const CFG_COMPANY_NAME = _env('LAZYCAT_COMPANY_NAME', '智连数据');
const CFG_PREPARED_BY  = _env('LAZYCAT_PREPARED_BY',  'DBAClaw');
const CFG_LOGO_URL     = _env('LAZYCAT_LOGO_URL',     '/dbaclaw.jpg');
const CFG_REPORT_TITLE = _env('LAZYCAT_REPORT_TITLE', '');

// ============== 懒猫 OIDC 客户端配置（应用自己处理 authorize/callback）==============
const OIDC_CLIENT_ID     = _env('OIDC_CLIENT_ID',     '') || _env('LAZYCAT_AUTH_OIDC_CLIENT_ID',     '');
const OIDC_CLIENT_SECRET = _env('OIDC_CLIENT_SECRET', '') || _env('LAZYCAT_AUTH_OIDC_CLIENT_SECRET', '');
const OIDC_ISSUER_URI    = _env('OIDC_ISSUER_URI',    '') || _env('LAZYCAT_AUTH_OIDC_ISSUER_URI',    '');
const OIDC_AUTH_URI      = _env('OIDC_AUTH_URI',      '') || _env('LAZYCAT_AUTH_OIDC_AUTH_URI',      '');
const OIDC_TOKEN_URI     = _env('OIDC_TOKEN_URI',     '') || _env('LAZYCAT_AUTH_OIDC_TOKEN_URI',     '');
const OIDC_USERINFO_URI  = _env('OIDC_USERINFO_URI',  '') || _env('LAZYCAT_AUTH_OIDC_USERINFO_URI',  '');
const SESSION_SECRET     = _env('SESSION_SECRET',     '') || OIDC_CLIENT_SECRET || crypto.randomBytes(32).toString('hex');

let oidcClient = null;

function initOIDC() {
  if (!OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET || !OIDC_ISSUER_URI) {
    console.log('[OIDC] 客户端模式未配置，回退到网关代理模式（读取 X-HC-* header）');
    return;
  }
  try {
    const issuer = new Issuer({
      issuer: OIDC_ISSUER_URI,
      authorization_endpoint: OIDC_AUTH_URI,
      token_endpoint: OIDC_TOKEN_URI,
      userinfo_endpoint: OIDC_USERINFO_URI,
    });
    oidcClient = new issuer.Client({
      client_id: OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
      redirect_uris: [], // 动态生成
      response_types: ['code'],
    });
    console.log('[OIDC] 客户端初始化成功（issuer: ' + OIDC_ISSUER_URI + '）');
  } catch (err) {
    console.error('[OIDC] 初始化失败:', err.message);
  }
}

function getRedirectUri(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host');
  return `${proto}://${host}/auth/oidc.callback`;
}

// 准备存储目录
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const jobs = new JobStore();
const HISTORY_FILE = path.join(STORAGE_ROOT, 'history.json');
const history = new HistoryStore(HISTORY_FILE);

// ============== 用户身份识别（OIDC 客户端模式优先，网关代理模式回退）==============
/**
 * 优先从 session 读取（OIDC 客户端模式），
 * 回退到 X-HC-* header（网关代理模式）。
 */
function getOidcUser(req) {
  // 优先使用 session（应用自己管理的 OIDC 登录状态）
  if (req.session && req.session.user) {
    return {
      userId:    req.session.user.id,
      userRole:  req.session.user.role,
      name:      req.session.user.name,
      email:     req.session.user.email,
      mode:      'oidc_client',
    };
  }
  // 回退到懒猫网关代理模式（X-HC-* header）
  const userId = req.get('X-HC-User-ID');
  if (userId) {
    return {
      userId:    userId,
      userRole:  req.get('X-HC-User-Role')  || undefined,
      deviceId:  req.get('X-HC-Device-ID')  || undefined,
      loginTime: req.get('X-HC-Login-Time') || undefined,
      mode:      'gateway_proxy',
    };
  }
  return { mode: null };
}

// ============== multer：multipart 上传到 storage/uploads/<jobId>/ ==============
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const jobId = req._pendingJobId || (req._pendingJobId = crypto.randomBytes(8).toString('hex'));
      const dir = path.join(UPLOADS_DIR, jobId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const safe = path.basename(file.originalname).replace(/[\/\\]/g, '_');
      cb(null, safe);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (!/\.(txt|log)$/i.test(file.originalname)) {
      return cb(new Error(`只接受 .txt / .log 文件（收到：${file.originalname}）`));
    }
    cb(null, true);
  },
});

// ============== Express app ==============
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Session（用于 OIDC 客户端模式的 state/code_verifier 和用户登录状态）
app.use(cookieSession({
  name: 'mysqlhc_session',
  keys: [SESSION_SECRET],
  maxAge: 24 * 60 * 60 * 1000, // 24h
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
}));

// 初始化 OIDC client
initOIDC();

// 请求日志
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// ============== 静态 Web UI ==============
app.use(express.static(path.join(__dirname, 'public')));

// 认证中间件（所有路径设为 public 后，应用自己保护敏感路由）
function requireAuth(req, res, next) {
  const user = getOidcUser(req);
  if (!user.userId) {
    return res.status(401).json({ error: '未登录', loginUrl: '/auth/login' });
  }
  next();
}

// ============== OIDC 认证路由 ==============

// GET /auth/login —— 生成 OIDC authorize URL，重定向到懒猫 OIDC Provider
app.get('/auth/login', (req, res) => {
  if (!oidcClient) {
    return res.status(503).json({ error: 'OIDC 客户端未配置' });
  }
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);
  const state = generators.state();

  // 将 PKCE 参数写入 session（备用，cookie 跨域丢失时降级）
  req.session.codeVerifier = codeVerifier;
  req.session.state = state;
  req.session.returnTo = req.query.returnTo || '/';

  const redirectUri = getRedirectUri(req);
  const url = oidcClient.authorizationUrl({
    scope: 'openid profile email',
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  res.redirect(url);
});

// GET /auth/oidc.callback —— 懒猫 OIDC Provider 回调
// 注意：懒猫服务端重定向时浏览器不携带我们域的 cookie，
// 导致 req.session 为空。修复：session 丢了也从 code_verifier 重试。
app.get('/auth/oidc.callback', async (req, res) => {
  if (!oidcClient) {
    return res.status(503).json({ error: 'OIDC 客户端未配置' });
  }

  const redirectUri = getRedirectUri(req);
  const params = oidcClient.callbackParams(req);

  // 优先从 session 读 PKCE；session丢了（cookie跨域丢失）则从 X-HC-* 头降级
  let codeVerifier = req.session.codeVerifier;
  let returnTo     = req.session.returnTo || '/';

  // session丢了（懒猫服务端重定向不带cookie），此时尝试从懒猫网关头获取身份
  if (!codeVerifier) {
    const gatewayUserId = req.get('X-HC-User-ID');
    if (gatewayUserId) {
      // 用户已通过懒猫平台认证，直接写入 session
      req.session.user = {
        id:   gatewayUserId,
        name: req.get('X-HC-User-Name') || gatewayUserId,
        role: req.get('X-HC-User-Role') || 'NORMAL',
        email: undefined,
      };
      return res.redirect(returnTo);
    }
    // 既无 PKCE 也无网关身份，无法完成认证
    return res.status(400).send(`<h1>认证失败</h1><p>会话已过期，请重新 <a href="/auth/login">登录</a></p>`);
  }

  try {
    const tokenSet = await oidcClient.callback(redirectUri, params, {
      code_verifier: codeVerifier,
      // state 也可能丢失，跳过验证（依赖 PKCE code 一次性保证安全）
      state: req.session.state,
    });
    const userinfo = await oidcClient.userinfo(tokenSet);
    req.session.user = {
      id:    userinfo.sub,
      name:  userinfo.name || userinfo.preferred_username || userinfo.sub,
      email: userinfo.email,
      role:  userinfo.role || 'NORMAL',
    };
    delete req.session.codeVerifier;
    delete req.session.state;
    delete req.session.returnTo;
    res.redirect(returnTo);
  } catch (err) {
    console.error('[OIDC] callback 失败:', err.message);
    res.status(400).send(`<h1>认证失败</h1><p>${err.message}</p><a href="/auth/login">重新登录</a>`);
  }
});

// GET /api/v1/auth/status —— 前端查询登录状态
app.get('/api/v1/auth/status', (req, res) => {
  const oidcUser = getOidcUser(req);
  res.json({
    authenticated: !!oidcUser.userId,
    user: oidcUser.userId ? {
      id: oidcUser.userId,
      name: oidcUser.name || oidcUser.userId,
      role: oidcUser.userRole || 'NORMAL',
    } : null,
    mode: oidcUser.mode,
  });
});

// GET /api/v1/auth/logout
app.get('/api/v1/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// ============== REST API ==============

// GET /api/v1/health
app.get('/api/v1/health', (req, res) => {
  let scriptsVersion = 'unknown';
  try {
    scriptsVersion = require(path.join(__dirname, '..', 'scripts', 'package.json')).version;
  } catch (_) {}
  const oidcUser = getOidcUser(req);
  res.json({
    status: 'ok',
    saasVersion: require('./package.json').version,
    scriptsVersion,
    // 认证状态（兼容 OIDC 客户端模式和网关代理模式）
    oidc: {
      enabled: !!oidcUser.userId,
      userId:   oidcUser.userId   || null,
      userRole: oidcUser.userRole || null,
      name:     oidcUser.name     || null,
      mode:     oidcUser.mode     || null,
    },
    // 当前安装的封面默认值（供前端表单填充）
    defaults: {
      companyName:  CFG_COMPANY_NAME || '智连数据',
      preparedBy:   CFG_PREPARED_BY  || (oidcUser.userId || 'DBAClaw'),
      logoUrl:      CFG_LOGO_URL      || '/dbaclaw.jpg',
      reportTitle:  CFG_REPORT_TITLE || '',
    },
    storage: { uploadsDir: UPLOADS_DIR, reportsDir: REPORTS_DIR },
  });
});

// POST /api/v1/reports  multipart/form-data
// fields:
//   files[]        MySQLHealthCheck_*.txt 采集文件
//   project        项目名称（报告标题用）
//   configJson     可选阈值配置 JSON
//   companyName    封面公司名称（可覆盖默认值）
//   preparedBy     编制人（可覆盖默认值）
//   logoUrl        Logo URL/Base64（可覆盖默认值）
//   reportTitle    报告标题（可覆盖默认值）
//   reportDate     报告日期 YYYY-MM-DD（可选，默认当日）
app.post('/api/v1/reports', requireAuth, upload.array('files', MAX_FILES), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '未收到任何文件。请用 multipart/form-data，字段名 files' });
    }

    const jobId = req._pendingJobId;
    const uploadDir = path.join(UPLOADS_DIR, jobId);
    const outputDir = path.join(REPORTS_DIR, jobId);
    fs.mkdirSync(outputDir, { recursive: true });

    const oidcUser = getOidcUser(req);
    const project = req.body.project || `Report_${jobId.slice(0, 6)}`;
    const fileNames = req.files.map(f => f.originalname);

    // 报告封面配置（优先级：用户表单 > 懒猫部署参数 > 内置默认值）
    const reportConfig = {
      companyName:  req.body.companyName  || CFG_COMPANY_NAME,
      preparedBy:   req.body.preparedBy   || CFG_PREPARED_BY  || oidcUser.userId || '系统自动生成',
      logoUrl:      req.body.logoUrl      || CFG_LOGO_URL      || '',
      reportTitle:  req.body.reportTitle  || CFG_REPORT_TITLE || '',
      reportDate:   req.body.reportDate   || new Date().toISOString().slice(0, 10),
      // 内部使用
      _oidcUserId: oidcUser.userId,
      _jobId: jobId,
    };

    // 落盘 report-config.json，runner.js / render.js 通过环境变量指向此文件
    const configPath = path.join(uploadDir, 'report-config.json');
    fs.writeFileSync(configPath, JSON.stringify(reportConfig, null, 2));

    // 可选：客户端传入阈值配置 JSON
    if (req.body.configJson) {
      try {
        const parsed = JSON.parse(req.body.configJson);
        fs.writeFileSync(path.join(uploadDir, 'mysql-healthcheck.config.json'), JSON.stringify(parsed, null, 2));
      } catch (e) {
        return res.status(400).json({ error: `configJson 不是合法 JSON: ${e.message}` });
      }
    }

    const job = jobs.create({ project, uploadDir, fileNames });
    job.id = jobId;
    jobs.jobs.set(jobId, job);

    // 异步执行（不阻塞 HTTP 响应）
    setImmediate(async () => {
      try {
        jobs.update(jobId, { status: STATUS.RUNNING_EXTRACT, progress: 'extract' });
        const { docxPath, dataJsonPath, summary } = await generateReport({
          uploadDir,
          outputDir,
          project,
          reportConfigPath: configPath,
          onProgress: (stage) => {
            const next = stage === 'extract' ? STATUS.RUNNING_EXTRACT : STATUS.RUNNING_RENDER;
            jobs.update(jobId, { status: next, progress: stage });
          },
        });
        jobs.update(jobId, {
          status: STATUS.DONE,
          progress: 'done',
          result: { docxPath, dataJsonPath, summary },
        });
        // 持久化到历史记录
        history.add({
          jobId,
          project: job.project,
          status: STATUS.DONE,
          createdAt: job.createdAt,
          completedAt: new Date().toISOString(),
          summary,
          oidcUserId: oidcUser.userId || null,
          downloadUrl: `/api/v1/reports/${jobId}/download`,
          dataJsonUrl: `/api/v1/reports/${jobId}/data.json`,
        });
        console.log(`[job ${jobId}] done — ${summary.issueCount} issues, ${(summary.docxSizeBytes/1024).toFixed(1)} KB docx`);
      } catch (err) {
        console.error(`[job ${jobId}] error:`, err.message);
        jobs.update(jobId, { status: STATUS.ERROR, error: err.message });
      }
    });

    res.status(202).json(jobs.toPublic(job));
  } catch (err) {
    console.error('POST /api/v1/reports failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/reports/:id
app.get('/api/v1/reports/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(jobs.toPublic(job));
});

// GET /api/v1/reports/:id/download
app.get('/api/v1/reports/:id/download', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.status !== STATUS.DONE || !job.result?.docxPath) {
    return res.status(409).json({ error: `job 状态 ${job.status}，尚无可下载文件` });
  }
  const docxPath = job.result.docxPath;
  if (!fs.existsSync(docxPath)) return res.status(410).json({ error: '报告文件已被清理（TTL 过期）' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(docxPath))}"`);
  fs.createReadStream(docxPath).pipe(res);
});

// GET /api/v1/reports/:id/data.json
app.get('/api/v1/reports/:id/data.json', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== STATUS.DONE) return res.status(404).json({ error: 'not available' });
  res.setHeader('Content-Type', 'application/json');
  fs.createReadStream(job.result.dataJsonPath).pipe(res);
});

// ============== 历史记录 API ==============
// GET /api/v1/history
app.get('/api/v1/history', requireAuth, (req, res) => {
  const oidcUser = getOidcUser(req);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const entries = history.list({ userId: oidcUser.userId, limit });
  res.json({ entries, total: entries.length });
});

// DELETE /api/v1/history/:jobId
app.delete('/api/v1/history/:jobId', requireAuth, (req, res) => {
  const ok = history.remove(req.params.jobId);
  res.json({ ok });
});

// DELETE /api/v1/history（清空当前用户可见的历史）
app.delete('/api/v1/history', requireAuth, (req, res) => {
  const oidcUser = getOidcUser(req);
  history.clear(oidcUser.userId);
  res.json({ ok: true });
});

// ============== 采集脚本下载 ==============
app.get('/download/mysqlHealthCheckV3.0.sh', (req, res) => {
  const scriptPath = path.join(__dirname, '..', 'collectors', 'mysqlHealthCheckV3.0.sh');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: '脚本文件未找到' });
  }
  res.setHeader('Content-Type', 'application/x-sh');
  res.setHeader('Content-Disposition', 'attachment; filename="mysqlHealthCheckV3.0.sh"');
  fs.createReadStream(scriptPath).pipe(res);
});

// multer 错误处理
app.use((err, req, res, next) => {
  if (err) {
    console.error('handler error:', err.message);
    return res.status(400).json({ error: err.message });
  }
  next();
});

// 启动
app.listen(PORT, () => {
  console.log(`🚀 mysql-healthcheck SaaS listening on http://0.0.0.0:${PORT}`);
  console.log(`   API:      http://localhost:${PORT}/api/v1/health`);
  console.log(`   Web UI:   http://localhost:${PORT}/`);
  console.log(`   Storage:  ${STORAGE_ROOT}`);
  console.log(`   OIDC:     ${oidcClient ? '客户端模式（/auth/login → Grant Access）' : '网关代理模式（X-HC-* header）'}`);
  console.log(`   Company:  ${CFG_COMPANY_NAME}`);
  console.log(`   Editor:   ${CFG_PREPARED_BY}`);
  console.log(`   Slogan:   稳如乾坤`);
  console.log(`   Site:     https://dbaclaw.com`);
});
