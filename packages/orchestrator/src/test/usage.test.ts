import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Orchestrator } from '../index.js';
import { applyUsageEvent, emptyRunUsage, modelInfoFromRequest } from '../usage.js';
import type { RunRecord } from '../types.js';

describe('token usage', () => {
  it('accumulates step usage onto a run record', () => {
    const run: RunRecord = {
      id: 'r1',
      sessionId: 's1',
      kind: 'chat',
      attemptNo: 1,
      status: 'completed',
      startedAt: Date.now(),
      transcript: '',
      activities: [],
      approvals: [],
      artifacts: [],
      sources: [],
      eventLog: [],
      model: modelInfoFromRequest({
        provider: 'qwen',
        chatModel: 'qwen-plus',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        providerLabel: '通义 #1',
      }),
      usage: emptyRunUsage(),
    };
    applyUsageEvent(run, {
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cacheReadTokens: 10,
    });
    applyUsageEvent(run, {
      inputTokens: 50,
      outputTokens: 20,
      totalTokens: 70,
      reasoningTokens: 5,
    }, {
      provider: 'glm',
      chatModel: 'glm-4v',
      providerLabel: '智谱视觉',
    }, 'vision');
    assert.equal(run.usage?.inputTokens, 150);
    assert.equal(run.usage?.outputTokens, 60);
    assert.equal(run.usage?.totalTokens, 210);
    assert.equal(run.usage?.cacheReadTokens, 10);
    assert.equal(run.usage?.reasoningTokens, 5);
    assert.equal(run.usage?.steps.length, 2);
    assert.equal(run.model?.providerLabel, '通义 #1', 'specialist usage must not replace primary model');
    assert.equal(run.usage?.byModel?.length, 2);
    assert.equal(run.usage?.byModel?.find((item) => item.capability === 'vision')?.chatModel, 'glm-4v');
  });

  it('attributes primary and application-model tokens to their actual models', async () => {
    const orch = Orchestrator.memory({ runner: { async start(request, emit) {
      emit({ type: 'run.usage', runId: 'ignored', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, model: { provider: request.model.provider, chatModel: request.model.chatModel } });
      emit({ type: 'run.usage', runId: 'ignored', usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 }, model: { provider: 'glm', chatModel: 'glm-4v' }, capability: 'vision' });
      emit({ type: 'message.delta', runId: 'ignored', text: 'ok' }); emit({ type: 'run.completed', runId: 'ignored' });
    } } });
    const session = await orch.chat.createChatSession({ title: '应用模型用量', employeeId: 'general' });
    const run = await orch.engine.execute({ sessionId: session.id, kind: 'chat', request: {
      profile: { id: 'general', name: 'G', instructions: 'x', toolIds: [] }, messages: [{ role: 'user', content: '看图' }],
      model: { provider: 'qwen', chatModel: 'qwen-plus', apiKey: 'x' }, skills: [], searchProviders: [], mcpConnections: [], knowledgeBases: [],
    } });
    assert.equal(run.model?.chatModel, 'qwen-plus');
    assert.equal(run.usage?.totalTokens, 57);
    const stats = await orch.usageStats();
    assert.equal(stats.byModel.find((item) => item.chatModel === 'qwen-plus')?.totalTokens, 15);
    assert.equal(stats.byModel.find((item) => item.chatModel === 'glm-4v')?.totalTokens, 42);
    assert.equal(stats.byModel.find((item) => item.chatModel === 'glm-4v')?.capability, 'vision');
    assert.equal(stats.totals.totalTokens, 57);
  });

  it('aggregates usage stats by model / chat / project', async () => {
    const orch = Orchestrator.memory({
      runner: {
        async start(request, emit) {
          const runId = 'ignored';
          emit({
            type: 'run.usage',
            runId,
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            model: {
              provider: request.model.provider,
              chatModel: request.model.chatModel,
              providerLabel: request.model.providerLabel,
            },
          });
          emit({ type: 'message.delta', runId, text: 'ok' });
          emit({ type: 'run.completed', runId });
        },
      },
    });
    const session = await orch.chat.createChatSession({ title: '用量测试', employeeId: 'general' });
    await orch.engine.execute({
      sessionId: session.id,
      kind: 'chat',
      request: {
        profile: { id: 'general', name: 'G', instructions: 'x', toolIds: [] },
        messages: [{ role: 'user', content: 'hi' }],
        model: { provider: 'ollama', chatModel: 'llama3.2', apiKey: 'ollama', providerLabel: '本地 Ollama' },
        skills: [],
        searchProviders: [],
        mcpConnections: [],
        knowledgeBases: [],
      },
    });
    const stats = await orch.usageStats();
    assert.equal(stats.totals.runCount, 1);
    assert.equal(stats.totals.inputTokens, 10);
    assert.equal(stats.totals.outputTokens, 5);
    assert.equal(stats.byModel[0]?.chatModel, 'llama3.2');
    assert.equal(stats.byModel[0]?.providerLabel, '本地 Ollama');
    assert.equal(stats.byChat[0]?.sessionId, session.id);
    assert.equal(stats.recent[0]?.inputTokens, 10);
    assert.ok(stats.byDay.length >= 1);
    assert.ok(stats.byWeek.length >= 1);
    assert.ok(stats.byMonth.length >= 1);
    assert.match(stats.byDay[0]!.period, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(stats.byWeek[0]!.period, /^\d{4}-W\d{2}$/);
    assert.match(stats.byMonth[0]!.period, /^\d{4}-\d{2}$/);
  });

  it('compacts older per-run usage into one rollup and clears merged details', async () => {
    const orch = Orchestrator.memory({
      runner: {
        async start(request, emit) {
          emit({
            type: 'run.usage',
            runId: 'ignored',
            usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
            model: {
              provider: request.model.provider,
              chatModel: request.model.chatModel,
            },
          });
          emit({ type: 'message.delta', runId: 'ignored', text: 'ok' });
          emit({ type: 'run.completed', runId: 'ignored' });
        },
      },
    });
    const session = await orch.chat.createChatSession({ title: 'compact', employeeId: 'general' });
    for (let i = 0; i < 6; i += 1) {
      await orch.engine.execute({
        sessionId: session.id,
        kind: 'chat',
        request: {
          profile: { id: 'general', name: 'G', instructions: 'x', toolIds: [] },
          messages: [{ role: 'user', content: `hi-${i}` }],
          model: { provider: 'ollama', chatModel: 'llama3.2', apiKey: 'ollama' },
          skills: [],
          searchProviders: [],
          mcpConnections: [],
          knowledgeBases: [],
        },
      });
    }
    const { maybeCompactUsage } = await import('../usage.js');
    const rollup = await maybeCompactUsage({
      store: orch.engine.store,
      engine: orch.engine,
      chat: orch.chat,
      projects: orch.projects,
      limit: 5,
      keep: 2,
    });
    assert.ok(rollup);
    assert.equal(rollup!.mergedRunCount, 4);
    const remaining = (await orch.engine.listRuns()).filter((run) => run.usage);
    assert.equal(remaining.length, 2);
    const stats = await orch.usageStats();
    assert.equal(stats.totals.runCount, 6);
    assert.equal(stats.totals.totalTokens, 30);
    assert.equal(stats.rollup?.mergedRunCount, 4);
    assert.equal(stats.recent.length, 2);
  });
});
