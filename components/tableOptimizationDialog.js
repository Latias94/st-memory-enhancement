import {
    OPTIMIZATION_STRATEGIES,
    buildOptimizationPlan,
    countTableCharacters,
    getOptimizationStrategy,
    isArchiveTable,
    isHistoryTable,
    recommendOptimizationStrategy,
} from '../utils/tableOptimization.mjs';

const number = value => Number(value).toLocaleString();

export function createTableOptimizationDialog({ tables, connections, options, hasBackup, onRun, onApply, onUndo, onModels, onChange }) {
    const element = document.createElement('section');
    element.className = 'memory-optimizer';
    element.innerHTML = `
        <header class="memory-optimizer-heading">
            <span class="memory-optimizer-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></span>
            <div><h2>表格优化</h2><p>归并旧事件，保留近期细节。</p></div>
            <span class="memory-optimizer-badge">保留原始记录</span>
        </header>
        <div class="memory-optimizer-overview">
            <div class="memory-optimizer-size"><span>当前记忆</span><strong data-field="characters"></strong><small data-field="table-count"></small></div>
            <div class="memory-optimizer-recommendation"><strong data-field="strategy-title"></strong><p data-field="recommendation"></p><small data-field="recommendation-reason"></small></div>
        </div>
        <div class="memory-optimizer-strategy">
            <label>总结策略<select class="text_pole" name="strategy" data-lock aria-label="总结策略"></select></label>
            <p data-field="strategy-description"></p>
        </div>
        <div class="memory-optimizer-connection">
            <i class="fa-solid fa-plug"></i><div><strong data-field="connection-name"></strong><small data-field="connection-detail"></small></div>
            <button type="button" class="memory-optimizer-link" data-action="connection">更换连接 / 模型</button>
        </div>
        <details class="memory-optimizer-section" data-panel="settings">
            <summary><span><i class="fa-solid fa-sliders"></i> 连接与处理范围</span><small>按需调整</small></summary>
            <div class="memory-optimizer-section-body">
                <div class="memory-optimizer-fields">
                    <label>API 连接<select class="text_pole" name="connection" data-lock></select></label>
                    <label>模型<div class="memory-optimizer-model"><input class="text_pole" name="model" list="memory-optimizer-models" placeholder="跟随所选连接" data-lock><button type="button" class="menu_button" data-action="models" data-lock title="从所选端点读取模型列表" aria-label="刷新模型列表"><i class="fa-solid fa-rotate"></i></button></div><datalist id="memory-optimizer-models"></datalist></label>
                    <label>保留近期事件行数<input class="text_pole" type="number" name="keepRecent" min="0" step="1" data-lock><small>留空跟随策略；填写后覆盖策略的默认行数。</small></label>
                    <label>单次输出预算（token）<input class="text_pole" type="number" name="maxTokens" min="256" step="256" placeholder="跟随连接设置" data-lock><small>达到输出上限时会停止，原表格保持完整。</small></label>
                </div>
                <label class="memory-optimizer-archive-option"><input type="checkbox" name="compactArchives" data-lock><span>同时归并已有摘要<small>摘要再次积累较多时使用；同样提供来源对照和撤销。</small></span></label>
                <fieldset class="memory-optimizer-tables"><legend>处理哪些表格</legend><div data-field="table-options"></div><small>历史表归并旧事件；其他选中表只清理完全相同的行。当前状态、日程和数值不交给模型重写。</small></fieldset>
            </div>
        </details>
        <details class="memory-optimizer-section" data-panel="prompt">
            <summary><span><i class="fa-solid fa-align-left"></i> 优化提示词</span><small data-field="prompt-label">内置推荐 · 可查看编辑</small></summary>
            <div class="memory-optimizer-section-body">
                <p class="memory-optimizer-help">保留时间线、因果、人物关系和未解线索。目标表的列和来源行会自动附在请求中。</p>
                <textarea class="text_pole" name="prompt" rows="12" spellcheck="false" aria-label="优化提示词" data-lock></textarea>
                <button type="button" class="memory-optimizer-link" data-action="reset-prompt" data-lock>恢复此策略的提示词</button>
            </div>
        </details>
        <div class="memory-optimizer-status" role="status" aria-live="polite" hidden></div>
        <div class="memory-optimizer-result" hidden></div>
        <footer class="memory-optimizer-footer">
            <div class="memory-optimizer-footer-note"><i class="fa-solid fa-clock-rotate-left"></i><span>应用后可撤销上一次优化</span></div>
            <div class="memory-optimizer-actions">
                <button type="button" class="memory-optimizer-link" data-action="undo" data-lock ${hasBackup ? '' : 'hidden'}>撤销上次优化</button>
                <button type="button" class="menu_button" data-action="preview" data-lock>先预览</button>
                <button type="button" class="menu_button memory-optimizer-primary" data-action="run" data-lock><i class="fa-solid fa-wand-magic-sparkles"></i> 一键优化</button>
                <button type="button" class="menu_button" data-action="cancel" hidden>停止生成</button>
            </div>
        </footer>`;
    const query = selector => element.querySelector(selector);
    element.querySelectorAll('i').forEach(icon => icon.setAttribute('aria-hidden', 'true'));
    const field = name => query(`[data-field="${name}"]`);
    const action = name => query(`[data-action="${name}"]`);
    const control = name => query(`[name="${name}"]`);
    const status = query('.memory-optimizer-status');
    const resultPanel = query('.memory-optimizer-result');
    let modelRequest;
    let connectionRevision = 0;
    let pendingResult = null;
    let completed = false;
    const recommendation = recommendOptimizationStrategy(tables);
    const customPrompts = { ...options.prompts };
    control('strategy').append(new Option('自动推荐', 'auto'));
    for (const strategy of OPTIMIZATION_STRATEGIES) control('strategy').append(new Option(strategy.name, strategy.id));
    control('strategy').value = ['auto', ...OPTIMIZATION_STRATEGIES.map(strategy => strategy.id)].includes(options.strategyId)
        ? options.strategyId : 'auto';
    let activeStrategy = getOptimizationStrategy(control('strategy').value, tables);
    if (options.prompt && options.prompt !== activeStrategy.prompt) customPrompts[activeStrategy.id] ??= options.prompt;

    for (const connection of connections) {
        const option = new Option(connection.name, connection.id);
        option.disabled = !connection.available;
        control('connection').append(option);
    }
    control('connection').value = connections.some(item => item.id === options.connectionId && item.available)
        ? options.connectionId : connections.find(item => item.available)?.id ?? 'current';
    control('model').value = options.model || '';
    control('keepRecent').value = options.keepRecent ?? '';
    control('compactArchives').checked = options.compactArchives ?? recommendation.compactArchives;
    control('maxTokens').value = options.maxTokens || '';
    control('prompt').value = customPrompts[activeStrategy.id] || activeStrategy.prompt;
    field('characters').textContent = `${number(countTableCharacters(tables))} 字符`;
    field('table-count').textContent = `${tables.length} 张表 · ${number(tables.reduce((sum, table) => sum + table.content.length, 0))} 行数据`;

    for (const table of tables) {
        const label = document.createElement('label');
        label.className = 'memory-optimizer-table';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.tableUid = table.uid;
        checkbox.dataset.lock = '';
        checkbox.checked = !isArchiveTable(table) && (options.tableUids === null || options.tableUids === undefined || options.tableUids.includes(table.uid));
        checkbox.disabled = isArchiveTable(table) || !table.content.length;
        checkbox.dataset.unavailable = String(checkbox.disabled);
        const name = document.createElement('span');
        name.textContent = table.name;
        const info = document.createElement('small');
        info.textContent = `${table.content.length} 行 · ${isArchiveTable(table) ? '接收阶段摘要' : isHistoryTable(table) ? '归并旧事件' : '仅去重'}`;
        label.append(checkbox, name, info);
        field('table-options').append(label);
    }

    function getOptions() {
        const maxTokens = control('maxTokens').value ? Number(control('maxTokens').value) : null;
        if (maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens < 256)) {
            throw new Error('输出预算必须是至少 256 的整数，留空则跟随连接。');
        }
        const prompt = control('prompt').value.trim();
        if (!prompt) throw new Error('优化提示词不能为空。');
        if (prompt === activeStrategy.prompt.trim()) delete customPrompts[activeStrategy.id];
        else customPrompts[activeStrategy.id] = prompt;
        return {
            strategyId: control('strategy').value,
            connectionId: control('connection').value,
            model: control('model').value.trim(),
            keepRecent: control('keepRecent').value === '' ? undefined : Number(control('keepRecent').value),
            compactArchives: control('compactArchives').checked,
            maxTokens,
            prompt,
            prompts: { ...customPrompts },
            tableUids: [...element.querySelectorAll('[data-table-uid]:checked')].map(item => item.dataset.tableUid),
        };
    }

    function updateRecommendation() {
        try {
            const plan = buildOptimizationPlan(tables, getOptions());
            const oldRows = plan.jobs.reduce((sum, job) => sum + job.rows.length, 0);
            field('strategy-title').textContent = `${control('strategy').value === 'auto' ? '推荐：' : '已选：'}${activeStrategy.name}`;
            field('strategy-description').textContent = activeStrategy.description;
            field('recommendation-reason').textContent = recommendation.reason;
            control('keepRecent').placeholder = `跟随策略（${activeStrategy.keepRecent} 行）`;
            field('recommendation').textContent = oldRows
                ? `归并 ${oldRows} 条旧记录，保留 ${plan.protectedRows} 条近期明细${plan.duplicatesRemoved ? `，清理 ${plan.duplicatesRemoved} 条完全重复记录` : ''}。`
                : plan.duplicatesRemoved ? `清理 ${plan.duplicatesRemoved} 条完全重复记录，无需请求模型。`
                    : '当前表格较精简，暂无需要归并的旧事件或重复记录。';
            const unavailable = completed || (!oldRows && !plan.duplicatesRemoved);
            action('run').disabled = unavailable;
            action('preview').disabled = unavailable;
        } catch (error) {
            field('recommendation').textContent = error.message;
            action('run').disabled = true;
            action('preview').disabled = true;
        }
        field('prompt-label').textContent = control('prompt').value.trim() === activeStrategy.prompt.trim()
            ? `${activeStrategy.name} · 内置提示词` : `${activeStrategy.name} · 已自定义`;
    }

    async function updateConnection() {
        const revision = ++connectionRevision;
        const connection = connections.find(item => item.id === control('connection').value);
        field('connection-name').textContent = connection?.name || '请选择连接';
        field('connection-detail').textContent = `${control('model').value.trim() || connection?.model || '尚未选择模型'} · ${connection?.endpoint || ''}`;
        control('model').placeholder = connection?.model || '填写模型名称';
        try {
            const models = await onModels(control('connection').value, false);
            if (revision === connectionRevision) setModels(models);
        } catch {
            if (revision === connectionRevision) setModels([]);
        }
    }

    function setModels(models) {
        const list = query('datalist');
        list.replaceChildren(...models.map(model => new Option(model, model)));
    }

    function setStatus(message, isError = false) {
        status.hidden = !message;
        status.textContent = message;
        status.classList.toggle('is-error', isError);
    }

    function changed() {
        pendingResult = null;
        resultPanel.hidden = true;
        updateRecommendation();
        try {
            onChange(getOptions());
        } catch {
            // Incomplete input is kept in the editor until it is valid.
        }
    }

    element.addEventListener('input', event => {
        if (event.target === control('strategy') || event.target === control('connection')) return;
        changed();
        if (event.target === control('model')) void updateConnection();
    });
    control('strategy').addEventListener('change', () => {
        activeStrategy = getOptimizationStrategy(control('strategy').value, tables);
        control('prompt').value = customPrompts[activeStrategy.id] || activeStrategy.prompt;
        changed();
    });
    control('connection').addEventListener('change', () => {
        modelRequest?.abort();
        control('model').value = '';
        changed();
        void updateConnection();
    });
    element.addEventListener('change', event => {
        if (event.target.matches('[data-table-uid]')) changed();
    });
    action('connection').addEventListener('click', () => {
        query('[data-panel="settings"]').open = true;
        control('connection').focus();
    });
    action('reset-prompt').addEventListener('click', () => {
        control('prompt').value = activeStrategy.prompt;
        changed();
    });
    action('run').addEventListener('click', () => onRun(false));
    action('preview').addEventListener('click', () => onRun(true));
    action('undo').addEventListener('click', onUndo);
    action('models').addEventListener('click', async () => {
        modelRequest?.abort();
        const request = modelRequest = new AbortController();
        const connectionId = control('connection').value;
        action('models').disabled = true;
        try {
            const models = await onModels(connectionId, true, request.signal);
            if (request.signal.aborted || connectionId !== control('connection').value) return;
            connectionRevision++;
            setModels(models);
            setStatus('模型列表已更新，可以选择或直接填写模型名称。');
            control('model').focus();
        } catch (error) {
            if (error.name !== 'AbortError') setStatus(error.message, true);
        } finally {
            if (request === modelRequest) action('models').disabled = element.getAttribute('aria-busy') === 'true';
        }
    });
    updateRecommendation();
    void updateConnection();

    return {
        element,
        getOptions,
        setStatus,
        onCancel(handler) { action('cancel').onclick = handler; },
        dispose() { modelRequest?.abort(); connectionRevision++; },
        setCompleted(value) {
            completed = value;
            updateRecommendation();
        },
        setBusy(busy) {
            element.setAttribute('aria-busy', String(busy));
            element.querySelectorAll('[data-lock]').forEach(item => {
                item.disabled = busy || item.dataset.unavailable === 'true';
            });
            action('cancel').hidden = !busy;
            action('run').hidden = busy;
            action('preview').hidden = busy;
            if (!busy) updateRecommendation();
        },
        setBackupAvailable(available) { action('undo').hidden = !available; },
        showResult(result, applied) {
            pendingResult = result;
            resultPanel.replaceChildren();
            resultPanel.hidden = false;
            const heading = document.createElement('h3');
            const reduction = result.beforeCharacters - result.afterCharacters;
            const percentage = result.beforeCharacters ? Math.round(reduction / result.beforeCharacters * 100) : 0;
            heading.textContent = `${applied ? '优化已应用' : '优化预览'} · ${reduction >= 0 ? `减少 ${number(reduction)} 字符（${percentage}%）` : `增加 ${number(-reduction)} 字符`}`;
            resultPanel.append(heading);
            if (result.sourceCharacters) {
                const note = document.createElement('p');
                note.className = 'memory-optimizer-help';
                note.textContent = `旧记录 ${number(result.sourceCharacters)} → ${number(result.summaryCharacters)} 字符；近期明细与其他资料仍占上下文。字符数用于比较体积，不等同于 token。`;
                resultPanel.append(note);
            }
            if (result.provenance.length) {
                const sourceDetails = document.createElement('details');
                const sourceTitle = document.createElement('summary');
                sourceTitle.textContent = '逐段查看：哪些原始记录归并成了这条摘要';
                sourceDetails.append(sourceTitle);
                for (const entry of result.provenance) {
                    const source = tables.find(table => table.uid === entry.sourceUid);
                    const rowsById = new Map(source.content.map((row, index) => [source.rowIds?.[index] ?? `${source.uid}:${index}`, row]));
                    for (const summary of entry.summaries) {
                        const details = document.createElement('details');
                        const title = document.createElement('summary');
                        title.textContent = `${summary.values[0].slice(0, 80)} · ${summary.sourceRows.length} 条 → 1 条`;
                        const beforeRows = summary.sourceRows.map(id => rowsById.get(id));
                        details.append(title, comparison(beforeRows, [summary.values]));
                        sourceDetails.append(details);
                    }
                }
                resultPanel.append(sourceDetails);
            }
            for (const table of result.changed) {
                const before = tables.find(item => item.uid === table.uid);
                const details = document.createElement('details');
                const summary = document.createElement('summary');
                summary.textContent = `${table.name} · ${before.content.length} 行 → ${table.content.length} 行`;
                details.append(summary, comparison(before.content, table.content));
                resultPanel.append(details);
            }
            if (!applied && result.changed.length) {
                const apply = document.createElement('button');
                apply.type = 'button';
                apply.className = 'menu_button memory-optimizer-primary';
                apply.dataset.lock = '';
                apply.textContent = '应用这次预览';
                apply.addEventListener('click', () => {
                    if (pendingResult) onApply(pendingResult);
                });
                resultPanel.append(apply);
            }
        },
    };

    function comparison(before, after) {
        const columns = document.createElement('div');
        columns.className = 'memory-optimizer-comparison';
        for (const [label, rows] of [['优化前', before], ['优化后', after]]) {
            const panel = document.createElement('div');
            const title = document.createElement('strong');
            title.textContent = label;
            const pre = document.createElement('pre');
            pre.textContent = rows.map(row => row.join(' · ')).join('\n\n') || '（空表）';
            panel.append(title, pre);
            columns.append(panel);
        }
        return columns;
    }
}
