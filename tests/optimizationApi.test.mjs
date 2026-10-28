import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../services/optimizationApi.js', import.meta.url), 'utf8');

async function loadApi({ profiles = [], presets = {}, sourceName = 'custom', models = [], status = { data: [] }, settings = {} } = {}) {
    const sent = [];
    const converted = [];
    const queried = [];
    const current = {
        chat_completion_source: sourceName, custom_url: 'https://current.invalid/v1',
        openai_max_tokens: 256, reverse_proxy: 'invalid-current-proxy', n: 5, ...settings,
    };
    const baseline = structuredClone(current);
    const context = vm.createContext({
        structuredClone, URL,
        fetch: async (url, request) => {
            queried.push({ url, payload: JSON.parse(request.body) });
            return { ok: true, json: async () => status };
        },
    });
    const modules = new Map();
    async function stub(name, exports) {
        if (!modules.has(name)) {
            const module = new vm.SyntheticModule(Object.keys(exports), function () {
                for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
            }, { context });
            modules.set(name, module);
            await module.link(() => {});
            await module.evaluate();
        }
        return modules.get(name);
    }
    const hosts = {
        '/scripts/openai.js': {
            oai_settings: current, proxies: [], model_list: models,
            settingsToUpdate: {
                max_tokens: ['', 'openai_max_tokens'],
                custom_include_headers: ['', 'custom_include_headers'],
            },
            getChatCompletionModel: () => 'current-model',
            createGenerationParameters: async (value, model) => {
                converted.push({ settings: structuredClone(value), model });
                // Simulate a host converter that has already removed n and selected a token field.
                return { generate_data: {
                    model, chat_completion_source: value.chat_completion_source,
                    max_completion_tokens: value.openai_max_tokens,
                    stream: true, stop: ['global-chat-stop'],
                } };
            },
        },
        '/scripts/custom-request.js': {
            ChatCompletionService: { sendRequest: async payload => {
                sent.push(structuredClone(payload));
                return { choices: [{ finish_reason: 'stop', message: { content: 'complete' } }] };
            } },
        },
        '/scripts/extensions/shared.js': {
            ConnectionManagerRequestService: {
                getProfile: id => profiles.find(profile => profile.id === id),
                validateProfile: profile => ({ selected: 'openai', source: profile.api }),
            },
        },
        '/script.js': {
            main_api: 'openai',
            getRequestHeaders: () => ({}),
            substituteParams: value => value,
            extractMessageFromData: data => data.choices[0].message.content,
        },
        '/scripts/preset-manager.js': {
            getPresetManager: () => ({ getCompletionPresetByName: name => presets[name] }),
        },
    };
    const module = new vm.SourceTextModule(source, {
        context,
        importModuleDynamically: name => stub(name, hosts[name]),
    });
    await module.link(name => stub(name, {
        USER: { getContext: () => ({
            extensionSettings: { disabledExtensions: [], connectionManager: { profiles } },
        }) },
    }));
    await module.evaluate();
    return { api: module.namespace, sent, converted, queried, current, baseline };
}

test('saved connection budget is applied before conversion and model-specific fields stay filtered', async () => {
    const host = await loadApi({
        profiles: [{ id: 'saved', api: 'openai', model: 'o3', preset: 'reasoning', 'secret-id': 'saved-secret' }],
        presets: { reasoning: { max_tokens: 8192 } },
    });
    await host.api.requestTableOptimization([], { connectionId: 'saved', maxTokens: 4096 });
    assert.equal(host.converted[0].settings.openai_max_tokens, 4096);
    assert.equal(host.converted[0].settings.n, 1);
    assert.equal(host.converted[0].settings.reverse_proxy, '');
    assert.equal(host.sent[0].max_completion_tokens, 4096);
    assert.equal(host.sent[0].secret_id, 'saved-secret');
    for (const field of ['max_tokens', 'n', 'stop', 'reverse_proxy']) assert.equal(field in host.sent[0], false);
    assert.equal(host.sent[0].stream, false);
    await host.api.requestTableOptimization([], { connectionId: 'saved' });
    assert.equal(host.sent[1].max_completion_tokens, 8192);
    assert.deepEqual(host.current, host.baseline);
});

test('model-list requests retain the selected source region and custom headers', async () => {
    const host = await loadApi({
        profiles: [
            { id: 'regional', api: 'siliconflow', model: 'regional-model', 'api-url': 'cn' },
            { id: 'custom', api: 'custom', model: 'custom-model', preset: 'headers', 'api-url': 'https://saved.invalid/v1' },
        ],
        presets: { headers: { custom_include_headers: 'X-Test: synthetic' } },
        status: { data: [{ id: 'chat-model' }] },
    });
    await host.api.refreshOptimizationModels('regional');
    await host.api.refreshOptimizationModels('custom');
    assert.equal(host.queried[0].payload.siliconflow_endpoint, 'cn');
    assert.equal(host.queried[1].payload.custom_url, 'https://saved.invalid/v1');
    assert.equal(host.queried[1].payload.custom_include_headers, 'X-Test: synthetic');
    assert.equal('reverse_proxy' in host.queried[1].payload, false);
});

test('Cohere model names are supported and profile caches stay isolated', async () => {
    const host = await loadApi({
        profiles: [
            { id: 'first', api: 'cohere', model: 'first-configured' },
            { id: 'second', api: 'cohere', model: 'second-configured' },
        ],
        status: { models: [{ name: 'command-chat', endpoints: ['chat'] }, { name: 'embed-model', endpoints: ['embed'] }] },
    });
    assert.deepEqual([...await host.api.refreshOptimizationModels('first')], ['command-chat']);
    assert.deepEqual([...await host.api.getOptimizationModels('second')], ['second-configured']);
    assert.deepEqual([...await host.api.getOptimizationModels('first')], ['first-configured', 'command-chat']);
});

test('Mistral candidates must support chat completions', async () => {
    const host = await loadApi({
        sourceName: 'mistralai',
        models: [
            { id: 'chat-model', capabilities: { completion_chat: true } },
            { id: 'embed-model', capabilities: { completion_chat: false } },
        ],
    });
    assert.deepEqual([...await host.api.getOptimizationModels('current')], ['current-model', 'chat-model']);
});
