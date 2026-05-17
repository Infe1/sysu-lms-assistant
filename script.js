// ==UserScript==
// @name         中山大学 LMS 学习助手 LLM答题
// @namespace    https://github.com/infe1/sysu-lms-assistant
// @version      2.0
// @description  自动播放LMS视频+自动切超清；多阶段测验自动调用LLM(OpenAI兼容)答题+提交+满分检查+重考；遇讨论页跳过；反焦点检测(切后台仍计时)。
// @author       infe1
// @match        *://lms.sysu.edu.cn/*
// @homepage     https://github.com/infe1/sysu-lms-assistant
// @supportURL   https://github.com/infe1/sysu-lms-assistant/issues
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      *
// @license      GPL-3.0 License
// ==/UserScript==

(function () {
    'use strict';

    // ==================== LLM 配置 (OpenAI 兼容接口) ====================
    // 请在此处填入你的 API 信息，支持 Deepseek / OpenAI / XiaomiMimo 等
    // 也可通过 localStorage 覆盖（在浏览器控制台执行）：
    //   localStorage.setItem('lms_llm_base_url', 'https://api.deepseek.com/v1');
    //   localStorage.setItem('lms_llm_model', 'deepseek-chat');
    //   localStorage.setItem('lms_llm_api_key', 'sk-xxxx');
    // 或点击页面左侧 ⚙️ 按钮可视化配置
    // ====================================================================
    const LLM_CONFIG = {
        base_url: localStorage.getItem('lms_llm_base_url') || 'https://api.deepseek.com/',
        model: localStorage.getItem('lms_llm_model') || 'deepseek-v4-flash',
        api_key: localStorage.getItem('lms_llm_api_key') || '',
        max_tokens: 1024,
        temperature: 0.1,
    };

    // ==================== 行为配置 ====================
    const CHECK_INTERVAL = 1000;        // 每1秒检查状态
    const DELAY_BEFORE_NEXT = 1500;     // 完成后等待1.5秒跳转
    const SKIP_FORUM_DELAY = 2000;      // 讨论页等待2秒跳过
    const VIDEO_END_WAIT = 3000;        // 视频结束后等待3秒再刷新页面（防止跳过测验）
    const LLM_TIMEOUT = 30000;          // LLM 请求超时 30 秒
    const MAX_LLM_RETRY = 4;            // LLM 调用最大重试次数
    const AUTO_SUBMIT_QUIZ = true;      // 是否自动提交测验
    const CONFIRM_BEFORE_SUBMIT = false; // 提交前是否弹窗确认
    // ==================================================

    // ==================== 全局状态 ====================
    let hasNavigated = false;
    let hasSetQuality = false;
    let quizInProgress = false;         // 是否正在处理测验
    let hasHandledQuiz = false;         // 当前页面的测验是否已处理过
    let submittingQuiz = false;         // 是否正在提交流程中（防止重复触发）
    let isRunning = localStorage.getItem('lms_script_running') !== 'false';
    let antiFocusEnabled = localStorage.getItem('lms_anti_focus') !== 'false';
    let silentAudio = null;              // 静音音频保活引用
    let wakeLock = null;                 // Wake Lock 引用

    // ==================== 反焦点检测模块（三层加固） ====================
    // 问题分析：
    //   切标签页 / 最小化 / Win+D 时，浏览器会对后台页面做两件事：
    //   A) 触发 visibilitychange+blur → LMS 平台 JS 得知你"没在看"→ 停止计时
    //   B) 浏览器自身降频 setInterval/setTimeout → 视频暂停、脚本停摆
    // 解决方案 —— 三层加固：
    //   第一层：劫持 API —— 让平台 JS 始终认为页面可见（已有）
    //   第二层：静音音频保活 —— 阻止浏览器冻结/深度降频后台标签页
    //   第三层：Wake Lock —— 阻止屏幕休眠
    // ====================================================================
    function installAntiFocusDetection() {
        if (!antiFocusEnabled) return;

        // ============ 第一层：劫持可见性 API ============
        // 1. document.hidden → 始终 false
        try {
            delete document.hidden;
        } catch (_) { }
        try {
            Object.defineProperty(document, 'hidden', {
                get: () => false,
                configurable: true,
                enumerable: true,
            });
        } catch (_) { }

        // 2. document.visibilityState → 始终 "visible"
        try {
            delete document.visibilityState;
        } catch (_) { }
        try {
            Object.defineProperty(document, 'visibilityState', {
                get: () => 'visible',
                configurable: true,
                enumerable: true,
            });
        } catch (_) { }

        // 3. document.hasFocus → 始终 true
        try {
            document.hasFocus = () => true;
        } catch (_) { }

        // 4. 拦截 visibilitychange 事件监听注册
        const originalAddEventListener = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (type === 'visibilitychange') return;
            return originalAddEventListener.call(this, type, listener, options);
        };

        // 5. 对 document 单独做 Proxy（部分实现不走 prototype）
        document.addEventListener = new Proxy(document.addEventListener, {
            apply(target, thisArg, args) {
                if (args[0] === 'visibilitychange') return;
                return Reflect.apply(target, thisArg, args);
            },
        });

        // 6. 在捕获阶段拦截 window blur
        window.addEventListener('blur', (e) => {
            e.stopImmediatePropagation();
            e.preventDefault();
            // 立即伪造 focus 回弹
            setTimeout(() => {
                window.dispatchEvent(new FocusEvent('focus'));
            }, 50);
        }, { capture: true, passive: false });

        // 7. 子窗口/iframe 也需要覆盖
        for (let i = 0; i < window.frames.length; i++) {
            const fw = window.frames[i];
            if (fw && fw.document) {
                try {
                    fw.document.hasFocus = () => true;
                } catch (_) { }
            }
        }

        // ============ 第二层：静音音频保活 ============
        // 浏览器对有音频播放的标签页会减少降频，这是阻止后台冻结的最有效手段
        startSilentAudio();

        // ============ 第三层：Wake Lock ============
        requestWakeLock();

        // ============ 周期性维持 ============
        setInterval(() => {
            // 伪造 focus / visibilitychange
            window.dispatchEvent(new FocusEvent('focus'));
            document.dispatchEvent(new FocusEvent('focus'));
            document.dispatchEvent(new FocusEvent('visibilitychange', { bubbles: true }));

            // 维持静音音频（防止被浏览器回收）
            if (antiFocusEnabled && !silentAudio) {
                startSilentAudio();
            }

            // 维持 Wake Lock
            if (antiFocusEnabled && !wakeLock) {
                requestWakeLock();
            }
        }, 3000);

        console.log('[LMS] 反焦点检测已激活（三层加固）— 切标签页/最小化均不影响计时');
    }

    // ============ 静音音频保活 ============
    function startSilentAudio() {
        if (silentAudio) return;

        // 方案 A：用 AudioContext 生成静音振荡器（最隐蔽）
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            gain.gain.value = 0.001; // 几乎无声，但浏览器认为在播放音频
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 20;
            osc.start(0);
            silentAudio = { ctx, osc, gain, type: 'oscillator' };
            console.log('[LMS] 静音音频保活已启动 (AudioContext)');
            return;
        } catch (_) { }

        // 方案 B：用 <audio> 标签播放静音 base64（兼容性好）
        try {
            const audio = document.createElement('audio');
            // 0.1 秒的静音 WAV base64
            audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
            audio.loop = true;
            audio.volume = 0.001;
            audio.muted = false; // 关键：不能 muted，否则不算"播放中"
            audio.setAttribute('playsinline', '');
            audio.setAttribute('webkit-playsinline', '');
            document.body.appendChild(audio);
            audio.play().catch(() => { });
            silentAudio = { audio, type: 'element' };
            console.log('[LMS] 静音音频保活已启动 (Audio element)');
            return;
        } catch (_) { }

        console.warn('[LMS] 静音音频保活启动失败，后台标签页可能被冻结');
    }

    function stopSilentAudio() {
        if (!silentAudio) return;
        try {
            if (silentAudio.type === 'oscillator') {
                silentAudio.osc.stop();
                silentAudio.ctx.close();
            } else if (silentAudio.type === 'element') {
                silentAudio.audio.pause();
                silentAudio.audio.remove();
            }
        } catch (_) { }
        silentAudio = null;
    }

    // ============ Wake Lock ============
    function requestWakeLock() {
        if (wakeLock) return;
        if (!navigator.wakeLock) return;

        navigator.wakeLock.request('screen').then(lock => {
            wakeLock = lock;
            lock.addEventListener('release', () => {
                wakeLock = null;
                // 自动重试
                if (antiFocusEnabled) {
                    setTimeout(requestWakeLock, 1000);
                }
            });
            console.log('[LMS] Wake Lock 已获得');
        }).catch(() => { });
    }

    function releaseWakeLock() {
        if (!wakeLock) return;
        try {
            wakeLock.release();
        } catch (_) { }
        wakeLock = null;
    }

    // ==================== 日志系统 ====================
    let logBuffer = [];
    const LOG_STORAGE_KEY = 'lms_script_log';
    const LOG_DATE_KEY = 'lms_script_log_date';

    function getTodayDateString() {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
    }

    function ensureDailyLogStorage() {
        const today = getTodayDateString();
        const savedDate = localStorage.getItem(LOG_DATE_KEY);
        if (savedDate !== today) {
            localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify([]));
            localStorage.setItem(LOG_DATE_KEY, today);
            logBuffer = [];
        }
    }

    function clearLogs(showNotice = true) {
        const today = getTodayDateString();
        logBuffer = [];
        localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify([]));
        localStorage.setItem(LOG_DATE_KEY, today);
        if (showNotice) {
            showToast('🧹 日志已清空');
        }
    }

    function log(...args) {
        ensureDailyLogStorage();
        const msg = args.join(' ');
        const time = new Date().toLocaleTimeString();
        const line = '[' + time + '] ' + msg;
        logBuffer.push(line);
        if (logBuffer.length > 500) logBuffer.shift();
        console.log('[LMS]', msg);
        // 同步到 localStorage（最多保留200条）
        try {
            const existing = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || '[]');
            existing.push(line);
            if (existing.length > 200) existing.splice(0, existing.length - 200);
            localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(existing));
            localStorage.setItem(LOG_DATE_KEY, getTodayDateString());
        } catch (_) { }
    }

    function getLogs() { return logBuffer; }

    function downloadLog() {
        ensureDailyLogStorage();
        const all = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || '[]');
        const blob = new Blob([all.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'lms-log-' + new Date().toISOString().slice(0, 10) + '.txt';
        a.click();
        URL.revokeObjectURL(url);
        showToast('📥 日志已下载');
    }

    // ==================== Toast UI ====================
    let toastContainer;

    function initUI() {
        toastContainer = document.createElement('div');
        toastContainer.style.cssText = `
            position: fixed; bottom: 30px; right: 30px; z-index: 9999999;
            display: flex; flex-direction: column; gap: 10px; pointer-events: none;
        `;
        document.body.appendChild(toastContainer);

        // 主控制按钮
        const btn = document.createElement('button');
        updateBtnStyle(btn);
        btn.style.cssText += `
            position: fixed; top: 30%; left: 10px; z-index: 9999999;
            padding: 10px 15px; color: white; border: none; border-radius: 8px;
            cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            font-weight: bold; font-size: 14px; transition: all 0.3s;
            opacity: 0.85;
        `;
        btn.onmouseenter = () => { btn.style.opacity = '1'; };
        btn.onmouseleave = () => { btn.style.opacity = '0.85'; };
        btn.onclick = () => {
            isRunning = !isRunning;
            localStorage.setItem('lms_script_running', isRunning);
            updateBtnStyle(btn);
            showToast(isRunning ? "▶️ 脚本已恢复运行" : "⏸️ 脚本已暂停");
            if (isRunning) {
                hasNavigated = false;
                hasHandledQuiz = false;
                quizInProgress = false;
            }
        };
        document.body.appendChild(btn);

        // LLM 设置按钮
        const settingsBtn = document.createElement('button');
        settingsBtn.innerText = '⚙️';
        settingsBtn.title = 'LLM 设置';
        settingsBtn.style.cssText = `
            position: fixed; top: 30%; left: 10px; z-index: 9999999;
            margin-top: 50px; padding: 8px 12px; color: white;
            background: #607D8B; border: none; border-radius: 8px;
            cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            font-size: 16px; opacity: 0.85;
        `;
        settingsBtn.onmouseenter = () => { settingsBtn.style.opacity = '1'; };
        settingsBtn.onmouseleave = () => { settingsBtn.style.opacity = '0.85'; };
        settingsBtn.onclick = () => openSettingsDialog();
        document.body.appendChild(settingsBtn);

        // 反焦点检测开关按钮
        const focusBtn = document.createElement('button');
        updateFocusBtnStyle(focusBtn);
        focusBtn.title = '反焦点检测：让平台始终认为你在看';
        focusBtn.style.cssText = `
            position: fixed; top: 30%; left: 10px; z-index: 9999999;
            margin-top: 92px; padding: 6px 10px; color: white;
            border: none; border-radius: 8px;
            cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            font-size: 11px; opacity: 0.85;
        `;
        focusBtn.onmouseenter = () => { focusBtn.style.opacity = '1'; };
        focusBtn.onmouseleave = () => { focusBtn.style.opacity = '0.85'; };
        focusBtn.onclick = () => {
            antiFocusEnabled = !antiFocusEnabled;
            localStorage.setItem('lms_anti_focus', antiFocusEnabled);
            updateFocusBtnStyle(focusBtn);
            if (antiFocusEnabled) {
                installAntiFocusDetection();
                showToast('🛡️ 反焦点检测已开启 — 切标签页/最小化均不影响计时');
            } else {
                stopSilentAudio();
                releaseWakeLock();
                showToast('⚠️ 反焦点检测已关闭（刷新后完全恢复）');
            }
        };
        document.body.appendChild(focusBtn);

        // 下载日志按钮
        const logBtn = document.createElement('button');
        logBtn.innerText = '📥';
        logBtn.title = '下载运行日志';
        logBtn.style.cssText = `
            position: fixed; top: 30%; left: 10px; z-index: 9999999;
            margin-top: 126px; padding: 6px 10px; color: white;
            background: #795548; border: none; border-radius: 8px;
            cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            font-size: 11px; opacity: 0.85;
        `;
        logBtn.onmouseenter = () => { logBtn.style.opacity = '1'; };
        logBtn.onmouseleave = () => { logBtn.style.opacity = '0.85'; };
        logBtn.onclick = () => downloadLog();
        document.body.appendChild(logBtn);

        // 清空日志按钮
        const clearLogBtn = document.createElement('button');
        clearLogBtn.innerText = '🧹';
        clearLogBtn.title = '清空运行日志';
        clearLogBtn.style.cssText = `
            position: fixed; top: 30%; left: 10px; z-index: 9999999;
            margin-top: 160px; padding: 6px 10px; color: white;
            background: #9C27B0; border: none; border-radius: 8px;
            cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            font-size: 11px; opacity: 0.85;
        `;
        clearLogBtn.onmouseenter = () => { clearLogBtn.style.opacity = '1'; };
        clearLogBtn.onmouseleave = () => { clearLogBtn.style.opacity = '0.85'; };
        clearLogBtn.onclick = () => clearLogs(true);
        document.body.appendChild(clearLogBtn);
    }

    function updateBtnStyle(btn) {
        if (isRunning) {
            btn.innerText = 'LMS助手: 运行中';
            btn.style.backgroundColor = '#4CAF50';
        } else {
            btn.innerText = 'LMS助手: 已暂停';
            btn.style.backgroundColor = '#f44336';
        }
    }

    function updateFocusBtnStyle(btn) {
        if (!btn) return;
        if (antiFocusEnabled) {
            btn.innerText = '🛡️ 防检测开';
            btn.style.backgroundColor = '#FF9800';
        } else {
            btn.innerText = '🔓 防检测关';
            btn.style.backgroundColor = '#9E9E9E';
        }
    }

    function showToast(text, duration = 3000) {
        if (!toastContainer) return;
        const toast = document.createElement('div');
        toast.innerText = text;
        toast.style.cssText = `
            background: rgba(0, 0, 0, 0.85); color: #fff; padding: 12px 20px;
            border-radius: 6px; box-shadow: 0 4px 8px rgba(0,0,0,0.3);
            font-size: 14px; opacity: 0; transition: opacity 0.4s ease-in-out;
            max-width: 400px; word-wrap: break-word;
        `;
        toastContainer.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '1'; }, 10);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 400);
        }, duration);
    }

    // ==================== LLM 设置对话框 ====================
    function openSettingsDialog() {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.5); z-index: 99999999;
            display: flex; align-items: center; justify-content: center;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: #fff; border-radius: 12px; padding: 24px; width: 420px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3); font-family: sans-serif;
        `;

        const fields = [
            { label: 'API Base URL', key: 'lms_llm_base_url', val: LLM_CONFIG.base_url },
            { label: 'Model', key: 'lms_llm_model', val: LLM_CONFIG.model },
            { label: 'API Key', key: 'lms_llm_api_key', val: LLM_CONFIG.api_key, type: 'password' },
        ];

        dialog.innerHTML = `
            <h3 style="margin:0 0 16px; color:#333;">⚙️ LLM API 设置</h3>
            <p style="font-size:12px;color:#888;margin-bottom:12px;">
                支持 OpenAI / Deepseek / XiaomiMimo 等兼容接口
            </p>
            ${fields.map(f => `
                <div style="margin-bottom:12px;">
                    <label style="display:block;font-size:13px;font-weight:bold;color:#555;margin-bottom:4px;">${f.label}</label>
                    <input id="lms_setting_${f.key}" type="${f.type || 'text'}"
                        value="${f.val.replace(/"/g, '&quot;')}"
                        style="width:100%;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;box-sizing:border-box;">
                </div>
            `).join('')}
            <div style="margin-bottom:12px;display:flex;align-items:center;gap:10px;">
                <label style="font-size:13px;font-weight:bold;color:#555;">🛡️ 反焦点检测</label>
                <select id="lms_setting_anti_focus" style="padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;">
                    <option value="1" ${antiFocusEnabled ? 'selected' : ''}>开启（推荐）</option>
                    <option value="0" ${!antiFocusEnabled ? 'selected' : ''}>关闭</option>
                </select>
                <span style="font-size:11px;color:#999;">使平台始终认为页面聚焦</span>
            </div>
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
                <button id="lms_settings_cancel" style="padding:8px 16px;border:1px solid #ddd;border-radius:6px;background:#f5f5f5;cursor:pointer;">取消</button>
                <button id="lms_settings_save" style="padding:8px 16px;border:none;border-radius:6px;background:#4CAF50;color:#fff;cursor:pointer;font-weight:bold;">保存</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        overlay.querySelector('#lms_settings_cancel').onclick = () => overlay.remove();
        overlay.querySelector('#lms_settings_save').onclick = () => {
            fields.forEach(f => {
                const input = overlay.querySelector('#lms_setting_' + f.key);
                const val = input.value.trim();
                if (val) {
                    localStorage.setItem(f.key, val);
                    LLM_CONFIG[f.key === 'lms_llm_base_url' ? 'base_url' :
                        f.key === 'lms_llm_model' ? 'model' : 'api_key'] = val;
                }
            });
            // 反焦点检测
            const antiFocusVal = overlay.querySelector('#lms_setting_anti_focus').value;
            const newAntiFocus = antiFocusVal === '1';
            localStorage.setItem('lms_anti_focus', newAntiFocus);
            const oldAntiFocus = antiFocusEnabled;
            antiFocusEnabled = newAntiFocus;
            // 开启：装机检测模块 + 音频保活
            if (!oldAntiFocus && newAntiFocus) {
                installAntiFocusDetection();
            }
            // 关闭：释放音频和 Wake Lock
            if (oldAntiFocus && !newAntiFocus) {
                stopSilentAudio();
                releaseWakeLock();
            }
            // 刷新按钮样式
            if (oldAntiFocus !== newAntiFocus) {
                const fb = document.querySelectorAll('button[title*="反焦点"]');
                fb.forEach(b => updateFocusBtnStyle(b));
            }
            showToast('✅ 设置已保存');
            overlay.remove();
        };
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    }

    // ==================== LLM API 调用 ====================
    function callLLM(questions) {
        return new Promise((resolve, reject) => {
            const prompt = buildPrompt(questions);
            log('[LLM] 发送请求, 共' + questions.length + '题, model=' + LLM_CONFIG.model + ', url=' + LLM_CONFIG.base_url);
            log('[LLM] prompt:\n' + prompt.substring(0, 500) + (prompt.length > 500 ? '...' : ''));

            const body = JSON.stringify({
                model: LLM_CONFIG.model,
                messages: [
                    {
                        role: 'system',
                        content: '你是一个学习助手。请根据题目内容选择正确答案。你必须严格按指定格式回复，每行一题，不要包含任何其他文字。'
                    },
                    { role: 'user', content: prompt }
                ],
                max_tokens: LLM_CONFIG.max_tokens,
                temperature: LLM_CONFIG.temperature,
            });

            const url = LLM_CONFIG.base_url.replace(/\/+$/, '') + '/chat/completions';

            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + LLM_CONFIG.api_key,
                },
                data: body,
                timeout: LLM_TIMEOUT,
                onload: function (resp) {
                    try {
                        const data = JSON.parse(resp.responseText);
                        if (data.error) {
                            reject(new Error('API Error: ' + JSON.stringify(data.error)));
                            return;
                        }
                        const content = data.choices?.[0]?.message?.content;
                        if (!content) {
                            reject(new Error('LLM 返回内容为空'));
                            return;
                        }
                        resolve(content.trim());
                    } catch (e) {
                        reject(new Error('解析 LLM 响应失败: ' + e.message));
                    }
                },
                onerror: function () {
                    reject(new Error('LLM 网络请求失败'));
                },
                ontimeout: function () {
                    reject(new Error('LLM 请求超时'));
                },
            });
        });
    }

    function buildPrompt(questions) {
        const lines = [
            '请回答以下测验题目。你可以先思考分析，但最后答案必须用{类型,答案}格式写在行末。',
            '类型: judge / choice / multi',
            'judge: T或F（T=正确/对，F=错误/错）',
            'choice: 选项字母如C',
            'multi: 选项字母组合如CD（字母大写无分隔）',
            '最终答案格式: {judge,T} {choice,C} {multi,ABD}',
            '',
        ];

        questions.forEach((q, i) => {
            const shortType = q.type === 'truefalse' ? 'judge' : q.type === 'single' ? 'choice' : q.type === 'multiple' ? 'multi' : q.type;
            lines.push('Q' + (i + 1) + ' (' + shortType + '): ' + q.text);
            if (q.options && q.options.length > 0) {
                const optStrs = q.options.map((opt, j) => {
                    const letter = opt.letter || String.fromCharCode(65 + j);
                    return '  ' + letter + '. ' + opt.label;
                });
                lines.push(optStrs.join('\n'));
            }
            lines.push('');
        });

        lines.push('请给出最终答案（每行用{类型,答案}包裹）：');
        return lines.join('\n');
    }

    // 解析 LLM 返回：从任何位置提取 {type,answer}
    function parseLLMResponse(responseText, questions) {
        log('[LLM] 原始返回(首300):', responseText.substring(0, 300));
        const text = responseText.trim();

        // 从LLM返回中提取所有 {xxx,yyy} 模式
        const matches = text.match(/\{(judge|choice|multi)\s*[,，]\s*([^}]+)\}/gi);
        if (!matches || matches.length === 0) {
            // fallback: 按行解析
            log('[LLM] 未找到{}包裹答案，尝试按行解析');
            return parseLines(responseText, questions);
        }

        const result = [];
        matches.forEach(m => {
            const inner = m.replace(/[{}]/g, '').trim();
            const parts = inner.split(/[,，\s]+/);
            if (parts.length >= 2) {
                const type = parts[0].toLowerCase();
                const answer = parts.slice(1).join('').toUpperCase();
                result.push({ type, answer });
            }
        });

        while (result.length < questions.length) result.push(null);
        log('[LLM] 解析结果(' + result.filter(r => r).length + '条):',
            result.map(r => r ? r.type + ',' + r.answer : 'null').join(' | '));
        return result;
    }

    function parseLines(text, questions) {
        const lines = text.split('\n').filter(l => l.trim());
        const result = [];
        const validTypes = ['judge', 'choice', 'multi'];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();

            // 跳过明显不是答案的行
            if (/^(题目|以下是|请|答案|回答|注|注意)/.test(line)) continue;
            if (/^Q\d/.test(line) && !/[,，]/.test(line)) continue;

            // 去掉 {} 括号
            line = line.replace(/[{}（）()【】\[\]]/g, '').trim();

            // 尝试多种匹配模式
            // 模式1: "judge,F"  "choice,C"  "multi,CD"
            let match = line.match(/^(judge|choice|multi|判断|单选|多选)\s*[,，:：]\s*(.+)$/i);
            if (!match) {
                // 模式2: 只有答案无类型，推断类型
                // "F" or "T" → judge
                if (/^[TF]$/i.test(line) && questions[result.length]?.type === 'judge') {
                    result.push({ type: 'judge', answer: line.toUpperCase() });
                    continue;
                }
                // 单个字母 → choice
                if (/^[A-E]$/i.test(line) && questions[result.length]?.type === 'choice') {
                    result.push({ type: 'choice', answer: line.toUpperCase() });
                    continue;
                }
                // 多个字母 → multi
                if (/^[A-E]{2,}$/i.test(line) && questions[result.length]?.type === 'multi') {
                    result.push({ type: 'multi', answer: line.toUpperCase() });
                    continue;
                }
                // 模式3: 去数字
                const stripped = line.replace(/[0-9]/g, '');
                if (/^[TF]$/i.test(stripped)) {
                    result.push({ type: 'judge', answer: stripped.toUpperCase() });
                    continue;
                }
                result.push(null);
                continue;
            }

            const typeRaw = match[1].toLowerCase();
            const answer = match[2].trim().toUpperCase().replace(/\s+/g, '');
            const type = typeRaw === '判断' ? 'judge' : typeRaw === '单选' ? 'choice' : typeRaw === '多选' ? 'multi' : typeRaw;

            if (!validTypes.includes(type)) {
                result.push(null);
                continue;
            }

            result.push({ type, answer });
        }

        // 补齐
        while (result.length < questions.length) result.push(null);

        log('[LLM] 解析结果(' + result.filter(r => r).length + '条):',
            result.map(r => r ? r.type + ',' + r.answer : 'null').join(' | '));

        return result;
    }

    // ==================== 测验检测与题目提取 ====================
    function isQuizViewPage() {
        const url = window.location.href;
        return url.includes('/mod/quiz/view.php');
    }

    function isAttemptPage() {
        const url = window.location.href;
        return url.includes('/mod/quiz/attempt.php');
    }

    function isSummaryPage() {
        const url = window.location.href;
        return url.includes('/mod/quiz/summary.php');
    }

    function isReviewPage() {
        const url = window.location.href;
        return url.includes('/mod/quiz/review.php');
    }

    function extractQuestions() {
        log('[extract] 开始提取题目...');
        const questions = [];
        const mainEl = document.querySelector('[role="main"]') || document.querySelector('#region-main') || document.body;

        // 查找试题块：h3 "试题 X" 后面跟着的题目内容
        const headings = mainEl.querySelectorAll('h3, h4');
        const qBlocks = [];

        headings.forEach(h => {
            const text = h.innerText.trim();
            if (/^试题\s*\d+$/.test(text)) {
                const parent = h.closest('div[id]') || h.parentElement;
                if (parent) {
                    qBlocks.push(parent);
                }
            }
        });

        // 如果没找到带id的块，尝试按层级找
        if (qBlocks.length === 0) {
            mainEl.querySelectorAll('h3').forEach(h => {
                const text = h.innerText.trim();
                if (/^试题\s*\d+$/.test(text)) {
                    let current = h.parentElement;
                    // 向上找包含题目内容的容器
                    while (current && current !== mainEl && current !== document.body) {
                        const radioBtns = current.querySelectorAll('input[type="radio"]');
                        const checkBoxes = current.querySelectorAll('input[type="checkbox"]');
                        if (radioBtns.length > 0 || checkBoxes.length > 0) {
                            qBlocks.push(current);
                            break;
                        }
                        current = current.parentElement;
                    }
                }
            });
        }

        // 去重
        const uniqueBlocks = [];
        qBlocks.forEach(b => {
            if (!uniqueBlocks.includes(b)) uniqueBlocks.push(b);
        });

        uniqueBlocks.forEach((block, idx) => {
            const q = extractSingleQuestion(block, idx);
            if (q) questions.push(q);
        });

        log('[extract] 共提取 ' + questions.length + ' 题');
        questions.forEach((q, i) => log('[extract] Q' + (i + 1) + ' type=' + q.type + ' text=' + q.text.substring(0, 60)));
        return questions;
    }

    function extractSingleQuestion(el, idx) {
        // 找题目文字
        let text = '';
        const texts = [];
        const h4 = el.querySelector('h4[id*="question"]');
        if (h4) {
            let next = h4.nextElementSibling;
            while (next && next.tagName !== 'DIV' && next.tagName !== 'FIELDSET') {
                if (next.innerText && !next.querySelector('h3,h4')) {
                    texts.push(next.innerText.trim());
                }
                next = next.nextElementSibling;
            }
        }

        // fallback: 找 .qtext 或 "试题正文" 后的文字
        if (texts.length === 0) {
            const qtextEl = el.querySelector('.qtext, .questiontext');
            if (qtextEl) {
                text = qtextEl.innerText.trim();
            } else {
                const allText = el.innerText;
                // 去掉选项、状态标签后的纯题目文字
                const lines = allText.split('\n').filter(l => {
                    const t = l.trim();
                    if (!t) return false;
                    if (/^(判断题|选择题|多选题|还未作答|答案已保存|满分|得分|正确|不正确|标记试题|选择一项|请选择多个)/.test(t)) return false;
                    if (/^[A-E]\./.test(t) && t.length < 30) return false;
                    if (/^(对|错)$/.test(t)) return false;
                    return true;
                });
                text = lines.join(' ').substring(0, 500);
            }
        } else {
            text = texts.join(' ');
        }

        text = text.replace(/\s+/g, ' ').trim();
        if (!text || text.length < 3) return null;

        // 判断类型
        let type = 'choice'; // 单选
        const typeLabelEl = el.querySelector('[class*="state"], .state, .info .state');
        if (typeLabelEl) {
            const typeText = typeLabelEl.innerText.trim();
            if (typeText.includes('多选')) type = 'multi';
            else if (typeText.includes('判断')) type = 'judge';
            else if (typeText.includes('选择')) type = 'choice';
        }

        // 获取选项
        const options = [];
        const radios = el.querySelectorAll('input[type="radio"]');
        const checkboxes = el.querySelectorAll('input[type="checkbox"]');

        if (radios.length > 0) {
            // 排除隐藏的"清空我的选择"radio
            radios.forEach(r => {
                const parent = r.closest('div, label');
                if (!parent) return;
                const labelText = parent.innerText.trim();
                if (labelText === '对' || labelText === '错') {
                    if (!options.some(o => o.label === labelText)) {
                        options.push({ letter: labelText === '对' ? 'T' : 'F', index: options.length, label: labelText, radio: r });
                    }
                } else {
                    const letterMatch = labelText.match(/^([A-E])\./);
                    if (letterMatch) {
                        const letter = letterMatch[1];
                        const content = labelText.replace(/^[A-E]\.\s*/, '').trim();
                        if (!options.some(o => o.letter === letter)) {
                            options.push({ letter, index: options.length, label: content, radio: r });
                        }
                    }
                }
            });
            if (options.length === 2 && options.every(o => o.label === '对' || o.label === '错')) {
                type = 'judge';
            } else {
                type = 'choice';
            }
        }

        if (checkboxes.length > 0) {
            type = 'multi';
            checkboxes.forEach(cb => {
                const parent = cb.closest('div, label');
                if (!parent) return;
                const labelText = parent.innerText.trim();
                const letterMatch = labelText.match(/^([A-E])\./);
                if (letterMatch) {
                    const letter = letterMatch[1];
                    const content = labelText.replace(/^[A-E]\.\s*/, '').trim();
                    if (!options.some(o => o.letter === letter)) {
                        options.push({ letter, index: options.length, label: content, checkbox: cb });
                    }
                }
            });
        }

        return { text, options, type, element: el, index: idx };
    }

    // ==================== 作答 ====================
    function selectAnswers(parsedAnswers, questions) {
        let filled = 0;
        log('[select] 开始填入答案...');
        questions.forEach((q, i) => {
            const parsed = parsedAnswers[i];
            if (!parsed || !parsed.answer) {
                console.warn('[LMS] 题目' + (i + 1) + '无答案，跳过');
                return;
            }

            const ans = parsed.answer.toUpperCase();
            const opts = q.options;
            log('[select] Q' + (i + 1) + ' type=' + q.type + ' LLM-ans=' + ans + ' opts=' + opts.length);

            if (q.type === 'judge') {
                const targetLabel = (ans === 'T' || ans === 'TRUE' || ans === '对' || ans === '正确') ? '对' : '错';
                const opt = opts.find(o => o.label === targetLabel);
                if (opt && opt.radio) {
                    opt.radio.checked = true;
                    opt.radio.dispatchEvent(new Event('change', { bubbles: true }));
                    filled++;
                }
            } else if (q.type === 'choice') {
                const opt = opts.find(o => o.letter === ans);
                if (opt && opt.radio) {
                    opt.radio.checked = true;
                    opt.radio.dispatchEvent(new Event('change', { bubbles: true }));
                    filled++;
                }
            } else if (q.type === 'multi') {
                const letters = ans.split('').filter(ch => /[A-E]/.test(ch));
                opts.forEach(opt => {
                    if (opt.checkbox) {
                        opt.checkbox.checked = letters.includes(opt.letter);
                        if (letters.includes(opt.letter)) filled++;
                    }
                });
            }
        });

        showToast('✅ 已填入 ' + filled + ' 个选项');
        log('[select] 完成: ' + filled + ' 个选项已选中');
    }

    // ==================== 提交流程（真实网页结构） ====================
    // 流程: view.php → [开始作答] → preflight弹窗[开始作答] → attempt.php
    //       attempt.php → [结束作答…] → summary.php
    //       summary.php → [全部提交并结束] → 确认弹窗[全部提交并结束] → review.php

    function clickStartAttempt() {
        // 第一步：点击主页面上的"开始作答"按钮
        const startBtn = document.querySelector('button[id*="single_button"], form button[type="submit"][value*="开始"]')
            || Array.from(document.querySelectorAll('button')).find(b => /开始作答/.test(b.innerText))
            || Array.from(document.querySelectorAll('input[type="submit"]')).find(b => /开始作答/.test(b.value));

        if (startBtn) {
            showToast('📝 点击"开始作答"...');
            startBtn.click();

            // 等待 preflight 弹窗出现
            setTimeout(() => {
                clickPreflightConfirm();
            }, 800);
            return true;
        }
        return false;
    }

    function clickPreflightConfirm() {
        // 第二步：preflight 弹窗中的"开始作答"
        const dialog = document.querySelector('.moodle-dialogue:not(.moodle-dialogue-hidden), [role="dialog"]:not([aria-hidden="true"])');
        if (dialog) {
            const confirmBtn = dialog.querySelector('input[type="submit"][value*="开始"]')
                || dialog.querySelector('button[value*="开始"]')
                || Array.from(dialog.querySelectorAll('button')).find(b => /开始作答/.test(b.innerText));

            if (confirmBtn) {
                showToast('📝 确认开始作答...');
                confirmBtn.click();
                return true;
            }
        }

        // fallback：直接找弹窗按钮
        const allInputs = document.querySelectorAll('input[type="submit"]');
        for (const inp of allInputs) {
            if (/开始作答/.test(inp.value) && inp.offsetParent !== null) {
                inp.click();
                return true;
            }
        }

        return false;
    }

    function clickEndAttempt() {
        // attempt.php → summary.php：点击"结束作答…"
        const endBtn = Array.from(document.querySelectorAll('button, a, input[type="submit"]')).find(b =>
            /结束作答/.test(b.innerText || b.value || '')
        );
        if (endBtn) {
            showToast('📤 结束作答，进入概要页...');
            endBtn.click();
            return true;
        }
        return false;
    }

    function clickSubmitAll() {
        // summary.php 第一步：点击页面上的"全部提交并结束"
        const submitBtn = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn')).find(b =>
            /全部提交并结束/.test(b.innerText || b.value || '')
        );
        if (submitBtn) {
            log('[submit] 找到页面提交按钮:', submitBtn.tagName, (submitBtn.innerText || submitBtn.value).trim());
            showToast('📤 提交所有答案...');
            submittingQuiz = true;
            submitBtn.click();
            // 轮询等待确认弹窗出现
            waitForDialogAndConfirm(0);
            return true;
        }
        log('[submit] 未找到"全部提交并结束"按钮');
        return false;
    }

    function waitForDialogAndConfirm(retry) {
        if (retry > 20) { log('[submit] 超时'); submittingQuiz = false; return; }

        // 首要策略：直接在 Moodle YUI 弹窗的 .moodle-dialogue-bd 中找确认按钮
        // Moodle 确认弹窗使用 <input type="button" value="全部提交并结束"> 而非 <button>
        const dialogBd = document.querySelector('.moodle-dialogue-confirm .moodle-dialogue-bd, .moodle-dialogue-base .moodle-dialogue-bd');
        if (dialogBd && dialogBd.offsetParent !== null) {
            const dialogBtn = dialogBd.querySelector('input[type="button"][value*="提交"], input[type="submit"][value*="提交"], button');
            if (dialogBtn && /全部提交并结束/.test(dialogBtn.value || dialogBtn.innerText || '')) {
                log('[submit] 在.dialogue-bd中找到弹窗按钮:', (dialogBtn.value || dialogBtn.innerText).trim());
                showToast('📤 确认提交...');
                dialogBtn.click();
                submittingQuiz = false;
                return;
            }
        }

        // 策略2：找页面中所有可见且激活的"全部提交并结束"按钮
        // 关键：Moodle 确认弹窗用 input[type="button"]，必须包含此类型！
        const allCandidates = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).filter(b => {
            const txt = (b.innerText || b.value || '').trim();
            return /全部提交并结束/.test(txt) && b.offsetParent !== null && !b.disabled;
        });

        log('[submit] 轮询#' + retry + ' 找到' + allCandidates.length + '个可见候选按钮');

        if (allCandidates.length >= 2) {
            // 有多个 → 弹窗里的那个在 .moodle-dialogue-confirm 内或有"取消"兄弟
            const dialogBtn = allCandidates.find(b => {
                const inDialog = b.closest('.moodle-dialogue-confirm, .moodle-dialogue-base, [role="dialog"], dialog, .yui3-panel');
                if (inDialog && inDialog.offsetParent !== null) return true;
                const parent = b.parentElement;
                if (!parent) return false;
                const siblings = parent.querySelectorAll('input[type="button"], input[type="submit"], button');
                return Array.from(siblings).some(s => /取消/.test(s.value || s.innerText || ''));
            }) || allCandidates[allCandidates.length - 1];

            log('[submit] 选中弹窗按钮:', (dialogBtn.value || dialogBtn.innerText).trim());
            showToast('📤 确认提交...');
            dialogBtn.click();
            submittingQuiz = false;
            return;
        }

        if (allCandidates.length === 1 && retry > 5) {
            log('[submit] 仅1个按钮且等待足够，直接点击');
            allCandidates[0].click();
            submittingQuiz = false;
            return;
        }

        // 也检测 Moodle 原生 dialog 标签
        const htmlDialog = document.querySelector('dialog[open]');
        if (htmlDialog) {
            const btn = Array.from(htmlDialog.querySelectorAll('button, input[type="submit"], input[type="button"]')).find(b =>
                /全部提交并结束/.test(b.innerText || b.value || '')
            );
            if (btn) {
                log('[submit] 在<dialog>中找到按钮');
                btn.click();
                submittingQuiz = false;
                return;
            }
        }

        setTimeout(() => waitForDialogAndConfirm(retry + 1), 500);
    }

    function getReviewScore() {
        // 在 review.php 中读取评分
        const tableRows = document.querySelectorAll('table tr');
        for (const row of tableRows) {
            const text = row.innerText.trim();
            if (/评分/.test(text)) {
                const match = text.match(/(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)/);
                if (match) {
                    return { score: parseFloat(match[1]), total: parseFloat(match[2]) };
                }
                const pctMatch = text.match(/(\d+)%/);
                if (pctMatch) {
                    const pct = parseInt(pctMatch[1]);
                    return { score: pct, total: 100, percent: pct };
                }
            }
        }
        return null;
    }

    function clickEndReview() {
        const endBtn = Array.from(document.querySelectorAll('button, a')).find(b =>
            /结束回顾/.test(b.innerText || '')
        );
        if (endBtn) {
            endBtn.click();
            return true;
        }
        return false;
    }

    // ==================== 自动推进到下一节（非测验页） ====================
    function goNextAfterQuiz() {
        // 测验完成后清除视频刷新标记（测验已成功处理，不需要再等待）
        sessionStorage.removeItem('lms_video_ended_refresh');
        // 测验完成后用下一节的链接跳转
        const nextLinks = document.querySelectorAll('a[href*="forceview=1"]');
        // 找带有 ► 的链接
        for (const link of nextLinks) {
            if (/►/.test(link.innerText)) {
                hasNavigated = true;
                link.click();
                setTimeout(() => { window.location.href = link.href; }, 800);
                return true;
            }
        }

        // fallback: 找 id=next-activity-link
        const nextLink = document.getElementById('next-activity-link');
        if (nextLink) {
            hasNavigated = true;
            nextLink.click();
            return true;
        }

        return false;
    }

    // ==================== 默认语言选择：测验需确认 ====================
    // view.php 页面有时需要先选语言，不处理（页面自己会处理）

    // ==================== LLM 答题流程 ====================
    let quizRetryCount = 0;
    const MAX_QUIZ_RETRY = 2;  // 最多重考次数

    async function handleQuiz() {
        if (quizInProgress) return false;
        quizInProgress = true;
        // 测验已触发，清除视频刷新标记
        sessionStorage.removeItem('lms_video_ended_refresh');

        const url = window.location.href;
        log('[quiz] 进入测验流程, url=' + url);

        // ---- 阶段1: view.php → 点击"开始作答" ----
        if (isQuizViewPage()) {
            // 如果刚完成一次答题（hasHandledQuiz 为 true），说明是从 review 回来的，
            // 不要再开始作答，直接跳到下一节
            if (hasHandledQuiz) {
                log('[quiz] view.php 但已答过题，跳过测验 → 找下一节');
                if (goNextAfterQuiz()) {
                    log('[quiz] 从 view.php 跳转到下一节');
                } else {
                    // 回退：点 ◄ 回到课程页
                    const backLink = document.querySelector('a[href*="forceview=1"]');
                    if (backLink && /◄/.test(backLink.innerText)) {
                        backLink.click();
                    }
                }
                quizInProgress = false;
                return true;
            }
            log('[quiz] 阶段1: view.php → 点击开始作答');
            showToast('📝 检测到测验概览页，准备开始作答...');
            await sleep(600);
            if (clickStartAttempt()) {
                showToast('⏳ 等待进入答题页...');
                // 页面将自动跳转到 attempt.php，本轮结束
            } else {
                showToast('⚠️ 未找到"开始作答"按钮', 5000);
            }
            quizInProgress = false;
            return false;
        }

        // ---- 阶段2: attempt.php → 提取题目 + LLM作答 ----
        if (isAttemptPage()) {
            log('[quiz] 阶段2: attempt.php → 提取题目+LLM作答');
            if (hasHandledQuiz) {
                quizInProgress = false;
                return false;
            }

            showToast('📝 答题页：正在提取题目...');
            await sleep(800);

            const questions = extractQuestions();

            if (questions.length === 0) {
                showToast('⚠️ 未能提取到题目，可能还在preflight弹窗...');
                // 重试一次 preflight 确认
                clickPreflightConfirm();
                quizInProgress = false;
                return false;
            }

            showToast('📋 共 ' + questions.length + ' 道题，调用 LLM 作答...');

            if (!LLM_CONFIG.api_key || LLM_CONFIG.api_key === '') {
                showToast('⚠️ 请先设置 LLM API Key！点击左侧 ⚙️ 按钮', 8000);
                quizInProgress = false;
                return false;
            }

            // LLM 调用 + 重试
            let parsedAnswers = null;
            for (let attempt = 0; attempt <= MAX_LLM_RETRY; attempt++) {
                try {
                    if (attempt > 0) {
                        showToast('🔄 LLM 重试 (' + attempt + '/' + MAX_LLM_RETRY + ')...');
                        await sleep(2000);
                    }
                    const responseText = await callLLM(questions);
                    console.log('[LMS] LLM 原始返回:', responseText);
                    parsedAnswers = parseLLMResponse(responseText, questions);
                    console.log('[LMS] 解析结果:', parsedAnswers);
                    break;
                } catch (e) {
                    console.error('[LMS] LLM 失败:', e);
                    if (attempt >= MAX_LLM_RETRY) {
                        showToast('❌ LLM 答题失败: ' + e.message, 8000);
                        quizInProgress = false;
                        return false;
                    }
                }
            }

            if (!parsedAnswers || parsedAnswers.filter(a => a !== null).length === 0) {
                showToast('❌ LLM 未返回有效答案', 8000);
                quizInProgress = false;
                return false;
            }

            // 填入答案
            selectAnswers(parsedAnswers, questions);
            hasHandledQuiz = true;

            // 点击"结束作答…"
            await sleep(500);
            showToast('📤 正在结束作答...');
            clickEndAttempt();

            quizInProgress = false;
            return true;
        }

        // ---- 阶段3: summary.php → 提交 ----
        if (isSummaryPage()) {
            if (submittingQuiz) { quizInProgress = false; return false; }
            log('[quiz] 阶段3: summary.php → 提交');
            showToast('📋 作答概要，准备提交...');
            await sleep(600);
            const checkBoxes = document.querySelectorAll('input[type="checkbox"]');
            // Moodle 的"您确认提交"勾选框
            const confirmCheckbox = Array.from(checkBoxes).find(cb =>
                /确认|确认提交|不再修改/i.test(cb.parentElement?.innerText || '')
            );
            if (confirmCheckbox && !confirmCheckbox.checked) {
                confirmCheckbox.checked = true;
            }
            clickSubmitAll();
            quizInProgress = false;
            return true;
        }

        // ---- 阶段4: review.php → 查看得分 + 决定是否重考 ----
        if (isReviewPage()) {
            log('[quiz] 阶段4: review.php → 查看得分');
            await sleep(600);
            const scoreResult = getReviewScore();
            if (scoreResult) {
                log('[quiz] 得分:', JSON.stringify(scoreResult));
                const score = scoreResult.score;
                const total = scoreResult.total;
                const pct = scoreResult.percent || Math.round(score / total * 100);
                showToast('📊 得分: ' + score + '/' + total + ' (' + pct + '%)', 5000);

                if (pct < 100 && quizRetryCount < MAX_QUIZ_RETRY) {
                    quizRetryCount++;
                    log('[quiz] 未满分(pct=' + pct + '), 第' + quizRetryCount + '次重考');
                    showToast('🔄 未满分，第' + quizRetryCount + '次重考...', 4000);
                    // 导航回 view.php 重新开始
                    const returnLink = document.querySelector('a[href*="view.php?id="]')
                        || Array.from(document.querySelectorAll('a')).find(a => /view\.php\?id=/.test(a.href));
                    if (returnLink) {
                        hasHandledQuiz = false;
                        quizInProgress = false;
                        await sleep(1000);
                        window.location.href = returnLink.href;
                        return true;
                    }
                } else if (pct >= 100) {
                    showToast('🎉 满分通过！', 5000);
                    quizRetryCount = 0;
                } else {
                    showToast('⚠️ 已达最大重考次数，继续下一节', 5000);
                    quizRetryCount = 0;
                }

                // 满分/达重试上限后：优先直接从 review.php 找 ► 链接跳转下一节
                // review.php 页面上就挂着下一节的链接，无需先回 view.php
                if ((pct >= 100 || quizRetryCount === 0) && goNextAfterQuiz()) {
                    log('[quiz] 直接从 review.php 跳转到下一节');
                    hasNavigated = true;
                    quizInProgress = false;
                    return true;
                }
            }

            // 回退：结束回顾 → 回到 view.php 然后推进下一节
            await sleep(500);
            clickEndReview();
            // 监控页面变化，后续推进
            setTimeout(() => {
                if (!goNextAfterQuiz()) {
                    // 回到 view.php 后自动点 ◄ 回到课程页
                    const backLink = document.querySelector('a[href*="forceview=1"]');
                    if (backLink && /◄/.test(backLink.innerText)) {
                        backLink.click();
                    }
                }
            }, 1500);

            quizInProgress = false;
            return true;
        }

        quizInProgress = false;
        return false;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ==================== 导航辅助 ====================
    function checkApiKeyConfigured() {
        if (!LLM_CONFIG.api_key || LLM_CONFIG.api_key === '') {
            if (window.location.href.includes('/course/view.php') || isQuizViewPage() || isAttemptPage()) {
                showToast('⚠️ LLM API Key 未配置！点击左侧 ⚙️ 按钮设置。支持 Deepseek/OpenAI/XiaomiMimo 等平台', 10000);
            }
        }
    }

    // ==================== 主循环 ====================
    ensureDailyLogStorage();
    installAntiFocusDetection();
    initUI();

    if (isRunning) {
        showToast('▶️ LMS 自动学习助手已启动 (v2.0 LLM版)');
        setTimeout(checkApiKeyConfigured, 3000);
    }

    let mainLoop = setInterval(() => {
        if (!isRunning || hasNavigated) return;

        const url = window.location.href;

        // ==============================
        // 0. 测验流程（多阶段）优先处理
        // ==============================
        if (url.includes('/mod/quiz/') && !quizInProgress) {
            // view.php / attempt.php / summary.php / review.php 全部由 handleQuiz 处理
            handleQuiz();
            return;
        }

        // ==============================
        // 1. 讨论页面：自动跳过
        // ==============================
        const isForumPage = url.includes('/mod/forum/view.php') ||
            document.body.id === 'page-mod-forum-view';

        if (isForumPage) {
            const nextLink = document.getElementById('next-activity-link');
            if (nextLink) {
                showToast('⏭️ 检测到讨论页，' + (SKIP_FORUM_DELAY / 1000) + '秒后自动跳过...');
                hasNavigated = true;
                clearInterval(mainLoop);
                setTimeout(() => {
                    nextLink.click();
                    setTimeout(() => { window.location.href = nextLink.href; }, 1000);
                }, SKIP_FORUM_DELAY);
            } else {
                showToast('⏭️ 检测到讨论页，但没有下一页按钮');
                clearInterval(mainLoop);
            }
            return;
        }

        // ==============================
        // 2. 视频页面：重置测验状态 + 自动切换超清
        // ==============================
        // 进入视频页说明已出测验，重置状态
        if (hasHandledQuiz && url.includes('/mod/fsresource/view.php')) {
            hasHandledQuiz = false;
        }

        const qualityContainer = document.querySelector('.tcp-video-quality-switcher');
        if (qualityContainer && !hasSetQuality) {
            const qualityTextElem = qualityContainer.querySelector('.tcp-quality-switcher-value p');
            if (qualityTextElem && qualityTextElem.innerText.trim() !== '超清') {
                const hdOption = Array.from(qualityContainer.querySelectorAll('.vjs-menu-item'))
                    .find(el => el.innerText.includes('超清'));
                if (hdOption) {
                    showToast('⚙️ 正在自动切换为【超清】画质...');
                    hdOption.click();
                } else {
                    showToast('⚠️ 未找到【超清】选项，保持默认画质');
                }
            }
            hasSetQuality = true;
        }

        // ==============================
        // 3. 视频页面：自动播放与防暂停
        // ==============================
        const video = document.querySelector('video');
        if (video) {
            if (video.paused && !video.ended) {
                video.muted = true;
                const playPromise = video.play();
                if (playPromise !== undefined) {
                    playPromise.catch(() => {
                        showToast('⚠️ 浏览器拦截了自动播放，请手动点击页面激活');
                    });
                }
            }

            video.onpause = function () {
                if (isRunning && !video.ended && !hasNavigated) {
                    video.play().catch(() => { });
                }
            };
        }

        // ==============================
        // 4. 检测进度与自动下一页
        // ==============================
        const progressSpan = document.querySelector('.num-bfjd span');
        const statusSpan = document.querySelector('.tips-completion');
        const hasProgressTracker = !!progressSpan || !!statusSpan;
        const progress = progressSpan ? parseFloat(progressSpan.innerText) : 0;
        const isCompletedText = statusSpan ? statusSpan.innerText.trim() === '已完成' : false;
        const isVideoEnded = video ? video.ended : false;

        let isTrulyCompleted = false;

        if (video) {
            if (hasProgressTracker) {
                if (progress >= 100 || isCompletedText) {
                    isTrulyCompleted = true;
                }
            } else if (isVideoEnded) {
                isTrulyCompleted = true;
            }
        } else if (hasProgressTracker) {
            if (progress >= 100 || isCompletedText) {
                isTrulyCompleted = true;
            }
        }

        if (isTrulyCompleted) {
            // ---- 视频页完成后先刷新页面，让“下一活动”更新为测验/下一视频 ----
            if (video) {
                const refreshFlag = sessionStorage.getItem('lms_video_ended_refresh');
                if (!refreshFlag) {
                    sessionStorage.setItem('lms_video_ended_refresh', '1');
                    log('[video] 视频页已满足完成条件，' + (VIDEO_END_WAIT / 1000) + '秒后刷新页面，让下一活动更新。progress=' + progress + ', completedText=' + isCompletedText + ', ended=' + isVideoEnded);
                    showToast('📺 本节已完成，' + (VIDEO_END_WAIT / 1000) + '秒后刷新页面更新下一活动...');
                    hasNavigated = true;
                    clearInterval(mainLoop);
                    setTimeout(() => {
                        log('[video] 执行 location.reload()，刷新页面后继续按常规下一活动跳转');
                        location.reload();
                    }, VIDEO_END_WAIT);
                    return;
                }
                // 刷新后不做特殊测验跳转，清除标记继续走常规下一活动逻辑
                log('[video] 页面已刷新，清除刷新标记并继续按常规下一活动逻辑处理');
                sessionStorage.removeItem('lms_video_ended_refresh');
            }

            // 正常导航前清除可能残留的刷新标记
            sessionStorage.removeItem('lms_video_ended_refresh');

            const nextLink = document.getElementById('next-activity-link');
            if (nextLink) {
                showToast('✅ 学习任务完成！' + (DELAY_BEFORE_NEXT / 1000) + '秒后自动下一页...');
                hasNavigated = true;
                clearInterval(mainLoop);

                setTimeout(() => {
                    showToast('⏭️ 正在跳转...');
                    nextLink.click();
                    setTimeout(() => { window.location.href = nextLink.href; }, 1000);
                }, DELAY_BEFORE_NEXT);
            } else {
                showToast('✅ 本节完成！等待页面跳转...', 5000);
            }
            return;
        }

        if (isVideoEnded && hasProgressTracker && video) {
            showToast('⚠️ 视频结束但进度未满 (' + progress + '%)，自动重播补全进度...', 4000);
            video.currentTime = 0;
            video.play();
        }

        // ==============================
        // 5. 非视频页面的自动推进
        // ==============================
        if (!video && !hasProgressTracker && !url.includes('/mod/quiz/') && !isForumPage) {
            const nextLink = document.getElementById('next-activity-link');
            const completionCheck = document.querySelector('.completion-info, [class*="completion"]');
            const isComplete = completionCheck && /已完成|完成|✓|✔|complete/i.test(completionCheck.innerText);

            if (isComplete && nextLink) {
                showToast('✅ 本节已完成，' + (DELAY_BEFORE_NEXT / 1000) + '秒后进入下一节...');
                hasNavigated = true;
                clearInterval(mainLoop);
                setTimeout(() => {
                    nextLink.click();
                    setTimeout(() => { window.location.href = nextLink.href; }, 1000);
                }, DELAY_BEFORE_NEXT);
            }
        }

    }, CHECK_INTERVAL);

})();
