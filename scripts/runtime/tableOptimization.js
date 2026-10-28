import { BASE, DERIVED, EDITOR, USER } from '../../core/manager.js';
import { sha256 } from '/lib.js';
import { createTableOptimizationDialog } from '../../components/tableOptimizationDialog.js';
import {
    buildOptimizationPlan,
    buildOptimizationMessages,
    finishOptimization,
    parseOptimizationResponse,
} from '../../utils/tableOptimization.mjs';
import {
    getOptimizationConnections,
    getOptimizationModels,
    refreshOptimizationModels,
    requestTableOptimization,
} from '../../services/optimizationApi.js';
import { saveOptimizationChat } from '../../services/optimizationPersistence.mjs';
import { updateSystemMessageTableStatus } from '../renderer/tablePushToChat.js';

const BACKUP_KEY = 'memory_table_optimization_backup';
let activeDialog = false;

function takeSnapshot() {
    const context = USER.getContext();
    const { piece, deep } = BASE.getLastSheetsPiece();
    if (!piece || deep < 0) throw new Error('请先进行至少一轮对话，再优化表格。');
    const sheets = context.chatMetadata.sheets.filter(sheet => sheet.enable).map(stored => {
        const sheet = new BASE.Sheet(structuredClone(stored));
        sheet.hashSheet = structuredClone(piece.hash_sheets[sheet.uid] ?? [stored.hashSheet[0]]);
        sheet.loadCells();
        return sheet;
    });
    const tables = sheets.map(sheet => ({
        uid: sheet.uid,
        name: sheet.name,
        columns: sheet.getHeader(),
        content: sheet.getContent(),
        rowIds: sheet.hashSheet.slice(1).map(row => row[0]),
    }));
    return {
        context,
        chat: context.chat,
        metadata: context.chatMetadata,
        piece,
        pieceIndex: deep,
        chatLength: context.chat.length,
        swipeId: piece.swipe_id ?? 0,
        conversationText: JSON.stringify(context.chat.map(message => [
            message.is_user, message.name, message.mes, message.swipe_id ?? 0,
        ])),
        tables,
        signature: JSON.stringify({
            tables,
            hashes: piece.hash_sheets,
            configuration: sheets.map(sheet => ({
                uid: sheet.uid, data: sheet.source.data, config: sheet.config,
            })),
        }),
    };
}

function assertUnchanged(snapshot) {
    const current = takeSnapshot();
    if (current.chat !== snapshot.chat || current.metadata !== snapshot.metadata
        || current.context.chatId !== snapshot.context.chatId || current.context.groupId !== snapshot.context.groupId
        || current.context.characterId !== snapshot.context.characterId
        || current.piece !== snapshot.piece || current.chatLength !== snapshot.chatLength
        || current.swipeId !== snapshot.swipeId || current.signature !== snapshot.signature
        || current.conversationText !== snapshot.conversationText) {
        throw new Error('对话或表格已发生变化，本次结果未应用。请关闭后重新打开表格优化。');
    }
}

function refreshViews(snapshot) {
    if (USER.getContext().chatMetadata !== snapshot.metadata) return;
    BASE.refreshContextView();
    BASE.refreshTempView(true);
    updateSystemMessageTableStatus();
}

async function waitForPendingSave(snapshot) {
    const host = await import('/script.js');
    const deadline = Date.now() + 10000;
    while (host.isChatSaving) {
        if (Date.now() >= deadline) throw new Error('聊天仍在保存，请稍后重试应用。');
        await new Promise(resolve => setTimeout(resolve, 50));
        assertUnchanged(snapshot);
    }
    assertUnchanged(snapshot);
}

