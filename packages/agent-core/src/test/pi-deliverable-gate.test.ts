import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MODEL_TURN_IDLE_MS, requiresFileDeliverable } from '../pi-runtime.js';
import { pdfChatPreview } from '../skill-runtime.js';

test('one provider turn may remain silent for three minutes before the idle guard aborts it', () => {
  assert.equal(DEFAULT_MODEL_TURN_IDLE_MS, 180_000);
});

test('PDF rendering keeps a bounded source preview for the final chat answer', () => {
  const itinerary = '# 第1天\n抵达三亚\n# 第2天\n亚龙湾';
  assert.equal(pdfChatPreview(itinerary), itinerary);
  const preview = pdfChatPreview('行'.repeat(3_000));
  assert.equal(preview.length, 2_400);
  assert.equal(preview.endsWith('…'), true);
});

test('file delivery gate recognizes explicit document exports', () => {
  assert.equal(requiresFileDeliverable('创建一份从上海到三亚的6天行程，并导出为PDF文件'), true);
  assert.equal(requiresFileDeliverable('把这个 PPT 转成一个演讲视频'), true);
  assert.equal(requiresFileDeliverable('Generate and save a DOCX report'), true);
});

test('file delivery gate leaves ordinary conversation as text-only', () => {
  assert.equal(requiresFileDeliverable('帮我规划上海到三亚的行程'), false);
  assert.equal(requiresFileDeliverable('解释一下 PDF 是什么'), false);
  assert.equal(requiresFileDeliverable('你好'), false);
});
