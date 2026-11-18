import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { AccountSession, SummariesPage, SummaryDocument, SummaryEvidence, SummaryResult, SummaryTopicPage } from '@yuqu/contracts';
import { requireSession } from './auth.ts';
import { transaction } from './database.ts';
import { authorizedMedia } from './library.ts';
import { readSnapshot } from './knowledge.ts';
import { AppError } from './errors.ts';
import { integer, invalid, object, uuid } from './validation.ts';
import type { BridgeAccount } from './chat.ts';
import { summaryPlan, summaryInput, resolveSummary, SUMMARY_PART_TASK, SUMMARY_OVERVIEW_TASK, SUMMARY_STRATEGY,
  type SummaryPlanNode, type ResolvedSummary, type FrozenSummaryInput } from './summary-segments.ts';
export { SUMMARY_PART_TASK, SUMMARY_OVERVIEW_TASK } from './summary-segments.ts';
import { TOPIC_SUMMARY_STRATEGY, SUMMARY_PART_V2_TASK, SUMMARY_OVERVIEW_V2_TASK, topicSummaryPlan, topicSummaryInput,
  resolveTopicPart, resolveTopicOverview, type FrozenTopicInput, type ResolvedTopics } from './summary-topics.ts';
export { SUMMARY_TOPICS_CAPABILITY, SUMMARY_PART_V2_TASK, SUMMARY_OVERVIEW_V2_TASK } from './summary-topics.ts';

