import { USER } from '../core/manager.js';

let hostModules;
const modelCache = new Map();

// Keep this aligned with createGenerationParameters(). Unsupported sources ignore stale proxies.
const proxySources = new Set([
    'claude', 'openai', 'mistralai', 'makersuite', 'vertexai',
    'deepseek', 'xai', 'zai', 'moonshot',
]);
const apiUrlFields = {
    custom: 'custom_url',
    vertexai: 'vertexai_region',
    zai: 'zai_endpoint',
    siliconflow: 'siliconflow_endpoint',
    minimax: 'minimax_endpoint',
    pollinations: 'pollinations_endpoint',
};
const endpointDefaults = {
    zai: 'common', siliconflow: 'global', minimax: 'global', pollinations: 'authenticated',
};
const statusFields = {
    custom: ['custom_url', 'custom_include_headers'],
    azure_openai: ['azure_base_url', 'azure_deployment_name', 'azure_api_version'],
    workers_ai: ['workers_ai_account_id'],
    siliconflow: ['siliconflow_endpoint'],
    pollinations: ['pollinations_endpoint'],
};
const manualModelSources = new Set(['claude', 'ai21', 'vertexai', 'perplexity', 'zai', 'minimax', 'cometapi']);

async function getHost() {
    hostModules ??= Promise.all([
        import('/scripts/openai.js'),
        import('/scripts/custom-request.js'),
        import('/scripts/extensions/shared.js'),
        import('/script.js'),
        import('/scripts/preset-manager.js'),
    ]).then(([openai, requests, shared, script, presets]) => ({ openai, requests, shared, script, presets }));
    return hostModules;
}

async function resolveConnection(connectionId = 'current') {
    const host = await getHost();
    const { openai, shared, presets } = host;
    const settings = structuredClone(openai.oai_settings);
    let profile;
    if (connectionId !== 'current') {
        if (USER.getContext().extensionSettings?.disabledExtensions?.includes('connection-manager')) {
            throw new Error('连接管理器已禁用，请使用当前聊天补全连接。');
        }
        profile = shared.ConnectionManagerRequestService.getProfile(connectionId);
        const mapping = shared.ConnectionManagerRequestService.validateProfile(profile);
        if (mapping.selected !== 'openai' || !mapping.source) {
            throw new Error('请选择聊天补全连接。');
        }
        if (profile.preset) {
            const preset = presets.getPresetManager('openai')?.getCompletionPresetByName(profile.preset);
            if (!preset || typeof preset !== 'object') {
                throw new Error('所选连接的聊天补全预设不存在，请重新选择预设。');
            }
            const copy = structuredClone(preset);
            // Match the native preset adapter without modifying the stored preset.
            copy.bias_preset_selected = copy.bias_presets !== undefined ? copy.bias_preset_selected : undefined;
            for (const [key, value] of Object.entries(copy)) {
                const field = openai.settingsToUpdate[key]?.[1];
                if (field) settings[field] = value;
            }
        }
        settings.chat_completion_source = mapping.source;
        const urlField = apiUrlFields[mapping.source];
        if (urlField && profile['api-url']) settings[urlField] = profile['api-url'];
        if (profile['prompt-post-processing'] !== undefined) {
            settings.custom_prompt_post_processing = profile['prompt-post-processing'];
        }

        // A saved profile without an explicitly selected proxy always uses a direct connection.
        settings.reverse_proxy = '';
        settings.proxy_password = '';
        if (profile.proxy && proxySources.has(mapping.source)) {
            const proxy = openai.proxies.find(item => item.name === profile.proxy);
            if (!proxy) throw new Error('所选连接的代理预设不存在，请重新选择代理。');
            settings.reverse_proxy = proxy.url || '';
            settings.proxy_password = proxy.password || '';
        }
    }
    const source = settings.chat_completion_source;
    if (endpointDefaults[source]) settings[apiUrlFields[source]] ||= endpointDefaults[source];
    const model = profile?.model || openai.getChatCompletionModel(settings) || '';
    const proxy = proxySources.has(source) && settings.reverse_proxy
        ? { url: settings.reverse_proxy, password: settings.proxy_password || '' } : null;
    const connection = {
        id: connectionId, name: profile ? profile.name || '未命名连接' : '当前连接',
        source, settings, model, proxy, secretId: profile?.['secret-id'], host,
    };
    // The cache belongs to a profile ID; invalidate it if that profile's routing changes.
    connection.cacheKey = JSON.stringify([
        source, model, connection.secretId, proxy,
        ...(statusFields[source] || []).map(field => settings[field]),
    ]);
    return connection;
}

