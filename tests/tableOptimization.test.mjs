import assert from 'node:assert/strict';
import test from 'node:test';
import {
    OPTIMIZATION_STRATEGIES,
    buildOptimizationPlan,
    buildOptimizationMessages,
    parseOptimizationResponse,
    finishOptimization,
    recommendOptimizationStrategy,
} from '../utils/tableOptimization.mjs';

const history = (count = 24) => ({
    uid: 'history',
    name: '事件历史',
    columns: ['时间', '地点', '事件'],
    content: Array.from({ length: count }, (_, index) => [`day-${index}`, 'town', `event-${index}`]),
    rowIds: Array.from({ length: count }, (_, index) => `row-${index}`),
});
const archive = () => ({
    uid: 'archive',
    name: '大总结',
    columns: ['时间范围', '内容'],
    content: [['day-before', 'An earlier summary']],
    rowIds: ['earlier-summary'],
});
const characters = () => ({
    uid: 'characters',
    name: '角色信息',
    columns: ['角色名', '关系', '数量'],
    content: [['A', 'friend', '10'], ['A', 'friend', '10'], ['B', 'ally', '20']],
    rowIds: ['a', 'a-duplicate', 'b'],
});

test('recommended optimization preserves recent events and existing summaries', () => {
    const plan = buildOptimizationPlan([history(), archive(), characters()], { keepRecent: 20 });
    assert.equal(plan.jobs.length, 1);
    assert.equal(plan.jobs[0].targetUid, 'archive');
    assert.deepEqual(plan.jobs[0].rows.map(row => row.id), ['row-0', 'row-1', 'row-2', 'row-3']);
    assert.equal(plan.duplicatesRemoved, 1);
    const result = finishOptimization(plan, [{
        summaries: [{ sourceRows: ['row-0', 'row-1', 'row-2', 'row-3'], values: ['day-0–day-3', 'A complete event'] }],
    }]);
    assert.deepEqual(result.tables.find(t => t.uid === 'history').content, history().content.slice(4));
    assert.deepEqual(result.tables.find(t => t.uid === 'archive').content, [
        ['day-before', 'An earlier summary'],
        ['day-0–day-3', 'A complete event'],
    ]);
    assert.deepEqual(result.tables.find(t => t.uid === 'characters').content, [
        ['A', 'friend', '10'], ['B', 'ally', '20'],
    ]);
});

test('without an archive, history is compacted using its actual columns', () => {
    const plan = buildOptimizationPlan([history()], { keepRecent: 20 });
    assert.equal(plan.jobs[0].targetUid, 'history');
    assert.deepEqual(plan.jobs[0].columns, ['时间', '地点', '事件']);
    const result = finishOptimization(plan, [{
        summaries: [{ sourceRows: ['row-0', 'row-1', 'row-2', 'row-3'], values: ['day-0–day-3', 'town', 'A complete event'] }],
    }]);
    assert.equal(result.tables[0].content.length, 21);
    assert.deepEqual(result.tables[0].content.slice(1), history().content.slice(4));
});

test('manual selection leaves unselected tables unchanged', () => {
    const tables = [history(), archive(), characters()];
    const plan = buildOptimizationPlan(tables, { tableUids: ['characters'] });
    assert.equal(plan.jobs.length, 0);
    const result = finishOptimization(plan, []);
    assert.deepEqual(result.tables.find(t => t.uid === 'history').content, tables[0].content);
    assert.deepEqual(result.tables.find(t => t.uid === 'archive').content, tables[1].content);
});

test('history batches retain stable row IDs and chronological order', () => {
    const plan = buildOptimizationPlan([history(85)], { keepRecent: 20 });
    assert.equal(plan.jobs.length, 3);
    assert.deepEqual(plan.jobs.map(job => job.rows.length), [30, 30, 5]);
    assert.equal(plan.jobs[2].rows[4].id, 'row-64');
});

test('strict parsing rejects truncated output instead of accepting an inner array', () => {
    const plan = buildOptimizationPlan([history()], { keepRecent: 20 });
    assert.throws(() => parseOptimizationResponse('{"summaries":[{"sourceRows":["row-0"],"values":[["nested"]]', plan.jobs[0]));
    assert.throws(() => parseOptimizationResponse('[["not a response"]]', plan.jobs[0]));
});

test('responses must cover every input row exactly once and preserve column count', () => {
    const job = buildOptimizationPlan([history()], { keepRecent: 20 }).jobs[0];
    for (const summaries of [
        [{ sourceRows: ['row-0'], values: ['time', 'place', 'event'] }],
        [{ sourceRows: ['row-0', 'row-1', 'row-2', 'unrelated'], values: ['time', 'place', 'event'] }],
        [{ sourceRows: ['row-0', 'row-1', 'row-2', 'row-3', 'row-3'], values: ['time', 'place', 'event'] }],
        [{ sourceRows: ['row-0', 'row-1', 'row-2', 'row-3'], values: ['wrong column count'] }],
        [{ sourceRows: ['row-0', 'row-1', 'row-2', 'row-3'], values: ['time', 'place', { invented: true }] }],
    ]) {
        assert.throws(() => parseOptimizationResponse(JSON.stringify({ summaries }), job));
    }
});

