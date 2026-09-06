import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore, Orchestrator } from '../index.js';
import { FakeRunner, runContext, waitFor } from './fake.js';

test('two clients share the same durable chat session state', async () => {
  const fake = new FakeRunner();
  // One physical store shared by two orchestrator instances: the desktop UI
  // process and a future gateway process both read the same durable state.
  const store = new MemoryStore();
  const first = new Orchestrator({ store, runner: fake });
  const second = new Orchestrator({ store, runner: fake });
  try {
    const session = await first.chat.createChatSession({ title: 'shared', employeeId: 'general' });
    await first.chat.sendUserMessage(session.id, { content: '请分析一下框架', context: runContext() });

    // The second orchestrator (e.g. the future gateway process over the same
    // store) observes the exact same conversation without being the writer.
    await waitFor(async () => {
      const observed = await second.chat.getChatSession(session.id);
      const assistant = observed?.messages.find((message) => message.role === 'assistant');
      return Boolean(observed && assistant && assistant.content.includes('echo#1'));
    });

    const observed = await second.chat.getChatSession(session.id);
    assert.equal(observed?.title, 'shared');
    assert.ok(observed?.messages.some((message) => message.role === 'user' && message.content === '请分析一下框架'));
    const assistant = observed?.messages.find((message) => message.role === 'assistant');
    assert.ok(assistant?.content.includes('echo#1'));

    const pending = await second.chat.pendingApprovals(session.id);
    assert.equal(pending.length, 0);
  } finally {
    await first.close();
    await second.close();
  }
});

test('approval parks a run and resolves by re-running the same turn (resumable run)', async () => {
  const fake = new FakeRunner({
    approvalOnCall: 1,
    approvals: [{ skillId: 'document-workbench', capability: 'workspace-write', summary: '需要写入运行工作区' }],
  });
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const session = await orch.chat.createChatSession({ title: 'approval', employeeId: 'general' });
    const { runId, turnId } = await orch.chat.sendUserMessage(session.id, {
      content: '生成一份报告文件',
      context: runContext(),
    });

    // Parked: no text, run waiting for approval.
    await waitFor(async () => (await orch.chat.pendingApprovals(session.id)).length === 1);
    const parked = await orch.chat.getRun(runId);
    assert.equal(parked?.status, 'waiting-approval');
    assert.equal(parked?.approvals[0]?.status, 'pending');

    const pending = await orch.chat.pendingApprovals(session.id);
    const approval = pending[0].approvals[0];
    await orch.chat.resolveApproval({
      sessionId: session.id,
      approvalId: approval.id,
      allow: true,
      scope: 'session',
      resumeContext: runContext(),
    });

    await waitFor(async () => {
      const observed = await orch.chat.getChatSession(session.id);
      const assistant = observed?.messages.find((message) => message.role === 'assistant' && !message.superseded);
      return Boolean(assistant && assistant.content.includes('echo#2'));
    });

    const observed = await orch.chat.getChatSession(session.id);
    const assistant = observed?.messages.find((message) => message.role === 'assistant' && !message.superseded);
    assert.ok(assistant?.content.includes('echo#2'));
    assert.equal(assistant?.turnId, turnId);
    assert.equal(observed?.grantsSession['document-workbench']?.includes('workspace-write'), true);

    const resolved = await orch.chat.getRun(runId);
    assert.equal(resolved?.approvals[0]?.status, 'allowed');
    assert.equal(resolved?.status, 'waiting-approval'); // historical attempt stays parked
    assert.equal(fake.calls.length, 2);
  } finally {
    await orch.close();
  }
});

test('chat without client context runs via the server context resolver', async () => {
  const fake = new FakeRunner();
  const orch = new Orchestrator({
    store: new MemoryStore(),
    runner: fake,
    chatContextResolver: async () => runContext(),
  });
  try {
    const session = await orch.chat.createChatSession({ employeeId: 'general' });
    await orch.chat.sendUserMessage(session.id, { content: '帮我查一下' });
    await waitFor(async () => {
      const current = await orch.chat.getChatSession(session.id);
      return Boolean(current?.messages.some((m) => m.role === 'assistant' && m.content.includes('echo#1')));
    });
    assert.equal(fake.calls.length, 1);
  } finally {
    await orch.close();
  }
});

test('approval allowed without resumeContext auto-resumes via the resolver', async () => {
  const fake = new FakeRunner({
    approvalOnCall: 1,
    approvals: [{ skillId: 'document-workbench', capability: 'workspace-write', summary: '需要写入' }],
  });
  const orch = new Orchestrator({
    store: new MemoryStore(),
    runner: fake,
    chatContextResolver: async () => runContext(),
  });
  try {
    const session = await orch.chat.createChatSession();
    await orch.chat.sendUserMessage(session.id, { content: '写个文件' });
    await waitFor(async () => (await orch.chat.pendingApprovals(session.id)).length === 1);
    const pending = await orch.chat.pendingApprovals(session.id);
    const approval = pending[0].approvals[0];
    await orch.chat.resolveApproval({ sessionId: session.id, approvalId: approval.id, allow: true, scope: 'session' });
    await waitFor(async () => {
      const current = await orch.chat.getChatSession(session.id);
      return Boolean(current?.messages.find((m) => m.role === 'assistant' && !m.superseded)?.content.includes('echo#2'));
    });
    assert.equal(fake.calls.length, 2);
  } finally {
    await orch.close();
  }
});

test('denied approval does not resume the run', async () => {
  const fake = new FakeRunner({
    approvalOnCall: 1,
    approvals: [{ skillId: 's', capability: 'script-execution', summary: '需要执行脚本' }],
  });
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const session = await orch.chat.createChatSession();
    await orch.chat.sendUserMessage(session.id, { content: '跑一下', context: runContext() });
    await waitFor(async () => (await orch.chat.pendingApprovals(session.id)).length === 1);
    const pending = await orch.chat.pendingApprovals(session.id);
    await orch.chat.resolveApproval({
      sessionId: session.id,
      approvalId: pending[0].approvals[0].id,
      allow: false,
    });
    assert.equal(fake.calls.length, 1);
    const observed = await orch.chat.getChatSession(session.id);
    assert.equal(observed?.grantsSession['s']?.length ?? 0, 0);
  } finally {
    await orch.close();
  }
});

test('chat session and run persist ownerUserId with legacy compatibility', async () => {
  const fake = new FakeRunner();
  const orch = Orchestrator.memory({ runner: fake });
  try {
    const session = await orch.chat.createChatSession({
      title: 'owner-test',
      employeeId: 'general',
      ownerUserId: 'user-owner-1',
    });
    assert.equal(session.ownerUserId, 'user-owner-1');
    assert.equal(session.userId, 'user-owner-1');

    const sent = await orch.chat.sendUserMessage(session.id, { content: '测试 owner 字段', context: runContext() });
    await waitFor(async () => {
      const run = await orch.chat.getRun(sent.runId);
      return Boolean(run?.finishedAt);
    });

    const storedSession = await orch.chat.getChatSession(session.id);
    const run = await orch.chat.getRun(sent.runId);
    assert.equal(storedSession?.ownerUserId, 'user-owner-1');
    assert.equal(storedSession?.userId, 'user-owner-1');
    assert.equal(run?.ownerUserId, 'user-owner-1');
    assert.equal(run?.userId, 'user-owner-1');
  } finally {
    await orch.close();
  }
});
