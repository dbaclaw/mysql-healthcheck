(() => {
  'use strict';

  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const fileList = document.getElementById('fileList');
  const submitBtn = document.getElementById('submitBtn');
  const clearBtn = document.getElementById('clearBtn');
  const projectName = document.getElementById('projectName');
  const configJson = document.getElementById('configJson');
  const statusText = document.getElementById('statusText');
  const progressCard = document.getElementById('progressCard');
  const progressStage = document.getElementById('progressStage');
  const jobIdDisplay = document.getElementById('jobIdDisplay');
  const summaryCard = document.getElementById('summaryCard');
  const summaryGrid = document.getElementById('summaryGrid');
  const summaryExtra = document.getElementById('summaryExtra');
  const downloadDocx = document.getElementById('downloadDocx');
  const downloadJson = document.getElementById('downloadJson');
  const errorCard = document.getElementById('errorCard');
  // 懒猫 OIDC
  const userBadge = document.getElementById('userBadge');
  const userNameEl = document.getElementById('userName');
  const userRoleEl = document.getElementById('userRole');
  const loginOverlay = document.getElementById('loginOverlay');
  const appContent = document.getElementById('appContent');
  // 封面定制
  const companyNameEl = document.getElementById('companyName');
  const preparedByEl = document.getElementById('preparedBy');
  const reportTitleEl = document.getElementById('reportTitle');
  const reportDateEl = document.getElementById('reportDate');
  const logoUrlEl = document.getElementById('logoUrl');
  const logoPreview = document.getElementById('logoPreview');
  // 历史记录
  const historyCard = document.getElementById('historyCard');
  const historyList = document.getElementById('historyList');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');

  let pendingFiles = [];
  const HISTORY_KEY = 'mysqlhc_history_v1';

  // ============== 认证状态检测（OIDC 客户端模式 / 网关代理模式）==============
  async function initOIDC() {
    try {
      // 先查询 /api/v1/auth/status 获取登录状态
      const authResp = await fetch('/api/v1/auth/status');
      const authInfo = authResp.ok ? await authResp.json() : { authenticated: false };

      // 未登录 → 显示登录页面
      if (!authInfo.authenticated) {
        loginOverlay.style.display = 'flex';
        appContent.style.display = 'none';
        return;
      }

      // 已登录 → 显示应用内容
      loginOverlay.style.display = 'none';
      appContent.style.display = 'block';

      // 显示用户信息
      if (authInfo.user) {
        userNameEl.textContent = authInfo.user.name || authInfo.user.id;
        userRoleEl.textContent = authInfo.user.role === 'ADMIN' ? '管理员' : '用户';
        userBadge.style.display = 'flex';
      }

      // 获取封面默认值
      const resp = await fetch('/api/v1/health');
      if (!resp.ok) return;
      const info = await resp.json();

      // 填充封面默认值
      if (info.defaults) {
        if (info.defaults.companyName && !companyNameEl.dataset.userModified) {
          companyNameEl.placeholder = info.defaults.companyName;
          if (!companyNameEl.value) companyNameEl.value = info.defaults.companyName;
        }
        if (info.defaults.preparedBy && !preparedByEl.dataset.userModified) {
          preparedByEl.placeholder = info.defaults.preparedBy;
          if (!preparedByEl.value) preparedByEl.value = info.defaults.preparedBy;
        }
        if (info.defaults.logoUrl && !logoUrlEl.dataset.userModified) {
          logoUrlEl.placeholder = info.defaults.logoUrl;
          if (!logoUrlEl.value) {
            logoUrlEl.value = info.defaults.logoUrl;
            updateLogoPreview();
          }
        }
        if (info.defaults.reportTitle && !reportTitleEl.dataset.userModified) {
          reportTitleEl.placeholder = info.defaults.reportTitle;
        }
      }
      // 加载历史记录
      loadHistory();
    } catch (_) {
      // 网络异常时默认显示登录页
      loginOverlay.style.display = 'flex';
      appContent.style.display = 'none';
    }
  }

  // 跟踪用户是否手动修改过字段（避免覆盖用户输入）
  function trackUserModification(el) {
    el.addEventListener('input', () => { el.dataset.userModified = '1'; });
    el.addEventListener('change', () => { el.dataset.userModified = '1'; });
  }
  [companyNameEl, preparedByEl, reportTitleEl, logoUrlEl].forEach(trackUserModification);

  // Logo URL 预览（支持绝对路径 / 相对路径 / data URI / http(s)）
  function updateLogoPreview() {
    const url = logoUrlEl.value.trim();
    if (url && (url.startsWith('/') || /^https?:\/\//.test(url) || url.startsWith('data:image'))) {
      logoPreview.src = url;
      logoPreview.classList.add('visible');
    } else {
      logoPreview.classList.remove('visible');
    }
  }
  logoUrlEl.addEventListener('input', updateLogoPreview);
  logoUrlEl.addEventListener('change', updateLogoPreview);

  // 初始化日期为今天
  reportDateEl.value = new Date().toISOString().slice(0, 10);

  // 启动 OIDC 初始化
  initOIDC();

  // ============== 拖放交互 ==============
  ['dragenter', 'dragover'].forEach(evt => {
    dropZone.addEventListener(evt, e => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    dropZone.addEventListener(evt, e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    });
  });
  dropZone.addEventListener('drop', e => {
    addFiles(e.dataTransfer.files);
  });
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => addFiles(e.target.files));

  clearBtn.addEventListener('click', () => {
    pendingFiles = [];
    renderFileList();
    projectName.value = '';
    configJson.value = '';
    companyNameEl.value = '';
    preparedByEl.value = '';
    reportTitleEl.value = '';
    reportDateEl.value = new Date().toISOString().slice(0, 10);
    logoUrlEl.value = '';
    logoPreview.src = '/dbaclaw.jpg';
    logoPreview.classList.add('visible');
    hideProgress();
    hideSummary();
    hideError();
  });

  submitBtn.addEventListener('click', submit);

  function addFiles(fileList) {
    for (const f of fileList) {
      if (!/\.(txt|log)$/i.test(f.name)) {
        showError(`忽略非 .txt/.log 文件：${f.name}`);
        continue;
      }
      if (pendingFiles.some(x => x.name === f.name)) continue;
      pendingFiles.push(f);
    }
    if (pendingFiles.length > 16) {
      pendingFiles = pendingFiles.slice(0, 16);
      showError('最多上传 16 个文件，多余的已忽略');
    }
    renderFileList();
  }

  function renderFileList() {
    fileList.innerHTML = '';
    for (const [i, f] of pendingFiles.entries()) {
      const div = document.createElement('div');
      div.className = 'file-item';
      div.innerHTML = `
        <span class="name">📄 ${escapeHtml(f.name)}</span>
        <span class="size">${formatSize(f.size)}</span>
        <button data-index="${i}" title="移除">✕</button>
      `;
      fileList.appendChild(div);
    }
    fileList.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', e => {
        const idx = Number(e.target.dataset.index);
        pendingFiles.splice(idx, 1);
        renderFileList();
      });
    });
    submitBtn.disabled = pendingFiles.length === 0;
    statusText.textContent = pendingFiles.length === 0
      ? ''
      : `已选 ${pendingFiles.length} 个文件，合计 ${formatSize(pendingFiles.reduce((s, f) => s + f.size, 0))}`;
  }

  async function submit() {
    hideError();
    hideSummary();
    submitBtn.disabled = true;
    statusText.textContent = '上传中…';

    const fd = new FormData();
    for (const f of pendingFiles) fd.append('files', f);
    if (projectName.value.trim()) fd.append('project', projectName.value.trim());
    if (configJson.value.trim()) fd.append('configJson', configJson.value.trim());

    // 封面定制字段（仅当用户填写时传递，覆盖懒猫部署参数的默认值）
    if (companyNameEl.value.trim()) fd.append('companyName', companyNameEl.value.trim());
    if (preparedByEl.value.trim()) fd.append('preparedBy', preparedByEl.value.trim());
    if (reportTitleEl.value.trim()) fd.append('reportTitle', reportTitleEl.value.trim());
    if (reportDateEl.value.trim()) fd.append('reportDate', reportDateEl.value.trim());
    if (logoUrlEl.value.trim()) fd.append('logoUrl', logoUrlEl.value.trim());

    try {
      const resp = await fetch('/api/v1/reports', { method: 'POST', body: fd });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const job = await resp.json();
      showProgress(job);
      pollJob(job.jobId);
    } catch (err) {
      showError(`提交失败：${err.message}`);
      submitBtn.disabled = false;
      statusText.textContent = '';
    }
  }

  function showProgress(job) {
    progressCard.classList.add('active');
    jobIdDisplay.textContent = job.jobId;
    updateProgressStage('queued');
  }
  function hideProgress() {
    progressCard.classList.remove('active');
  }
  function updateProgressStage(stage) {
    const labels = {
      queued: '排队中',
      extract: '解析采集文件（extract.js）',
      render: '渲染报告（render.js）',
      done: '完成',
    };
    progressStage.textContent = labels[stage] || stage;
  }

  async function pollJob(jobId) {
    let lastStatus = '';
    while (true) {
      await sleep(2000);
      try {
        const resp = await fetch(`/api/v1/reports/${jobId}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const job = await resp.json();
        if (job.progress !== lastStatus) {
          updateProgressStage(job.progress);
          lastStatus = job.progress;
        }
        if (job.status === 'done') {
          hideProgress();
          showSummary(job);
          submitBtn.disabled = false;
          statusText.textContent = '';
          return;
        }
        if (job.status === 'error') {
          hideProgress();
          showError(`生成失败：${job.error || '未知错误'}`);
          submitBtn.disabled = false;
          statusText.textContent = '';
          return;
        }
      } catch (err) {
        showError(`查询状态失败：${err.message}`);
        submitBtn.disabled = false;
        return;
      }
    }
  }

  function showSummary(job) {
    summaryCard.classList.add('active');
    saveLocalHistory(job);
    loadHistory();
    const s = job.summary || {};
    const metrics = [
      { label: '节点数', value: s.nodeCount },
      { label: '集群拓扑', value: s.topology },
      { label: '健康度', value: s.healthScoreTotal != null ? s.healthScoreTotal + '/100' : '-' },
      { label: 'P0 紧急', value: s.p0 || 0, cls: 'p0' },
      { label: 'P1 重要', value: s.p1 || 0, cls: 'p1' },
      { label: 'P2 建议', value: s.p2 || 0, cls: 'p2' },
      { label: 'P3 观察', value: s.p3 || 0, cls: 'p3' },
      { label: '根因关联', value: s.correlationCount || 0 },
    ];
    summaryGrid.innerHTML = metrics.map(m => `
      <div class="metric ${m.cls || ''}">
        <div class="label">${m.label}</div>
        <div class="value">${m.value}</div>
      </div>
    `).join('');
    const extra = [];
    if (s.overallAssessment) extra.push(`整体评估：${s.overallAssessment}`);
    if (s.docxSizeBytes) extra.push(`报告文件：${formatSize(s.docxSizeBytes)}`);
    if (s.disabledRules?.length) extra.push(`已禁用规则：${s.disabledRules.join('、')}`);
    summaryExtra.textContent = extra.join(' · ');
    downloadDocx.href = job.downloadUrl;
    downloadJson.href = job.dataJsonUrl;
  }
  function hideSummary() {
    summaryCard.classList.remove('active');
  }

  function showError(msg) {
    errorCard.classList.add('active');
    errorCard.textContent = '⚠ ' + msg;
  }
  function hideError() {
    errorCard.classList.remove('active');
  }

  // ============== 历史记录 ==============
  async function loadHistory() {
    try {
      const resp = await fetch('/api/v1/history');
      if (!resp.ok) return;
      const data = await resp.json();
      const entries = data.entries || [];
      renderHistory(entries);
    } catch (_) {
      // 离线时回退到 localStorage
      const local = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      renderHistory(local);
    }
  }

  function renderHistory(entries) {
    if (!entries.length) {
      historyCard.style.display = 'none';
      return;
    }
    historyCard.style.display = 'block';
    historyList.innerHTML = entries.map(e => {
      const dt = new Date(e.completedAt || e.createdAt);
      const dateStr = `${dt.getMonth()+1}/${dt.getDate()} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
      const statusCls = e.status === 'done' ? 'done' : 'error';
      const statusText = e.status === 'done' ? '成功' : '失败';
      const hs = e.summary || {};
      const meta = `节点 ${hs.nodeCount ?? '-'} · P0 ${hs.p0 ?? 0} · P1 ${hs.p1 ?? 0} · ${formatSize(hs.docxSizeBytes)}`;
      return `<div class="history-item">
        <span class="h-status ${statusCls}">${statusText}</span>
        <span class="h-project">${escapeHtml(e.project)}</span>
        <span class="h-meta">${meta} · ${dateStr}</span>
        <span class="h-actions">
          ${e.status === 'done' ? `<a href="${e.downloadUrl}" download>下载</a>` : ''}
          <button data-jobid="${e.jobId}" title="删除记录">删除</button>
        </span>
      </div>`;
    }).join('');
    historyList.querySelectorAll('button[data-jobid]').forEach(btn => {
      btn.addEventListener('click', async ev => {
        const jobId = ev.target.dataset.jobid;
        try {
          await fetch(`/api/v1/history/${jobId}`, { method: 'DELETE' });
        } catch (_) {}
        // 同时清理 localStorage
        const local = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        localStorage.setItem(HISTORY_KEY, JSON.stringify(local.filter(x => x.jobId !== jobId)));
        loadHistory();
      });
    });
  }

  clearHistoryBtn.addEventListener('click', async () => {
    if (!confirm('确定清空所有历史记录？')) return;
    try { await fetch('/api/v1/history', { method: 'DELETE' }); } catch (_) {}
    localStorage.removeItem(HISTORY_KEY);
    loadHistory();
  });

  function saveLocalHistory(job) {
    const local = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    local.unshift({
      jobId: job.jobId,
      project: job.project,
      status: job.status,
      createdAt: job.createdAt,
      completedAt: new Date().toISOString(),
      summary: job.summary,
      downloadUrl: job.downloadUrl,
      dataJsonUrl: job.dataJsonUrl,
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(local.slice(0, 100)));
  }

  function formatSize(b) {
    if (b == null) return '-';
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