test('a fenced JSON response is accepted without weakening validation', () => {
    const job = buildOptimizationPlan([history()], { keepRecent: 20 }).jobs[0];
    const response = { summaries: [{
        sourceRows: ['row-0', 'row-1', 'row-2', 'row-3'],
        values: ['time range', 'town', 'Preserved causes and consequences'],
    }] };
    assert.deepEqual(parseOptimizationResponse('```json\n' + JSON.stringify(response) + '\n```', job), response);
});

test('prompt uses actual target columns, user instructions, and no editable state tables', () => {
    const plan = buildOptimizationPlan([history(), archive(), characters()], { keepRecent: 20 });
    const messages = buildOptimizationMessages(plan.jobs[0], 'Keep promises and exact names.');
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /Keep promises and exact names/);
    const input = JSON.parse(messages[1].content);
    assert.deepEqual(input.targetColumns, ['时间范围', '内容']);
    assert.equal(input.rows.length, 4);
    assert.equal(JSON.stringify(input).includes('friend'), false);
});

test('planning and finishing never mutate the input snapshot', () => {
    const tables = [history(), characters()];
    const before = structuredClone(tables);
    const plan = buildOptimizationPlan(tables, { tableUids: ['characters'] });
    finishOptimization(plan, []);
    assert.deepEqual(tables, before);
});

test('recent-only chats have no summarization work', () => {
    const plan = buildOptimizationPlan([history(5)], { keepRecent: 20 });
    assert.equal(plan.jobs.length, 0);
    assert.equal(plan.duplicatesRemoved, 0);
});

test('built-in strategies change both the retained window and the summary instructions', () => {
    const tables = [history(50), archive()];
    const detail = buildOptimizationPlan(tables, { strategyId: 'detail' });
    const deep = buildOptimizationPlan(tables, { strategyId: 'deep' });
    assert.equal(detail.protectedRows, 30);
    assert.equal(deep.protectedRows, 8);
    assert.equal(deep.jobs.reduce((sum, job) => sum + job.rows.length, 0), 42);
    assert.equal(buildOptimizationPlan(tables, { strategyId: 'deep', keepRecent: 12 }).protectedRows, 12);
    const deepInput = JSON.parse(buildOptimizationMessages(deep.jobs[0])[1].content);
    assert.equal(deepInput.summaryGuidance.strategy, 'deep');
    assert.equal(deepInput.summaryGuidance.suggestedMaxSummaries, 2);
    assert.ok(deepInput.summaryGuidance.targetCharacters < JSON.parse(buildOptimizationMessages(detail.jobs[0])[1].content).summaryGuidance.targetCharacters);
    assert.match(buildOptimizationMessages(deep.jobs[0])[0].content, /阶段|关键节点/);
    assert.equal(new Set(OPTIMIZATION_STRATEGIES.map(strategy => strategy.prompt)).size, 3);
});

test('automatic recommendation explains a large history and stays conservative for small tables', () => {
    const large = history(103);
    large.content = large.content.map(row => [row[0], row[1], 'A factual event with a pending promise. '.repeat(8)]);
    const recommendation = recommendOptimizationStrategy([large, characters()]);
    assert.equal(recommendation.strategyId, 'deep');
    assert.match(recommendation.reason, /103/);
    assert.equal(buildOptimizationPlan([large, characters()]).protectedRows, 8);
    assert.equal(recommendOptimizationStrategy([history(24)]).strategyId, 'detail');
    const largeArchive = archive();
    largeArchive.content = Array.from({ length: 12 }, (_, index) => [`phase-${index}`, 'Earlier factual summary. '.repeat(40)]);
    largeArchive.rowIds = largeArchive.content.map((_, index) => `phase-${index}`);
    assert.equal(recommendOptimizationStrategy([history(5), largeArchive]).compactArchives, true);
    assert.equal(buildOptimizationPlan([history(5), largeArchive]).jobs[0]?.sourceUid, 'archive');
    assert.equal(buildOptimizationPlan([history(5), largeArchive], { compactArchives: false }).jobs.length, 0);
});

test('existing archives can be recompressed before new history is appended', () => {
    const oldArchive = archive();
    oldArchive.content.push(['day-before-2', 'Second earlier summary']);
    oldArchive.rowIds.push('earlier-summary-2');
    const tables = [history(12), oldArchive];
    const plan = buildOptimizationPlan(tables, { strategyId: 'deep', compactArchives: true });
    assert.equal(plan.jobs.length, 2);
    const responses = plan.jobs.map(job => ({
        summaries: [{
            sourceRows: job.rows.map(row => row.id),
            values: job.sourceUid === 'archive' ? ['earlier', 'Merged earlier summaries'] : ['day-0–day-3', 'New event summary'],
        }],
    }));
    const result = finishOptimization(plan, responses);
    assert.deepEqual(result.tables.find(table => table.uid === 'archive').content, [
        ['earlier', 'Merged earlier summaries'],
        ['day-0–day-3', 'New event summary'],
    ]);
    assert.equal(result.tables.find(table => table.uid === 'history').content.length, 8);
    assert.deepEqual(tables[1], oldArchive);
});
