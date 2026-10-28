import assert from 'node:assert/strict';
import test from 'node:test';
import { saveOptimizationChat } from '../services/optimizationPersistence.mjs';

function fixture() {
    return {
        chatId: 'test-chat',
        characterId: 0,
        groupId: null,
        characters: [{ avatar: 'test.png' }],
        chat: [{ mes: 'Synthetic chat', hash_sheets: { history: [['head'], ['summary']] } }],
        chatMetadata: {
            sheets: [{ uid: 'history', hashSheet: [['head'], ['summary']], cellHistory: [] }],
            backup: { version: 2, createdAt: 'test-version' },
        },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        saveChat: async () => {},
    };
}

const options = { pieceIndex: 0, tableUids: ['history'], backupKey: 'backup' };
const stored = context => structuredClone([{ chat_metadata: context.chatMetadata }, ...context.chat]);

test('strict save waits for the native save and verifies the same character chat', async t => {
    const context = fixture();
    let saved = false;
    context.saveChat = async () => { await Promise.resolve(); saved = true; };
    t.mock.method(globalThis, 'fetch', async (url, request) => {
        assert.equal(saved, true);
        assert.equal(url, '/api/chats/get');
        assert.deepEqual(JSON.parse(request.body), { avatar_url: 'test.png', file_name: 'test-chat' });
        return { ok: true, json: async () => stored(context) };
    });
    await saveOptimizationChat(context, options);
});

test('group saves are verified using the group chat ID', async t => {
    const context = fixture();
    context.groupId = 'test-group';
    t.mock.method(globalThis, 'fetch', async (url, request) => {
        assert.equal(url, '/api/chats/group/get');
        assert.deepEqual(JSON.parse(request.body), { id: 'test-chat' });
        return { ok: true, json: async () => stored(context) };
    });
    await saveOptimizationChat(context, options);
});

test('a swallowed native save failure is detected by the persisted table and backup', async t => {
    const context = fixture();
    const old = stored(context);
    old[0].chat_metadata.backup = undefined;
    old[1].hash_sheets.history = [['head'], ['original']];
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => old }));
    await assert.rejects(saveOptimizationChat(context, options), error => {
        assert.equal(error.verificationUnavailable, undefined);
        return /未确认/.test(error.message);
    });
});

test('unavailable verification is distinguished from a confirmed mismatch', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Synthetic read failure'); });
    await assert.rejects(saveOptimizationChat(fixture(), options), error => {
        assert.equal(error.verificationUnavailable, true);
        return /无法确认/.test(error.message);
    });
});
