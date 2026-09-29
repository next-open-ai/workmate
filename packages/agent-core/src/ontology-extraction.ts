import { createHash } from 'node:crypto';
import { completeSimple } from '@mariozechner/pi-ai';
import { z } from 'zod';
import {
  OntologyCandidateSchema,
  type KnowledgeBaseRuntime,
  type ModelConfig,
  type OntologyCandidate,
} from '@workmate/contracts';
import { listKnowledgeChunks } from './knowledge-runtime.js';
import { importOntologyCandidates } from './ontology-runtime.js';
import { createChatCompletionsPayloadPatch, toPiModel } from './pi-model.js';

const PrimitiveSchema = z.union([z.string(), z.number(), z.boolean()]);
const EvidenceSchema = z.object({ chunkId: z.string().min(1), quote: z.string().min(1) });
const ExtractedNodeSchema = z.object({
  id: z.string().min(1).max(240),
  type: z.string().min(1).max(80),
  name: z.string().min(1).max(240),
  aliases: z.array(z.string().min(1).max(240)).max(32).default([]),
  properties: z.record(z.string(), PrimitiveSchema).default({}),
  confidence: z.number().min(0).max(1).default(0.7),
  evidence: EvidenceSchema,
});
const ExtractedEdgeSchema = z.object({
  subjectId: z.string().min(1).max(240),
  predicate: z.string().min(1).max(120),
  objectId: z.string().min(1).max(240),
  properties: z.record(z.string(), PrimitiveSchema).default({}),
  confidence: z.number().min(0).max(1).default(0.7),
  evidence: EvidenceSchema,
});
const ExtractionPayloadSchema = z.object({
  nodes: z.array(ExtractedNodeSchema).max(100),
  edges: z.array(ExtractedEdgeSchema).max(150),
});

export type ExtractionChunk = {
  id: string;
  documentId: string;
  documentTitle: string;
  source?: string;
  content: string;
};

const EXTRACTION_BATCH_MAX_CHUNKS = 4;
const EXTRACTION_BATCH_MAX_CHARS = 8_000;
const EXTRACTION_RETRY_MIN_CHARS = 480;

class OntologyModelOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OntologyModelOutputError';
  }
}

class OntologyEvidenceVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OntologyEvidenceVerificationError';
  }
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 20)}`;
}

function verifiedQuote(chunk: ExtractionChunk, quote: string) {
  const clean = quote.trim().slice(0, 4000);
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  if (!clean || !normalize(chunk.content).includes(normalize(clean))) {
    throw new OntologyEvidenceVerificationError(`模型为切片 ${chunk.id} 返回了无法在原文中核验的证据。`);
  }
  return clean;
}

function parseModelJson(text: string) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const raw = (fenced || text).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new OntologyModelOutputError('模型未返回完整的本体 JSON。');
  try {
    return ExtractionPayloadSchema.parse(JSON.parse(raw.slice(start, end + 1)));
  } catch (error) {
    throw new OntologyModelOutputError('模型返回的本体 JSON 不完整或格式不正确。', { cause: error });
  }
}

export function normalizeOntologyExtraction(
  text: string,
  chunks: ExtractionChunk[],
  options: { allowEmpty?: boolean; skipInvalidEvidence?: boolean } = {},
): OntologyCandidate[] {
  const payload = parseModelJson(text);
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const acceptedNodeIds = new Set<string>();
  const candidates: OntologyCandidate[] = [];
  for (const node of payload.nodes) {
    const chunk = chunksById.get(node.evidence.chunkId);
    if (!chunk) throw new Error(`模型引用了未授权的知识切片：${node.evidence.chunkId}`);
    try {
      candidates.push(OntologyCandidateSchema.parse({
        id: stableId('candidate-node', node.id, chunk.id),
        kind: 'node',
        node: { id: node.id, type: node.type, name: node.name, aliases: node.aliases, properties: node.properties, source: chunk.source || chunk.documentTitle, status: 'draft' },
        confidence: node.confidence,
        status: 'pending',
        evidence: [{ documentId: chunk.documentId, chunkId: chunk.id, title: chunk.documentTitle, quote: verifiedQuote(chunk, node.evidence.quote), source: chunk.source }],
      }));
      acceptedNodeIds.add(node.id);
    } catch (error) {
      if (options.skipInvalidEvidence && error instanceof OntologyEvidenceVerificationError) continue;
      throw error;
    }
  }
  for (const edge of payload.edges) {
    if (!acceptedNodeIds.has(edge.subjectId) || !acceptedNodeIds.has(edge.objectId)) continue;
    const chunk = chunksById.get(edge.evidence.chunkId);
    if (!chunk) throw new Error(`模型引用了未授权的知识切片：${edge.evidence.chunkId}`);
    try {
      candidates.push(OntologyCandidateSchema.parse({
        id: stableId('candidate-edge', edge.subjectId, edge.predicate, edge.objectId, chunk.id),
        kind: 'edge',
        edge: { id: stableId('edge', edge.subjectId, edge.predicate, edge.objectId), subjectId: edge.subjectId, predicate: edge.predicate, objectId: edge.objectId, properties: edge.properties, source: chunk.source || chunk.documentTitle, status: 'draft' },
        confidence: edge.confidence,
        status: 'pending',
        evidence: [{ documentId: chunk.documentId, chunkId: chunk.id, title: chunk.documentTitle, quote: verifiedQuote(chunk, edge.evidence.quote), source: chunk.source }],
      }));
    } catch (error) {
      if (options.skipInvalidEvidence && error instanceof OntologyEvidenceVerificationError) continue;
      throw error;
    }
  }
  if (!candidates.length && !options.allowEmpty) throw new Error('没有从所选文档中识别到可审核的实体或关系。');
  return candidates;
}

export function partitionOntologyExtractionChunks(
  chunks: ExtractionChunk[],
  options: { maxChunks?: number; maxChars?: number } = {},
) {
  const maxChunks = Math.max(1, options.maxChunks || EXTRACTION_BATCH_MAX_CHUNKS);
  const maxChars = Math.max(1, options.maxChars || EXTRACTION_BATCH_MAX_CHARS);
  const batches: ExtractionChunk[][] = [];
  let current: ExtractionChunk[] = [];
  let currentChars = 0;
  for (const chunk of chunks) {
    const chunkChars = chunk.content.length;
    if (current.length && (current.length >= maxChunks || currentChars + chunkChars > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(chunk);
    currentChars += chunkChars;
  }
  if (current.length) batches.push(current);
  return batches;
}

function splitExtractionChunkForRetry(chunk: ExtractionChunk): [ExtractionChunk, ExtractionChunk] | null {
  if (chunk.content.length <= EXTRACTION_RETRY_MIN_CHARS) return null;
  const midpoint = Math.floor(chunk.content.length / 2);
  const searchStart = Math.max(1, midpoint - 240);
  const searchEnd = Math.min(chunk.content.length - 1, midpoint + 240);
  const nearby = chunk.content.slice(searchStart, searchEnd);
  const boundaries = [...nearby.matchAll(/[\n。；;,，]\s*/g)];
  const best = boundaries.length
    ? boundaries.reduce((selected, item) => (
      Math.abs((searchStart + item.index! + item[0].length) - midpoint)
        < Math.abs(selected - midpoint)
        ? searchStart + item.index! + item[0].length
        : selected
    ), midpoint)
    : midpoint;
  const left = chunk.content.slice(0, best).trim();
  const right = chunk.content.slice(best).trim();
  if (!left || !right) return null;
  return [{ ...chunk, content: left }, { ...chunk, content: right }];
}

type AnalyzeExtractionBatch = (chunks: ExtractionChunk[]) => Promise<string>;

export async function extractOntologyCandidateBatches(
  chunks: ExtractionChunk[],
  analyze: AnalyzeExtractionBatch,
): Promise<OntologyCandidate[]> {
  const analyzeWithFallback = async (batch: ExtractionChunk[]): Promise<OntologyCandidate[]> => {
    try {
      return normalizeOntologyExtraction(await analyze(batch), batch, { allowEmpty: true, skipInvalidEvidence: true });
    } catch (error) {
      if (!(error instanceof OntologyModelOutputError)) throw error;
      if (batch.length === 1) {
        const split = splitExtractionChunkForRetry(batch[0]!);
        if (split) {
          return [
            ...await analyzeWithFallback([split[0]]),
            ...await analyzeWithFallback([split[1]]),
          ];
        }
        throw new Error(`模型对切片 ${batch[0]!.id} 返回的结构化结果不完整，请重试或减少分析范围。`, { cause: error });
      }
      const middle = Math.ceil(batch.length / 2);
      return [
        ...await analyzeWithFallback(batch.slice(0, middle)),
        ...await analyzeWithFallback(batch.slice(middle)),
      ];
    }
  };

  const candidates: OntologyCandidate[] = [];
  const seen = new Set<string>();
  for (const batch of partitionOntologyExtractionChunks(chunks)) {
    for (const candidate of await analyzeWithFallback(batch)) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      candidates.push(candidate);
    }
  }
  if (!candidates.length) throw new Error('没有从所选文档中识别到可审核的实体或关系。');
  return candidates;
}

export async function extractOntologyCandidates(input: {
  kb: KnowledgeBaseRuntime;
  documentIds: string[];
  instructions?: string;
  model: ModelConfig;
}) {
  const selected = new Set(input.documentIds);
  const chunks: ExtractionChunk[] = [];
  for (const documentId of selected) {
    const listed = await listKnowledgeChunks({ kb: input.kb, documentId, offset: 0, limit: 50 });
    for (const chunk of listed.chunks) {
      if (chunks.length >= 60) break;
      chunks.push({ id: chunk.id, documentId: chunk.documentId, documentTitle: chunk.documentTitle, source: chunk.source, content: chunk.content.slice(0, 2200) });
    }
    if (chunks.length >= 60) break;
  }
  if (!chunks.length) throw new Error('所选文档没有可用于分析的知识切片。');

  const candidates = await extractOntologyCandidateBatches(chunks, async (batch) => {
    const corpus = batch.map((chunk) => `<chunk id="${chunk.id}" document="${chunk.documentId}" title="${chunk.documentTitle}">\n${chunk.content}\n</chunk>`).join('\n\n');
    const response = await completeSimple(toPiModel(input.model), {
      systemPrompt: [
        '你是企业知识本体分析器。只依据提供的知识切片识别业务实体、概念及明确关系，不补充外部事实。',
        '必须返回一个 JSON 对象，结构为 {"nodes":[],"edges":[]}，不要输出解释。没有候选时返回空数组。',
        '每个 node 包含 id,type,name,aliases,properties,confidence,evidence:{chunkId,quote}。',
        '每个 edge 包含 subjectId,predicate,objectId,properties,confidence,evidence:{chunkId,quote}；两端必须引用 nodes 中的 id。',
        'id 使用简短稳定的英文或拼音标识。quote 必须是对应切片中的原文证据。合并同义实体，避免重复和过度抽取。',
        '每次最多返回 12 个节点和 16 条关系。只保留对业务检索有明确价值的候选，确保 JSON 完整闭合。',
      ].join('\n'),
      messages: [{ role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: `${input.instructions?.trim() ? `分析重点：${input.instructions.trim()}\n\n` : ''}请从以下文档切片生成待人工审核的本体候选：\n\n${corpus}` }] }],
    }, {
      apiKey: input.model.apiKey || (input.model.provider === 'ollama' ? 'ollama' : undefined),
      signal: AbortSignal.timeout(120_000),
      maxTokens: 4_000,
      onPayload: createChatCompletionsPayloadPatch(input.model),
    });
    if (response.stopReason === 'length') throw new OntologyModelOutputError('模型输出达到长度上限。');
    if (response.stopReason === 'error' || response.stopReason === 'aborted') throw new Error(response.errorMessage || '本体分析模型未完成请求。');
    return response.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map((part) => part.text).join('\n').trim();
  });
  const workflow = await importOntologyCandidates(input.kb, candidates);
  return { workflow, generated: candidates.length, nodes: candidates.filter((item) => item.kind === 'node').length, edges: candidates.filter((item) => item.kind === 'edge').length, analyzedChunks: chunks.length };
}
