import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { AccountSession, ChatPage, ChatTurn, ChatCitation, ChatAnchor, ChatScope, ChatCheck, ChatRetrieval } from '@yuqu/contracts';
import { requireSession } from './auth.ts';
import { transaction } from './database.ts';
import { authorizedMedia } from './library.ts';
import { object, uuid, invalid } from './validation.ts';
import { AppError } from './errors.ts';
import { answerCitations } from './citations.ts';
import { projectSentences } from './transcript-sentences.ts';
import { chatIntent, type ChatIntent } from './chat-anchors.ts';
import { readSnapshot, resolveTranscriptSelection } from './knowledge.ts';
import { retrieveSegments, RETRIEVAL_TASK_TYPE, NO_RETRIEVAL_EVIDENCE } from './retrieval.ts';
export { RETRIEVAL_TASK_TYPE } from './retrieval.ts';

type Row = Record<string, any>;
const view = (row: Row): ChatTurn => ({ id: row.id, sequence: row.sequence, question: row.question, answer: row.answer,
  status: row.status, positionMs: row.position_ms, scope: row.scope, createdAt: row.created_at.toISOString(), error: row.error, citations: row.citations,
  parentTurnId: row.parent_turn_id ?? null, topicRootTurnId: row.topic_root_turn_id ?? row.id, anchor: row.anchor ?? null,
  ...(row.context?.retrieval ? { retrieval: row.context.retrieval } : {}) });