async function saveStagedSheets(snapshot, staged, backup, removeHashes = []) {
    await waitForPendingSave(snapshot);
    assertUnchanged(snapshot);
    const oldSheets = snapshot.metadata.sheets;
    const oldHashes = structuredClone(snapshot.piece.hash_sheets);
    const oldBackup = snapshot.metadata[BACKUP_KEY];
    DERIVED.any.chatSheetMap ??= {};
    const oldCache = { ...DERIVED.any.chatSheetMap };
    const cachedData = new Map();
    let committedSignature;
    try {
        for (const sheet of staged) {
            let current = DERIVED.any.chatSheetMap[sheet.uid];
            if (current) {
                cachedData.set(current, current.filterSavingData());
                current.loadJson(sheet.filterSavingData());
            } else {
                current = sheet;
            }
            if (!current.save(snapshot.piece, true)) throw new Error('无法保存优化后的表格。');
            DERIVED.any.chatSheetMap[sheet.uid] = current;
        }
        for (const uid of removeHashes) delete snapshot.piece.hash_sheets[uid];
        if (backup) snapshot.metadata[BACKUP_KEY] = backup;
        else delete snapshot.metadata[BACKUP_KEY];
        committedSignature = takeSnapshot().signature;
        if (backup) backup.afterSignature = committedSignature;
        await saveOptimizationChat(snapshot.context, {
            pieceIndex: snapshot.pieceIndex,
            tableUids: staged.map(sheet => sheet.uid),
            backupKey: BACKUP_KEY,
        });
    } catch (error) {
        const context = USER.getContext();
        const current = context.chatMetadata === snapshot.metadata && context.chat === snapshot.chat ? takeSnapshot() : null;
        const ownsState = current && (!committedSignature
            || (current.signature === committedSignature && current.conversationText === snapshot.conversationText));
        if (!error.verificationUnavailable && ownsState) {
            snapshot.metadata.sheets = oldSheets;
            snapshot.piece.hash_sheets = oldHashes;
            for (const [sheet, data] of cachedData) sheet.loadJson(data);
            DERIVED.any.chatSheetMap = oldCache;
            if (oldBackup) snapshot.metadata[BACKUP_KEY] = oldBackup;
            else delete snapshot.metadata[BACKUP_KEY];
        }
        refreshViews(snapshot);
        throw error;
    }
    refreshViews(snapshot);
}

async function applyResult(snapshot, result) {
    assertUnchanged(snapshot);
    const backup = {
        version: 2,
        createdAt: new Date().toISOString(),
        pieceIndex: snapshot.pieceIndex,
        swipeId: snapshot.swipeId,
        chatLength: snapshot.chatLength,
        chatVersion: sha256(snapshot.conversationText),
        tables: [],
    };
    const staged = result.changed.map(table => {
        const stored = snapshot.metadata.sheets.find(sheet => sheet.uid === table.uid);
        const beforeHashes = snapshot.piece.hash_sheets[table.uid] ?? [stored.hashSheet[0]];
        const referenced = new Set(beforeHashes.flat());
        backup.tables.push({
            uid: table.uid,
            hashSheet: structuredClone(snapshot.piece.hash_sheets[table.uid] ?? null),
            storedHashSheet: structuredClone(stored.hashSheet),
            cells: structuredClone(stored.cellHistory.filter(cell => referenced.has(cell.uid))),
        });
        const sheet = new BASE.Sheet(structuredClone(stored));
        sheet.hashSheet = structuredClone(beforeHashes);
        sheet.rebuildHashSheetByValueSheet([
            ['', ...table.columns],
            ...table.content.map(row => ['', ...row]),
        ]);
        sheet.hashSheet[0] = [...beforeHashes[0]];
        sheet.markPositionCacheDirty();
        return sheet;
    });
    await saveStagedSheets(snapshot, staged, backup);
}

async function undoOptimization() {
    const snapshot = takeSnapshot();
    const backup = snapshot.metadata[BACKUP_KEY];
    if (!backup || backup.version !== 2) throw new Error('当前对话没有可撤销的优化。');
    if (snapshot.pieceIndex !== backup.pieceIndex || snapshot.swipeId !== backup.swipeId
        || snapshot.signature !== backup.afterSignature || snapshot.chatLength !== backup.chatLength
        || sha256(snapshot.conversationText) !== backup.chatVersion) {
        throw new Error('优化后对话或表格已有新变化，不能直接覆盖。可在表格历史中查看原记录。');
    }
    const staged = backup.tables.map(previous => {
        const stored = structuredClone(snapshot.metadata.sheets.find(sheet => sheet.uid === previous.uid));
        const cells = new Map(stored.cellHistory.map(cell => [cell.uid, cell]));
        for (const cell of previous.cells) cells.set(cell.uid, cell);
        stored.cellHistory = [...cells.values()];
        stored.hashSheet = previous.hashSheet ?? previous.storedHashSheet;
        return new BASE.Sheet(stored);
    });
    await saveStagedSheets(snapshot, staged, null, backup.tables.filter(table => table.hashSheet === null).map(table => table.uid));
}