type Row = Record<string, any>;
function documentView(row: Row, nodes: Row[]): SummaryDocument {
  if (!nodes.length) throw new Error('Summary document has no tasks');
  const status = nodes.some(node => node.status === 'failed') ? 'failed'
    : nodes.some(node => node.status === 'cancelled') ? 'cancelled'
    : nodes.every(node => node.status === 'complete') ? 'complete'
    : nodes.some(node => node.status === 'running') ? 'running' : 'queued';
  return { id: row.id, snapshot: { transcriptJobId: row.transcript_id, throughMs: row.through_ms }, status,
    ...(row.strategy === TOPIC_SUMMARY_STRATEGY ? { format: 'topics-v1' as const } : {}),
    completedParts: nodes.filter(node => node.level === 0 && node.status === 'complete').length, totalParts: row.total_parts,
    completedTasks: nodes.filter(node => node.status === 'complete').length, totalTasks: nodes.length, createdAt: row.created_at.toISOString() };
}
function resultView(row: Row): SummaryResult {
  const result = row.result as { title: string; points: Array<{ text: string; citations?: unknown[]; evidenceCount?: number }> };
  return { id: row.id, title: result.title, startMs: row.start_ms, endMs: row.end_ms,
    points: result.points.map(point => ({ text: point.text, evidenceCount: point.evidenceCount ?? point.citations!.length })) };
}
async function pageFor(db: PoolClient, account: AccountSession, mediaId: string, documentId?: string, after = 0, supportsTopics = false): Promise<SummariesPage> {
  const media = await authorizedMedia(db, account, mediaId);
  const source = (await db.query('SELECT id,status,completed_ms FROM yuqu.transcript_jobs WHERE user_id=$1 AND media_version_id=$2', [account.user.id, mediaId])).rows[0];
  const online = (await db.query("SELECT 1 FROM yuqu.bridge_presence WHERE project_id=$1 AND last_seen>now()-interval '60 seconds' AND task_types @> $2::jsonb", [process.env.YUQU_BRIDGE_PROJECT_ID || 'yuqu', JSON.stringify(supportsTopics ? [SUMMARY_PART_V2_TASK, SUMMARY_OVERVIEW_V2_TASK] : [SUMMARY_PART_TASK, SUMMARY_OVERVIEW_TASK])])).rowCount! > 0;
  const row = (await db.query('SELECT * FROM yuqu.summary_documents WHERE user_id=$1 AND media_version_id=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at DESC,id DESC LIMIT 1', [account.user.id, mediaId, documentId ?? null])).rows[0];
  if (documentId && !row) throw new AppError(404, 'SUMMARY_NOT_FOUND', '总结记录不存在。');
  if (row?.strategy === TOPIC_SUMMARY_STRATEGY && !supportsTopics) throw new AppError(409, 'CLIENT_UPGRADE_REQUIRED', '请更新客户端以查看按主题整理的完整总结。');
  const result: SummariesPage = { mediaVersionId: mediaId, audioAvailable: media.audio_available, bridgeOnline: online,
    canGenerate: source?.status === 'ready' && source.completed_ms === media.duration_ms && (!row || row.transcript_id !== source.id || row.through_ms !== source.completed_ms || row.strategy !== (supportsTopics ? TOPIC_SUMMARY_STRATEGY : SUMMARY_STRATEGY)),
    document: null, overview: null, parts: [], nextAfter: null };
  if (!row) return result;
  // Polling reads status metadata and one bounded result page, never all frozen sources.
  const nodes = (await db.query('SELECT node_index,level,status FROM yuqu.summary_nodes WHERE document_id=$1 ORDER BY node_index', [row.id])).rows;
  result.document = documentView(row, nodes);
  if (['queued', 'running'].includes(result.document.status)) result.canGenerate = false;
  const parts = (await db.query(`SELECT id,node_index,start_ms,end_ms,jsonb_build_object('title',result->'title',
    'points',(SELECT jsonb_agg(jsonb_build_object('text',p->'text','evidenceCount',jsonb_array_length(p->'citations')) ORDER BY ordinality)
      FROM jsonb_array_elements(result->'points') WITH ORDINALITY AS points(p,ordinality))) AS result
    FROM yuqu.summary_nodes WHERE document_id=$1 AND level=0 AND status='complete' AND node_index>=$2 ORDER BY node_index LIMIT 9`, [row.id, after])).rows;
  result.parts = parts.slice(0, 8).map(part => ({ ...resultView(part), index: part.node_index }));
  result.nextAfter = parts.length > 8 ? parts[7].node_index + 1 : null;
  if (result.document.status === 'complete') {
    if (row.strategy === TOPIC_SUMMARY_STRATEGY) {
      const root = (await db.query(`SELECT id,result->>'title' AS title,
        (SELECT jsonb_agg(jsonb_build_object('index',ordinality-1,'title',topic->>'title','pointCount',jsonb_array_length(topic->'points')) ORDER BY ordinality)
         FROM jsonb_array_elements(result->'topics') WITH ORDINALITY AS t(topic,ordinality)) AS topics
        FROM yuqu.summary_nodes WHERE document_id=$1 AND node_index=$2 AND status='complete'`, [row.id, row.root_index])).rows[0];
      if (!root) throw new Error('Completed topic summary root missing');
      result.topicOverview = { id: root.id, title: root.title, topics: root.topics };
      return result;
    }
    const root = (await db.query("SELECT id,start_ms,end_ms,result FROM yuqu.summary_nodes WHERE document_id=$1 AND node_index=$2 AND status='complete'", [row.id, row.root_index])).rows[0];
    if (!root) throw new Error('Completed summary root missing');
    result.overview = resultView(root);
  }
  return result;
}
export async function summariesPage(pool: Pool, account: AccountSession, mediaId: string, documentId?: string, after = 0, supportsTopics = false): Promise<SummariesPage> {
  if (documentId) uuid(documentId); integer(after, 0, 127);
  if (after && !documentId) throw invalid('继续查看总结时需要原总结记录。');
  return transaction(pool, async db => { await requireSession(db, account); return pageFor(db, account, mediaId, documentId, after, supportsTopics); });
}
async function checkActiveLimit(db: PoolClient, account: AccountSession, except?: string) {
  const active = (await db.query(`SELECT count(*)::int AS n FROM yuqu.summary_documents d WHERE user_id=$1 AND ($2::uuid IS NULL OR id<>$2)
    AND EXISTS(SELECT 1 FROM yuqu.summary_nodes n WHERE n.document_id=d.id AND n.status IN ('queued','running'))
    AND NOT EXISTS(SELECT 1 FROM yuqu.summary_nodes n WHERE n.document_id=d.id AND n.status IN ('failed','cancelled'))`, [account.user.id, except ?? null])).rows[0].n;
  if (active >= 2) throw new AppError(429, 'SUMMARY_LIMIT', '已有两期总结等待生成，请先等待或停止其中一期。');
}
export async function generateSummary(pool: Pool, account: AccountSession, mediaId: string, input: unknown, supportsTopics = false): Promise<SummariesPage> {
  const requestId = uuid(object(input).requestId);
  return transaction(pool, async db => {
    await requireSession(db, account);
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [account.user.id]);
    await authorizedMedia(db, account, mediaId);
    const existing = (await db.query('SELECT id,media_version_id FROM yuqu.summary_documents WHERE user_id=$1 AND request_id=$2', [account.user.id, requestId])).rows[0];
    if (existing) {
      if (existing.media_version_id !== mediaId) throw new AppError(409, 'REQUEST_REUSED', '这次提交标识已用于其他资料。');
      return pageFor(db, account, mediaId, existing.id, 0, supportsTopics);
    }
    const context = await readSnapshot(db, account, mediaId);
    if (context.transcript.status !== 'ready' || context.snapshot.throughMs !== context.media.duration_ms) throw new AppError(409, 'TRANSCRIPT_PENDING', '整期文稿完成后才能生成分段与整期总结。');
    const strategy = supportsTopics ? TOPIC_SUMMARY_STRATEGY : SUMMARY_STRATEGY;
    const previous = (await db.query('SELECT id FROM yuqu.summary_documents WHERE user_id=$1 AND transcript_id=$2 AND through_ms=$3 AND strategy=$4', [account.user.id, context.transcript.id, context.snapshot.throughMs, strategy])).rows[0];
    if (previous) return pageFor(db, account, mediaId, previous.id, 0, supportsTopics);
    await checkActiveLimit(db, account);
    const plan = supportsTopics ? topicSummaryPlan(context.segments) : summaryPlan(context.segments), id = randomUUID();
    await db.query('INSERT INTO yuqu.summary_documents(id,user_id,media_version_id,transcript_id,request_id,title,through_ms,total_parts,root_index,strategy) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, account.user.id, mediaId, context.transcript.id, requestId, context.media.title, context.snapshot.throughMs, plan.totalParts, plan.rootIndex, strategy]);
    const records = plan.nodes.map(node => ({ id: randomUUID(), document_id: id, node_index: node.index, level: node.level,
      group_index: node.groupIndex, group_count: node.groupCount, child_indexes: node.children, source_segments: node.segments, start_ms: node.startMs, end_ms: node.endMs }));
    await db.query(`INSERT INTO yuqu.summary_nodes(id,document_id,node_index,level,group_index,group_count,child_indexes,source_segments,start_ms,end_ms)
      SELECT id,document_id,node_index,level,group_index,group_count,child_indexes,NULLIF(source_segments,'null'::jsonb),start_ms,end_ms FROM jsonb_to_recordset($1::jsonb)
      AS x(id uuid,document_id uuid,node_index integer,level integer,group_index integer,group_count integer,child_indexes integer[],source_segments jsonb,start_ms integer,end_ms integer)`, [JSON.stringify(records)]);
    return pageFor(db, account, mediaId, id, 0, supportsTopics);
  });
}
export async function changeSummary(pool: Pool, account: AccountSession, mediaId: string, id: string, action: 'retry' | 'cancel', supportsTopics = false): Promise<SummariesPage> {
  uuid(id);
  return transaction(pool, async db => {
    await requireSession(db, account);
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [account.user.id]);
    await authorizedMedia(db, account, mediaId);
    const row = (await db.query('SELECT id FROM yuqu.summary_documents WHERE id=$1 AND user_id=$2 AND media_version_id=$3 FOR UPDATE', [id, account.user.id, mediaId])).rows[0];
    if (!row) throw new AppError(404, 'SUMMARY_NOT_FOUND', '总结记录不存在。');
    if (action === 'cancel') await db.query("UPDATE yuqu.summary_nodes SET status='cancelled',lease_id=NULL,lease_until=NULL,updated_at=now() WHERE document_id=$1 AND status IN ('queued','running','failed')", [id]);
    else {
      await checkActiveLimit(db, account, id);
      await db.query("UPDATE yuqu.summary_nodes SET status='queued',attempts=0,agent_id=NULL,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE document_id=$1 AND status IN ('failed','cancelled')", [id]);
    }
    return pageFor(db, account, mediaId, id, 0, supportsTopics);
  });
}
export async function summaryEvidence(pool: Pool, account: AccountSession, mediaId: string, documentId: string, nodeId: string, pointIndex: number): Promise<SummaryEvidence> {
  uuid(documentId); uuid(nodeId); integer(pointIndex, 0, 11);
  return transaction(pool, async db => {
    await requireSession(db, account); const media = await authorizedMedia(db, account, mediaId);
    const row = (await db.query(`SELECT n.status,n.result,n.level,d.strategy,d.transcript_id,d.through_ms FROM yuqu.summary_nodes n JOIN yuqu.summary_documents d ON d.id=n.document_id
      WHERE n.id=$1 AND d.id=$2 AND d.user_id=$3 AND d.media_version_id=$4`, [nodeId, documentId, account.user.id, mediaId])).rows[0];
    if (!row) throw new AppError(404, 'SUMMARY_NOT_FOUND', '总结依据不存在。');
    if (row.status !== 'complete') throw new AppError(409, 'SUMMARY_PENDING', '这部分总结尚未完成。');
    if (row.strategy !== TOPIC_SUMMARY_STRATEGY) integer(pointIndex, 0, 5);
    else if (row.level !== 0) throw invalid('请从主题要点读取原文依据。');
    const point = (row.result as ResolvedSummary).points[pointIndex];
    if (!point) throw invalid('总结要点不存在。');
    return { mediaVersionId: mediaId, documentId, nodeId, pointIndex, audioAvailable: media.audio_available,
      snapshot: { transcriptJobId: row.transcript_id, throughMs: row.through_ms }, segments: point.citations.map(({ order: _, ...citation }) => citation) };
  });
}
export async function summaryTopicPage(pool: Pool, account: AccountSession, mediaId: string, documentId: string, topicIndex: number, after = 0): Promise<SummaryTopicPage> {
  uuid(documentId); integer(topicIndex, 0, 11); integer(after, 0, 1535);
  return transaction(pool, async db => {
    await requireSession(db, account); await authorizedMedia(db, account, mediaId);
    const row = (await db.query(`SELECT n.status,d.strategy,d.transcript_id,d.through_ms,n.result->'topics'->($3::integer) AS topic
      FROM yuqu.summary_documents d JOIN yuqu.summary_nodes n ON n.document_id=d.id AND n.node_index=d.root_index
      WHERE d.id=$1 AND d.user_id=$2 AND d.media_version_id=$4`, [documentId, account.user.id, topicIndex, mediaId])).rows[0];
    if (!row) throw new AppError(404, 'SUMMARY_NOT_FOUND', '总结主题不存在。');
    if (row.status !== 'complete') throw new AppError(409, 'SUMMARY_PENDING', '整期总结尚未完成。');
    if (row.strategy !== TOPIC_SUMMARY_STRATEGY || !row.topic || after >= row.topic.points.length) throw invalid('总结主题或页码无效。');
    const points = row.topic.points as ResolvedTopics['topics'][number]['points'];
    return { mediaVersionId: mediaId, documentId, topicIndex, title: row.topic.title,
      snapshot: { transcriptJobId: row.transcript_id, throughMs: row.through_ms },
      points: points.slice(after, after + 20).map(({ order: _, ...point }) => point), after,
      nextAfter: after + 20 < points.length ? after + 20 : null, totalPoints: points.length };
  });
}
export async function isSummaryTask(pool: Pool, id: string): Promise<boolean> {
  return (await pool.query('SELECT 1 FROM yuqu.summary_nodes WHERE id=$1', [uuid(id)])).rowCount! > 0;
}
export async function claimSummary(pool: Pool, agent: BridgeAccount, accepted: string[]): Promise<Record<string, unknown> | null> {
  return transaction(pool, async db => {
    await db.query("UPDATE yuqu.summary_nodes SET status='failed',lease_id=NULL,lease_until=NULL,updated_at=now() WHERE status='running' AND lease_until<now() AND attempts>=3");
    const row = (await db.query(`SELECT n.*,d.strategy AS summary_strategy FROM yuqu.summary_nodes n JOIN yuqu.summary_documents d ON d.id=n.document_id
      WHERE (n.status='queued' OR (n.status='running' AND n.lease_until<now())) AND n.attempts<3
      AND ((d.strategy<>$5 AND ((n.level=0 AND $1::boolean) OR (n.level>0 AND $2::boolean)))
        OR (d.strategy=$5 AND ((n.level=0 AND $3::boolean) OR (n.level>0 AND $4::boolean))))
      AND NOT EXISTS(SELECT 1 FROM yuqu.summary_nodes prior WHERE prior.document_id=n.document_id AND prior.node_index<n.node_index AND prior.status<>'complete')
      ORDER BY d.created_at,n.node_index FOR UPDATE OF n SKIP LOCKED LIMIT 1`, [accepted.includes(SUMMARY_PART_TASK), accepted.includes(SUMMARY_OVERVIEW_TASK),
      accepted.includes(SUMMARY_PART_V2_TASK), accepted.includes(SUMMARY_OVERVIEW_V2_TASK), TOPIC_SUMMARY_STRATEGY])).rows[0];
    if (!row) return null;
    const topics = row.summary_strategy === TOPIC_SUMMARY_STRATEGY;
    let input = row.input as FrozenSummaryInput | FrozenTopicInput | null;
    if (!input) {
      const doc = (await db.query('SELECT * FROM yuqu.summary_documents WHERE id=$1', [row.document_id])).rows[0];
      const children = row.level ? (await db.query("SELECT id,level,node_index,result FROM yuqu.summary_nodes WHERE document_id=$1 AND node_index=ANY($2::integer[]) AND status='complete' ORDER BY node_index", [doc.id, row.child_indexes])).rows : [];
      const node: SummaryPlanNode = { index: row.node_index, level: row.level, groupIndex: row.group_index, groupCount: row.group_count,
        children: row.child_indexes, segments: row.source_segments, startMs: row.start_ms, endMs: row.end_ms };
      const base = { title: doc.title, durationMs: doc.through_ms, transcriptId: doc.transcript_id, throughMs: doc.through_ms };
      input = topics ? topicSummaryInput(base, node, row.node_index === doc.root_index, children.map(child => ({ id: child.id, level: child.level, result: child.result })))
        : summaryInput(base, node, row.node_index === doc.root_index, children.map(child => child.result));
    }
    const leaseId = randomUUID();
    const leased = (await db.query("UPDATE yuqu.summary_nodes SET status='running',attempts=attempts+1,agent_id=$2,lease_id=$3,lease_until=now()+interval '120 seconds',input=$4,updated_at=now() WHERE id=$1 RETURNING attempts,lease_until", [row.id, agent.agentId, leaseId, JSON.stringify(input)])).rows[0];
    return { protocolVersion: '1.0', projectId: agent.projectId, jobId: row.id,
      taskType: topics ? (row.level === 0 ? SUMMARY_PART_V2_TASK : SUMMARY_OVERVIEW_V2_TASK) : (row.level === 0 ? SUMMARY_PART_TASK : SUMMARY_OVERVIEW_TASK),
      attempt: leased.attempts, lease: { id: leaseId, expiresAt: leased.lease_until.toISOString() }, payload: input.payload, artifacts: [] };
  });
}
async function activeNode(db: PoolClient, agent: BridgeAccount, id: string, leaseId: string) {
  const row = (await db.query("SELECT * FROM yuqu.summary_nodes WHERE id=$1 AND agent_id=$2 AND lease_id=$3 AND status='running' AND lease_until>now() FOR UPDATE", [uuid(id), agent.agentId, uuid(leaseId)])).rows[0];
  if (!row) throw new AppError(409, 'LEASE_LOST', '总结任务已结束或租约已失效。');
  return row;
}
export async function heartbeatSummary(pool: Pool, agent: BridgeAccount, id: string, leaseId: string) {
  return transaction(pool, async db => {
    await activeNode(db, agent, id, leaseId);
    const row = (await db.query("UPDATE yuqu.summary_nodes SET lease_until=now()+interval '120 seconds' WHERE id=$1 RETURNING lease_until", [id])).rows[0];
    return { expiresAt: row.lease_until.toISOString(), cancelled: false };
  });
}
export async function finishSummary(pool: Pool, agent: BridgeAccount, id: string, value: unknown): Promise<void> {
  const input = object(value), leaseId = uuid(input.leaseId), result = object(input.result);
  await transaction(pool, async db => {
    const existing = (await db.query('SELECT * FROM yuqu.summary_nodes WHERE id=$1 FOR UPDATE', [uuid(id)])).rows[0];
    if (existing?.status === 'complete' && existing.agent_id === agent.agentId && existing.lease_id === leaseId && isDeepStrictEqual(existing.result_input, result)) return;
    const row = await activeNode(db, agent, id, leaseId);
    const frozen = row.input as FrozenSummaryInput | FrozenTopicInput;
    const resolved = 'format' in frozen && frozen.format === 'topics-v1'
      ? (frozen.kind === 'part' ? resolveTopicPart(result, frozen) : resolveTopicOverview(result, frozen))
      : resolveSummary(result, frozen as FrozenSummaryInput, row.level);
    await db.query("UPDATE yuqu.summary_nodes SET status='complete',result=$2,result_input=$3,lease_until=NULL,updated_at=now() WHERE id=$1", [id, JSON.stringify(resolved), JSON.stringify(result)]);
  });
}
export async function failSummary(pool: Pool, agent: BridgeAccount, id: string, leaseId: string): Promise<void> {
  await transaction(pool, async db => {
    await activeNode(db, agent, id, leaseId);
    await db.query("UPDATE yuqu.summary_nodes SET status='failed',lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [id]);
  });
}