export async function chatPage(pool: Pool, account: AccountSession, mediaId: string, before?: number, supportsAnchors = true, supportsRetrieval = false): Promise<ChatPage> {
  if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) throw invalid('对话页码无效。');
  return transaction(pool, async db => {
    await requireSession(db, account); const media = await authorizedMedia(db, account, mediaId);
    const conversation = (await db.query('SELECT id FROM yuqu.chat_conversations WHERE user_id=$1 AND media_version_id=$2', [account.user.id, mediaId])).rows[0];
    const online = ((await db.query("SELECT 1 FROM yuqu.bridge_presence WHERE project_id=$1 AND last_seen>now()-interval '60 seconds'", [process.env.YUQU_BRIDGE_PROJECT_ID || 'yuqu'])).rowCount ?? 0) > 0;
    const retrievalOnline = ((await db.query("SELECT 1 FROM yuqu.bridge_presence WHERE project_id=$1 AND last_seen>now()-interval '60 seconds' AND task_types @> $2::jsonb", [process.env.YUQU_BRIDGE_PROJECT_ID || 'yuqu', JSON.stringify([RETRIEVAL_TASK_TYPE])])).rowCount ?? 0) > 0;
    if (!conversation) return { mediaVersionId: mediaId, conversationId: null, turns: [], nextBefore: null, bridgeOnline: online, retrievalOnline, audioAvailable: media.audio_available };
    const rows = (await db.query('SELECT * FROM yuqu.chat_turns WHERE conversation_id=$1 AND ($2::integer IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT 21', [conversation.id, before ?? null])).rows;
    const selected: ChatTurn[] = []; let bytes = 0;
    for (const row of rows.slice(0, 20)) {
      const turn = view(row), size = Buffer.byteLength(JSON.stringify(turn));
      if (selected.length && bytes + size > 200000) break;
      selected.push(turn); bytes += size;
    }
    selected.reverse();
    if (!supportsAnchors && selected.some(turn => turn.scope === 'selection')) {
      throw new AppError(409, 'UPGRADE_REQUIRED', '本页包含选段问答，当前客户端版本暂不支持。请升级鱼趣后查看，或使用最新版网页；已有文稿和对话均已保留。');
    }
    if (!supportsRetrieval && selected.some(turn => turn.scope === 'retrieval')) throw new AppError(409, 'UPGRADE_REQUIRED', '本页包含整期检索问答，请升级鱼趣后查看，或使用最新版网页；已有文稿和对话均已保留。');
    return { mediaVersionId: mediaId, conversationId: conversation.id, turns: selected, nextBefore: rows.length > selected.length ? selected[0].sequence : null, bridgeOnline: online, retrievalOnline, audioAvailable: media.audio_available };
  });
}
async function ensureNoPending(db: PoolClient, conversationId: string, userId: string) {
  const pending = (await db.query("SELECT conversation_id FROM yuqu.chat_turns WHERE user_id=$1 AND status IN ('queued','running')", [userId])).rows;
  if (pending.some(row => row.conversation_id === conversationId)) throw new AppError(409, 'CHAT_BUSY', '这个对话正在回答，请等待或取消后再提问。');
  if (pending.length >= 3) throw new AppError(429, 'CHAT_LIMIT', '已有多个问题等待回答，请稍后再试。');
}
async function contextFor(db: PoolClient, account: AccountSession, media: Row, position: number, scope: string) {
  const transcript = (await db.query('SELECT * FROM yuqu.transcript_jobs WHERE media_version_id=$1 AND user_id=$2 FOR SHARE', [media.id, account.user.id])).rows[0];
  if (!transcript || transcript.completed_ms <= 0 || (scope === 'all' && transcript.status !== 'ready') ||
      (scope !== 'all' && position > transcript.completed_ms)) throw new AppError(409, 'TRANSCRIPT_PENDING', '所选范围的文稿尚未转写完成，请稍后再问。');
  const from = scope === 'near' ? Math.max(0, position - 120000) : 0;
  const to = scope === 'all' ? media.duration_ms : position;
  const semantic = transcript.model_info?.pipeline === 'yuqu-qwen3-episode-v3';
  const chunks = semantic
    ? (await db.query('SELECT chunk_index,segments FROM yuqu.transcript_chunks WHERE job_id=$1 ORDER BY chunk_index LIMIT 481', [transcript.id])).rows
    : (await db.query('SELECT segments FROM yuqu.transcript_chunks WHERE job_id=$1 AND end_ms>=$2 AND start_ms<=$3 ORDER BY chunk_index', [transcript.id, from, to])).rows;
  if (chunks.length > 480) throw new Error('Transcript chunk limit exceeded');
  const source = semantic ? projectSentences(transcript.id, chunks) : chunks.flatMap(row => row.segments as Array<{ startMs: number; endMs: number; text: string }>);
  const raw = source.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })).filter(segment =>
    segment.endMs >= from && (scope === 'until' ? segment.endMs <= to : segment.startMs <= to));
  if (!raw.length) throw new AppError(409, 'TRANSCRIPT_EMPTY', '所选位置没有可用的讲话文稿，请换个位置或选择整期内容。');
  if (raw.length > 600 || raw.reduce((n, row) => n + row.text.length, 0) > 32000) throw new AppError(422, 'CONTEXT_TOO_LONG', '这个范围的文稿较长，请先选择当前位置附近分段提问。');
  const segments: ChatCitation[] = raw.map((segment, index) => ({ id: `S${index + 1}`, ...segment }));
  return { transcriptId: transcript.id as string, model: transcript.model as string, segments };
}
interface ResolvedQuestion {
  position: number; scope: ChatScope; anchor: ChatAnchor | null; parent: Row | null;
  context: { transcriptId: string; model: string | null; segments: ChatCitation[]; retrieval?: ChatRetrieval };
}
async function ownedTurn(db: PoolClient, account: AccountSession, mediaId: string, id: string): Promise<Row> {
  const row = (await db.query('SELECT * FROM yuqu.chat_turns WHERE id=$1 AND user_id=$2 AND media_version_id=$3 FOR SHARE', [id, account.user.id, mediaId])).rows[0];
  if (!row) throw new AppError(404, 'CHAT_NOT_FOUND', '引用或话题不存在。');
  if (row.status !== 'complete') throw new AppError(409, 'CHAT_NOT_COMPLETE', '请等待回答完成后再追问或选择引用。');
  return row;
}
async function resolveQuestion(db: PoolClient, account: AccountSession, media: Row, intent: ChatIntent, question?: string): Promise<ResolvedQuestion> {
  if (intent.parentTurnId) {
    const parent = await ownedTurn(db, account, media.id, intent.parentTurnId);
    if (parent.context.retrieval?.status === 'no-evidence') throw new AppError(409, 'RETRIEVAL_EMPTY_TOPIC', '原话题没有检索到可用原文，请点击“检索整期文稿”重新提问。');
    return { position: parent.position_ms, scope: parent.scope, anchor: parent.anchor, parent,
      context: { transcriptId: parent.context.transcriptId, model: parent.context.transcriptModel, segments: parent.context.segments,
        ...(parent.context.retrieval ? { retrieval: parent.context.retrieval } : {}) } };
  }
  const anchor = intent.anchor;
  if (anchor?.kind === 'retrieval') {
    if (!question) throw invalid('请输入需要检索的问题。');
    const frozen = await readSnapshot(db, account, media.id);
    if (frozen.transcript.status !== 'ready' || frozen.snapshot.throughMs !== media.duration_ms) throw new AppError(409, 'TRANSCRIPT_PENDING', '整期文稿完成后才能检索问答，请稍后再试。');
    const found = retrieveSegments(frozen.segments, question);
    const retrieval: ChatRetrieval = { strategy: 'lexical-v1', status: found.segments.length ? 'matched' : 'no-evidence', snapshot: frozen.snapshot,
      totalSegments: frozen.segments.length, matchedSegments: found.matchedSegments, selectedSegments: found.segments.length,
      sourceSegmentIds: found.segments.map(segment => segment.id), queryTerms: found.terms };
    return { position: found.segments[0]?.startMs ?? 0, scope: 'retrieval', anchor, parent: null,
      context: { transcriptId: frozen.transcript.id, model: frozen.transcript.model, retrieval,
        segments: found.segments.map(({ startMs, endMs, text }, i) => ({ id: `S${i + 1}`, startMs, endMs, text })) } };
  }
  if (anchor?.kind === 'transcript-selection') {
    const selected = await resolveTranscriptSelection(db, account, media.id, anchor);
    return { position: selected.segments[0].startMs, scope: 'selection', anchor, parent: null,
      context: { transcriptId: selected.transcriptId, model: selected.model,
        segments: selected.segments.map(({ startMs, endMs, text }, i) => ({ id: `S${i + 1}`, startMs, endMs, text })) } };
  }
  if (anchor?.kind === 'citation-selection') {
    const source = await ownedTurn(db, account, media.id, anchor.sourceTurnId);
    const selected = anchor.citationIds.map(id => (source.citations as ChatCitation[]).find(citation => citation.id === id));
    if (selected.some(item => !item)) throw invalid('引用不属于所选回答。');
    const segments = (selected as ChatCitation[]).sort((a,b) => a.startMs - b.startMs).map(({ startMs, endMs, text }, i) => ({ id: `S${i + 1}`, startMs, endMs, text }));
    return { position: segments[0].startMs, scope: 'selection', anchor, parent: null,
      context: { transcriptId: source.context.transcriptId, model: source.context.transcriptModel, segments } };
  }
  const position = anchor?.kind === 'position' ? anchor.positionMs : intent.legacy!.positionMs;
  const scope = anchor?.kind === 'position' ? anchor.scope : intent.legacy!.scope;
  if (position > media.duration_ms) throw invalid('提问位置超出音频时长。');
  return { position, scope, anchor, parent: null, context: await contextFor(db, account, media, position, scope) };
}
async function topicHistory(db: PoolClient, account: AccountSession, mediaId: string, parent: Row | null) {
  const history: Array<{ question: string; answer: string }> = [];
  let row = parent;
  for (let depth = 0; row && depth < 4; depth++) {
    history.unshift({ question: row.question, answer: row.answer.slice(0, 2000) });
    row = row.parent_turn_id ? await ownedTurn(db, account, mediaId, row.parent_turn_id) : null;
  }
  return history;
}
/** Checks only; creates neither an empty conversation nor an answer task. */
export async function checkChat(pool: Pool, account: AccountSession, mediaId: string, input: unknown): Promise<ChatCheck> {
  const intent = chatIntent(object(input));
  return transaction(pool, async db => {
    await requireSession(db, account);
    const media = await authorizedMedia(db, account, mediaId);
    if (intent.anchor?.kind === 'retrieval') {
      const transcript = (await db.query('SELECT status,completed_ms FROM yuqu.transcript_jobs WHERE media_version_id=$1 AND user_id=$2 FOR SHARE', [mediaId, account.user.id])).rows[0];
      if (transcript?.status !== 'ready' || transcript.completed_ms !== media.duration_ms) throw new AppError(409, 'TRANSCRIPT_PENDING', '整期文稿完成后才能检索问答，请稍后再试。');
      // Readiness only: the question and selected evidence are resolved atomically on submission.
      return { available: true, positionMs: 0, scope: 'retrieval', segmentCount: 0, characterCount: 0 };
    }
    const resolved = await resolveQuestion(db, account, media, intent);
    return { available: true, positionMs: resolved.position, scope: resolved.scope,
      segmentCount: resolved.context.segments.length, characterCount: resolved.context.segments.reduce((n, part) => n + part.text.length, 0) };
  });
}
export async function askChat(pool: Pool, account: AccountSession, mediaId: string, input: unknown): Promise<ChatTurn> {
  const value = object(input), requestId = uuid(value.requestId), intent = chatIntent(value);
  const question = typeof value.question === 'string' ? value.question.trim() : '';
  if (!question || question.length > 2000) throw invalid('请输入不超过 2000 字的问题。');
  return transaction(pool, async db => {
    await requireSession(db, account);
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [account.user.id]);
    const media = await authorizedMedia(db, account, mediaId);
    const previous = (await db.query('SELECT * FROM yuqu.chat_turns WHERE user_id=$1 AND request_id=$2', [account.user.id, requestId])).rows[0];
    if (previous) {
      const sameIntent = previous.request_intent ? isDeepStrictEqual(previous.request_intent, intent)
        : Boolean(intent.legacy && previous.position_ms === intent.legacy.positionMs && previous.scope === intent.legacy.scope);
      if (previous.media_version_id !== mediaId || previous.question !== question || !sameIntent) throw new AppError(409, 'REQUEST_REUSED', '这次提交标识已用于其他问题，请重新发送。');
      return view(previous);
    }
    if ((await db.query("SELECT count(*)::int AS n FROM yuqu.chat_turns WHERE user_id=$1 AND created_at>now()-interval '1 minute'", [account.user.id])).rows[0].n >= 10) throw new AppError(429, 'CHAT_LIMIT', '提问较频繁，请稍后再试。');
    await db.query('INSERT INTO yuqu.chat_conversations(id,user_id,media_version_id) VALUES($1,$2,$3) ON CONFLICT(user_id,media_version_id) DO NOTHING', [randomUUID(), account.user.id, mediaId]);
    const conversation = (await db.query('SELECT * FROM yuqu.chat_conversations WHERE user_id=$1 AND media_version_id=$2 FOR UPDATE', [account.user.id, mediaId])).rows[0];
    await ensureNoPending(db, conversation.id, account.user.id);
    const { context, position, scope, parent, anchor } = await resolveQuestion(db, account, media, intent, question);
    // Legacy callers keep their existing history semantics. New roots are independent.
    const history = intent.legacy
      ? (await db.query("SELECT question,answer FROM yuqu.chat_turns WHERE conversation_id=$1 AND status='complete' ORDER BY sequence DESC LIMIT 4", [conversation.id])).rows.reverse().map(row => ({ question: row.question, answer: row.answer.slice(0, 2000) }))
      : await topicHistory(db, account, mediaId, parent);
    const payload = { title: media.title, durationMs: media.duration_ms, positionMs: position, scope, question, transcriptId: context.transcriptId,
      transcriptModel: context.model ?? 'unknown', segments: context.segments, history, ...(context.retrieval ? { retrieval: context.retrieval } : {}) };
    const turnId = randomUUID();
    const row = (await db.query(`INSERT INTO yuqu.chat_turns(id,conversation_id,user_id,request_id,sequence,media_version_id,transcript_id,position_ms,scope,question,context,parent_turn_id,topic_root_turn_id,anchor,request_intent)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [turnId, conversation.id, account.user.id, requestId, conversation.next_sequence, mediaId, context.transcriptId, position, scope, question, JSON.stringify(payload), parent?.id ?? null,
        parent ? (parent.topic_root_turn_id ?? parent.id) : turnId, anchor ? JSON.stringify(anchor) : null, JSON.stringify(intent)])).rows[0];
    await db.query('UPDATE yuqu.chat_conversations SET next_sequence=next_sequence+1 WHERE id=$1', [conversation.id]);
    if (context.retrieval?.status === 'no-evidence') return view((await db.query("UPDATE yuqu.chat_turns SET status='complete',answer=$2,updated_at=now() WHERE id=$1 RETURNING *", [turnId, NO_RETRIEVAL_EVIDENCE])).rows[0]);
    return view(row);
  });
}
export async function changeChat(pool: Pool, account: AccountSession, turnId: string, action: 'retry' | 'cancel'): Promise<ChatTurn> {
  uuid(turnId);
  return transaction(pool, async db => {
    await requireSession(db, account);
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR UPDATE', [account.user.id]);
    const row = (await db.query('SELECT * FROM yuqu.chat_turns WHERE id=$1 AND user_id=$2 FOR UPDATE', [turnId, account.user.id])).rows[0];
    if (!row) throw new AppError(404, 'CHAT_NOT_FOUND', '对话不存在。');
    if (action === 'cancel') {
      if (!['queued','running'].includes(row.status)) return view(row);
      return view((await db.query("UPDATE yuqu.chat_turns SET status='cancelled',lease_id=NULL,lease_until=NULL,error='已取消生成。',updated_at=now() WHERE id=$1 RETURNING *", [turnId])).rows[0]);
    }
    if (!['failed','cancelled'].includes(row.status)) return view(row);
    if (Date.now() - row.updated_at.getTime() < 3000) throw new AppError(429, 'CHAT_RETRY_WAIT', '请稍等几秒再重试。');
    await ensureNoPending(db, row.conversation_id, account.user.id);
    return view((await db.query("UPDATE yuqu.chat_turns SET status='queued',answer='',citations='[]',attempts=0,agent_id=NULL,lease_id=NULL,lease_until=NULL,event_sequence=0,error=NULL,updated_at=now() WHERE id=$1 RETURNING *", [turnId])).rows[0]);
  });
}

export interface BridgeAccount { agentId: string; projectId: string }
export async function bridgeSeen(pool: Pool, agent: BridgeAccount, taskTypes?: string[]): Promise<void> {
  await pool.query(`INSERT INTO yuqu.bridge_presence(project_id,last_seen,task_types) VALUES($1,now(),COALESCE($2::jsonb,'["yuqu.chat.answer.v1"]'::jsonb))
    ON CONFLICT(project_id) DO UPDATE SET last_seen=now(),task_types=COALESCE($2::jsonb,yuqu.bridge_presence.task_types)`, [agent.projectId, taskTypes ? JSON.stringify(taskTypes) : null]);
}
export async function claimChat(pool: Pool, agent: BridgeAccount, acceptedTaskTypes: string[] = ['yuqu.chat.answer.v1']): Promise<Record<string, unknown> | null> {
  return transaction(pool, async db => {
    await db.query("UPDATE yuqu.chat_turns SET status='failed',error='回答任务多次中断，请重试。',lease_id=NULL,lease_until=NULL,updated_at=now() WHERE status='running' AND lease_until<now() AND attempts>=3");
    const row = (await db.query("SELECT * FROM yuqu.chat_turns WHERE (status='queued' OR (status='running' AND lease_until<now())) AND attempts<3 AND ((scope='retrieval' AND $1::boolean) OR (scope<>'retrieval' AND $2::boolean)) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1", [acceptedTaskTypes.includes(RETRIEVAL_TASK_TYPE), acceptedTaskTypes.includes('yuqu.chat.answer.v1')])).rows[0];
    if (!row) return null;
    const leaseId = randomUUID();
    const leased = (await db.query("UPDATE yuqu.chat_turns SET status='running',attempts=attempts+1,agent_id=$2,lease_id=$3,lease_until=now()+interval '120 seconds',answer='',citations='[]',event_sequence=0,error=NULL,updated_at=now() WHERE id=$1 RETURNING *", [row.id, agent.agentId, leaseId])).rows[0];
    return { protocolVersion: '1.0', projectId: agent.projectId, jobId: row.id, taskType: row.scope === 'retrieval' ? RETRIEVAL_TASK_TYPE : 'yuqu.chat.answer.v1', attempt: leased.attempts,
      lease: { id: leaseId, expiresAt: leased.lease_until.toISOString() }, payload: row.context, artifacts: [] };
  });
}
async function activeTurn(db: PoolClient, agent: BridgeAccount, id: string, leaseId: string) {
  uuid(id); uuid(leaseId);
  const row = (await db.query("SELECT * FROM yuqu.chat_turns WHERE id=$1 AND agent_id=$2 AND lease_id=$3 AND status='running' AND lease_until>now() FOR UPDATE", [id, agent.agentId, leaseId])).rows[0];
  if (!row) throw new AppError(409, 'LEASE_LOST', '任务已结束或租约已失效。');
  return row;
}
export async function heartbeatChat(pool: Pool, agent: BridgeAccount, id: string, leaseId: string) {
  return transaction(pool, async db => {
    await activeTurn(db, agent, id, leaseId);
    const row = (await db.query("UPDATE yuqu.chat_turns SET lease_until=now()+interval '120 seconds' WHERE id=$1 RETURNING lease_until", [id])).rows[0];
    return { expiresAt: row.lease_until.toISOString(), cancelled: false };
  });
}
export async function streamChat(pool: Pool, agent: BridgeAccount, id: string, input: unknown): Promise<void> {
  const value = object(input), leaseId = uuid(value.leaseId), sequence = value.sequence, text = value.text;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1 || (sequence as number) > 2000 || typeof text !== 'string' || text.length > 24000) throw invalid('回答事件无效。');
  await transaction(pool, async db => {
    const row = await activeTurn(db, agent, id, leaseId);
    if (row.event_sequence === sequence && row.answer === text) return;
    if (sequence !== row.event_sequence + 1 || !text.startsWith(row.answer)) throw new AppError(409, 'EVENT_CONFLICT', '回答事件顺序无效。');
    await db.query('UPDATE yuqu.chat_turns SET answer=$2,event_sequence=$3,updated_at=now() WHERE id=$1', [id, text, sequence]);
  });
}
export async function finishChat(pool: Pool, agent: BridgeAccount, id: string, input: unknown): Promise<void> {
  const value = object(input), leaseId = uuid(value.leaseId), result = object(value.result);
  if (typeof result.answer !== 'string' || !result.answer.trim() || result.answer.length > 24000) throw invalid('回答内容无效。');
  await transaction(pool, async db => {
    // Completion retries are idempotent, but only for the same agent, lease and answer.
    const existing = (await db.query('SELECT * FROM yuqu.chat_turns WHERE id=$1 FOR UPDATE', [uuid(id)])).rows[0];
    if (existing?.status === 'complete' && existing.agent_id === agent.agentId && existing.lease_id === leaseId && existing.answer === result.answer) return;
    const row = await activeTurn(db, agent, id, leaseId);
    if (!(result.answer as string).startsWith(row.answer)) throw invalid('回答与已发送片段不一致。');
    const segments: ChatCitation[] = row.context.segments;
    const citations = answerCitations(result.answer as string, segments);
    if (row.scope === 'retrieval' && citations.length === 0) throw invalid('检索回答缺少原文引用，请重试生成。');
    await db.query("UPDATE yuqu.chat_turns SET status='complete',answer=$2,citations=$3,lease_until=NULL,error=NULL,updated_at=now() WHERE id=$1", [id, result.answer, JSON.stringify(citations)]);
  });
}
export async function failChat(pool: Pool, agent: BridgeAccount, id: string, leaseId: string): Promise<void> {
  await transaction(pool, async db => {
    await activeTurn(db, agent, id, leaseId);
    await db.query("UPDATE yuqu.chat_turns SET status='failed',lease_id=NULL,lease_until=NULL,error='回答中断，已保留问题和已收到的内容；可以重试。',updated_at=now() WHERE id=$1", [id]);
  });
}