function displayEndpoint(connection) {
    const { source, settings, proxy } = connection;
    const value = proxy?.url || (source === 'custom' ? settings.custom_url
        : source === 'azure_openai' ? settings.azure_base_url : '');
    if (value) {
        try {
            const url = new URL(value);
            if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
            // Paths, credentials, query strings and fragments can contain secrets.
            return `${source} · ${proxy ? '代理 ' : ''}${url.host}`;
        } catch {
            return `${source} · 端点无效`;
        }
    }
    if (endpointDefaults[source]) {
        const endpoint = settings[apiUrlFields[source]];
        const allowed = {
            zai: ['common', 'coding'], siliconflow: ['cn', 'global'],
            minimax: ['cn', 'global'], pollinations: ['authenticated', 'anonymous'],
        };
        return `${source} · ${allowed[source].includes(endpoint) ? endpoint : '端点无效'}`;
    }
    if (source === 'vertexai') return `${source} · ${settings.vertexai_auth_mode === 'express' ? 'Express' : '区域端点'}`;
    if (source === 'workers_ai') return `${source} · ${settings.workers_ai_account_id ? '账户已配置' : '账户未配置'}`;
    if (source === 'custom' || source === 'azure_openai') return `${source} · 未配置端点`;
    return `${source} · 默认端点`;
}

