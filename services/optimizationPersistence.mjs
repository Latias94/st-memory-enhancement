export async function saveOptimizationChat(context, { pieceIndex, tableUids, backupKey }) {
    const selected = new Set(tableUids);
    const state = (metadata, piece) => JSON.stringify({
        sheets: metadata?.sheets?.filter(sheet => selected.has(sheet.uid)),
        hashes: piece?.hash_sheets,
        backup: metadata?.[backupKey],
    });
    const expected = state(context.chatMetadata, context.chat[pieceIndex]);
    const avatar = context.characters?.[context.characterId]?.avatar;
    if (!context.chatId || (!context.groupId && !avatar)) throw new Error('当前聊天尚未保存，无法确认优化结果。');
    const route = context.groupId ? '/api/chats/group/get' : '/api/chats/get';
    const body = context.groupId ? { id: context.chatId } : { avatar_url: avatar, file_name: context.chatId };

    // The host serializes saves, but older versions swallow HTTP errors.
    await context.saveChat();
    let data;
    try {
        const response = await fetch(route, {
            method: 'POST',
            headers: context.getRequestHeaders(),
            cache: 'no-store',
            body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error('Verification request failed');
        data = await response.json();
        if (!Array.isArray(data) || !data[0]?.chat_metadata) throw new Error('Verification response is incomplete');
    } catch {
        const error = new Error('无法确认保存结果，请检查服务连接。当前内存状态已保留，请恢复连接后核对。');
        error.verificationUnavailable = true;
        throw error;
    }
    if (state(data[0].chat_metadata, data[pieceIndex + 1]) !== expected) {
        throw new Error('服务器中未确认本次表格变更，保存未完成。');
    }
}