export async function openTableOptimization() {
    if (activeDialog) return;
    activeDialog = true;
    let abortController;
    let view;
    try {
        const snapshot = takeSnapshot();
        if (!snapshot.tables.length) throw new Error('当前对话没有可优化的表格。');
        const connections = await getOptimizationConnections();
        const options = { connectionId: 'current', ...USER.tableBaseSetting.optimization_options };
        let pendingSnapshot;

        const apply = async result => {
            view.setBusy(true);
            try {
                await applyResult(pendingSnapshot, result);
                view.showResult(result, true);
                view.setBackupAvailable(true);
                view.setCompleted(true);
                view.setStatus('优化已保存。原始单元格仍然保留，可撤销本次优化。');
            } catch (error) {
                if (error.verificationUnavailable) {
                    view.setBackupAvailable(true);
                    view.setCompleted(true);
                }
                view.setStatus(error.message, true);
            } finally {
                view.setBusy(false);
            }
        };

        view = createTableOptimizationDialog({
            tables: snapshot.tables,
            connections,
            options,
            hasBackup: Boolean(snapshot.metadata[BACKUP_KEY]),
            onChange(value) {
                const preferences = { ...value };
                delete preferences.tableUids;
                delete preferences.prompt;
                USER.tableBaseSetting.optimization_options = preferences;
            },
            onModels: (id, refresh, signal) => refresh
                ? refreshOptimizationModels(id, signal) : getOptimizationModels(id),
            onApply: apply,
            async onUndo() {
                view.setBusy(true);
                try {
                    await undoOptimization();
                    view.setBackupAvailable(false);
                    view.setCompleted(true);
                    view.setStatus('已恢复优化前的表格。重新打开此窗口可再次优化。');
                } catch (error) {
                    if (error.verificationUnavailable) {
                        view.setBackupAvailable(Boolean(snapshot.metadata[BACKUP_KEY]));
                        view.setCompleted(true);
                    }
                    view.setStatus(error.message, true);
                } finally {
                    view.setBusy(false);
                }
            },
            async onRun(previewOnly) {
                view.setBusy(true);
                abortController = new AbortController();
                view.onCancel(() => abortController.abort());
                try {
                    assertUnchanged(snapshot);
                    const settings = view.getOptions();
                    const plan = buildOptimizationPlan(snapshot.tables, settings);
                    if (!plan.jobs.length && !plan.duplicatesRemoved) {
                        view.setStatus('当前表格已经较精简，没有需要优化的内容。');
                        return;
                    }
                    const responses = [];
                    for (let index = 0; index < plan.jobs.length; index++) {
                        view.setStatus(`正在整理第 ${index + 1} / ${plan.jobs.length} 批旧记录，原表格尚未修改…`);
                        const text = await requestTableOptimization(
                            buildOptimizationMessages(plan.jobs[index], settings.prompt), settings, abortController.signal,
                        );
                        abortController.signal.throwIfAborted();
                        responses.push(parseOptimizationResponse(text, plan.jobs[index]));
                    }
                    abortController.signal.throwIfAborted();
                    assertUnchanged(snapshot);
                    const result = finishOptimization(plan, responses);
                    pendingSnapshot = snapshot;
                    if (previewOnly || result.afterCharacters >= result.beforeCharacters) {
                        view.showResult(result, false);
                        view.setStatus(result.afterCharacters >= result.beforeCharacters
                            ? '本次结果没有减少内容体积，已保留为预览，请检查后决定是否应用。'
                            : '预览已生成，原表格尚未修改。');
                    } else {
                        await apply(result);
                    }
                } catch (error) {
                    view.setStatus(error.name === 'AbortError' ? '已停止生成，原表格未修改。' : error.message, error.name !== 'AbortError');
                } finally {
                    view.setBusy(false);
                }
            },
        });
        const popup = new EDITOR.Popup(view.element, EDITOR.POPUP_TYPE.TEXT, '', {
            okButton: '关闭',
            wide: true,
            allowVerticalScrolling: true,
            onClose: () => {
                abortController?.abort();
                view.dispose();
            },
        });
        popup.dlg.classList.add('memory-optimizer-popup');
        await popup.show();
    } catch (error) {
        EDITOR.error('无法打开表格优化', error.message);
    } finally {
        abortController?.abort();
        activeDialog = false;
    }
}