function validateProxy(connection) {
    if (!connection.proxy) return null;
    try {
        const url = new URL(connection.proxy.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
        throw new Error('所选连接的代理地址无效，请填写 HTTP 或 HTTPS 地址。');
    }
    return connection.proxy;
}

function applyRouting(payload, connection, proxy) {
    if (connection.id !== 'current' && connection.secretId !== undefined) {
        payload.secret_id = connection.secretId;
    }
    if (proxy) {
        payload.reverse_proxy = proxy.url;
        payload.proxy_password = proxy.password;
    }
    return payload;
}

function modelId(model, source) {
    return typeof model === 'string' ? model : source === 'cohere' ? model?.name || model?.id : model?.id;
}

function isChatModel(model, source) {
    const id = modelId(model, source);
    if (typeof id !== 'string' || !id.trim()) return false;
    if (/(^|[/_.-])(embed(?:ding)?s?|rerank(?:er)?)([/_.-]|$)/i.test(id)) return false;
    if (model?.kind === 'EMBEDDING_MODEL') return false;
    if (source === 'mistralai') return model?.capabilities?.completion_chat === true;
    if (source === 'aimlapi') return model?.type === 'chat-completion';
    if (source === 'electronhub') return model?.endpoints?.includes('/v1/chat/completions') === true;
    if (source === 'cohere' && Array.isArray(model?.endpoints)) return model.endpoints.includes('chat');
    if (source === 'chutes') return !id.toLowerCase().includes('affine');
    return true;
}

export async function getOptimizationConnections() {
    const current = await resolveConnection();
    const connections = [current];
    const context = USER.getContext();
    if (!context.extensionSettings?.disabledExtensions?.includes('connection-manager')) {
        for (const profile of context.extensionSettings?.connectionManager?.profiles ?? []) {
            try {
                connections.push(await resolveConnection(profile.id));
            } catch {
                // Ignore unsupported API modes and profiles whose presets no longer exist.
            }
        }
    }
    return connections.map(connection => ({
        id: connection.id,
        name: connection.name,
        source: connection.source,
        model: connection.model,
        endpoint: displayEndpoint(connection),
        available: connection.id !== 'current' || current.host.script.main_api === 'openai',
    }));
}

export async function getOptimizationModels(connectionId = 'current') {
    const connection = await resolveConnection(connectionId);
    const cached = modelCache.get(connection.id);
    const rows = cached?.key === connection.cacheKey ? cached.rows
        : connection.id === 'current' && connection.host.script.main_api === 'openai'
            ? connection.host.openai.model_list : [];
    const models = rows.filter(model => isChatModel(model, connection.source))
        .map(model => modelId(model, connection.source));
    // Preserve a configured/manual model, but never reinsert a model explicitly rejected by its metadata.
    const knownModel = rows.some(model => modelId(model, connection.source) === connection.model);
    if (!knownModel && isChatModel(connection.model, 'manual')) models.unshift(connection.model);
    return [...new Set(models)];
}

export async function refreshOptimizationModels(connectionId = 'current', signal) {
    const connection = await resolveConnection(connectionId);
    if (manualModelSources.has(connection.source)) {
        throw new Error('所选来源不支持此模型列表接口，可直接填写模型名称。');
    }
    const proxy = validateProxy(connection);
    const payload = { chat_completion_source: connection.source };
    for (const field of statusFields[connection.source] || []) {
        payload[field] = field === 'custom_include_headers'
            ? connection.host.script.substituteParams(connection.settings[field] || '') : connection.settings[field];
    }
    applyRouting(payload, connection, proxy);
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: connection.host.script.getRequestHeaders(),
        body: JSON.stringify(payload),
        signal,
    });
    const data = await response.json();
    if (!response.ok || data?.error) throw new Error('无法获取模型列表，可直接填写模型名称。');
    const rows = connection.source === 'cohere' ? data?.models ?? data?.data : data?.data;
    const models = Array.isArray(rows) ? rows.filter(model => isChatModel(model, connection.source))
        .map(model => modelId(model, connection.source)) : [];
    if (!models.length) throw new Error('该端点没有返回可用的聊天模型列表，可直接填写模型名称。');
    modelCache.set(connection.id, { key: connection.cacheKey, rows: structuredClone(rows) });
    return [...new Set(models)];
}

export async function requestTableOptimization(messages, options = {}, signal) {
    const connection = await resolveConnection(options.connectionId || 'current');
    const { openai, requests, script } = connection.host;
    if (connection.id === 'current' && script.main_api !== 'openai') {
        throw new Error('当前不是聊天补全连接，请选择一个已保存的聊天补全连接。');
    }
    const proxy = validateProxy(connection);
    const settings = connection.settings;
    const budget = Number(options.maxTokens ?? settings.openai_max_tokens);
    if (!Number.isSafeInteger(budget) || budget <= 0) {
        throw new Error('输出预算必须为正整数。');
    }
    settings.openai_max_tokens = budget;
    settings.stream_openai = false;
    settings.n = 1;
    // The native proxy validator reads global settings and may change the main connection's status.
    settings.reverse_proxy = '';
    settings.proxy_password = '';
    const { generate_data: payload } = await openai.createGenerationParameters(
        settings, options.model || connection.model, 'quiet', structuredClone(messages),
    );
    // Global chat stop strings can truncate the JSON result; keep native token and n filtering.
    delete payload.stop;
    payload.stream = false;
    applyRouting(payload, connection, proxy);
    const response = await requests.ChatCompletionService.sendRequest(payload, false, signal);
    const finishReason = response?.choices?.[0]?.finish_reason
        ?? response?.stop_reason ?? response?.candidates?.[0]?.finishReason;
    if (['length', 'max_tokens', 'MAX_TOKENS'].includes(finishReason)) {
        throw new Error('模型输出已达到上限，结果未应用。请在高级设置中增加输出预算，或更换模型。');
    }
    const text = script.extractMessageFromData(response, 'openai');
    if (!text?.trim()) throw new Error('模型未返回可用的优化结果，请检查连接和模型。');
    return text;
}
