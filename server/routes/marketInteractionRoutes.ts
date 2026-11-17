import { Router } from 'express';
import { randomUUID } from 'crypto';
import { AmmDatabase } from '../db';
import {
  AuthenticatedRequest,
  optionalSupabaseRequest,
  rateLimit,
  requireAdminMiddleware,
  verifySupabaseRequest,
} from '../auth';
import {
  createSupabaseDoc,
  deleteSupabaseDoc,
  fetchSupabaseDoc,
  getFreshSupabaseBalanceCents,
  patchSupabaseFields,
  recordSupabaseLedgerEntry,
  updateSupabaseUserBalanceCents,
} from '../supabaseSync';
import { markUserBalanceSynced, reconcileUserClobBalance } from '../clobEngine';
import { SUPABASE_URL, getSupabaseRestHeaders, isServerSupabaseConfigured } from '../supabaseConfig';

let multiTradeLock: Promise<void> = Promise.resolve();
function withMultiTradeLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = multiTradeLock;
  let release!: () => void;
  multiTradeLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

async function tryFetchSupabaseRows(table: string, query: string): Promise<any[] | null> {
  if (!isServerSupabaseConfigured) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: getSupabaseRestHeaders(),
    });
    if (!resp.ok) return null;
    const rows = (await resp.json()) as any[];
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

export function createMarketInteractionRouter(db: AmmDatabase): Router {
  const router = Router();

  // --- GET ALL INTERACTION STATE FOR A MARKET ---
  router.get(
    '/markets/:marketId/interactions',
    optionalSupabaseRequest,
    rateLimit(90, 10_000),
    async (req: AuthenticatedRequest, res) => {
      try {
        const marketId = String(req.params.marketId || '').trim();
        const uid = req.actor?.uid || null;

        // 1. Bookmarks (merge SQLite + Supabase)
        const sqlBookmarkCountRow = db
          .prepare(`SELECT COUNT(*) as c FROM market_bookmarks WHERE market_id = ?`)
          .get(marketId) as { c: number } | undefined;
        const sqlMyBookmarkRow = uid
          ? db.prepare(`SELECT 1 as ok FROM market_bookmarks WHERE user_id = ? AND market_id = ?`).get(uid, marketId)
          : null;
        const sbBookmarks = await tryFetchSupabaseRows(
          'market_bookmarks',
          `market_id=eq.${encodeURIComponent(marketId)}&select=user_id`
        );
        const bookmarkUserSet = new Set<string>();
        for (const b of sbBookmarks || []) {
          if (b.user_id) bookmarkUserSet.add(String(b.user_id));
        }
        const bookmarkCount = Math.max(Number(sqlBookmarkCountRow?.c || 0), bookmarkUserSet.size);
        const bookmarked = Boolean(sqlMyBookmarkRow || (uid && bookmarkUserSet.has(uid)));

        // 2. Metadata overrides (SQLite + Supabase markets fallback)
        const metaRow = db
          .prepare(`SELECT * FROM market_metadata_overrides WHERE market_id = ?`)
          .get(marketId) as any;
        let resolvedMeta = metaRow || null;
        if (!resolvedMeta) {
          const sbMarkets = await tryFetchSupabaseRows(
            'markets',
            `id=eq.${encodeURIComponent(marketId)}&select=additional_context,additional_context_updated_at,resolver_name,resolver_address,description&limit=1`
          );
          const sbM = sbMarkets?.[0];
          if (sbM && (sbM.additional_context || sbM.resolver_name || sbM.resolver_address)) {
            resolvedMeta = {
              market_id: marketId,
              additional_context: sbM.additional_context || null,
              additional_context_updated_at: sbM.additional_context_updated_at || null,
              resolver_name: sbM.resolver_name || null,
              resolver_address: sbM.resolver_address || null,
              description_override: null,
            };
          }
        }

        // 3. Resolution Proposals (merge SQLite + Supabase if table exists)
        const sqlProposals = db
          .prepare(`SELECT * FROM market_resolution_proposals WHERE market_id = ? ORDER BY created_at DESC LIMIT 30`)
          .all(marketId) as any[];
        const sbProposals = await tryFetchSupabaseRows(
          'market_resolution_proposals',
          `market_id=eq.${encodeURIComponent(marketId)}&order=created_at.desc&limit=30`
        );
        const proposalsMap = new Map<string, any>();
        for (const p of sbProposals || []) proposalsMap.set(p.id, p);
        for (const p of sqlProposals) if (!proposalsMap.has(p.id)) proposalsMap.set(p.id, p);
        const proposals = Array.from(proposalsMap.values()).sort(
          (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
        );

        // 4. Custom FAQs
        const sqlFaqs = db
          .prepare(`SELECT * FROM market_faqs WHERE market_id = ? ORDER BY sort_order ASC, created_at ASC LIMIT 30`)
          .all(marketId) as any[];
        const sbFaqs = await tryFetchSupabaseRows(
          'market_faqs',
          `market_id=eq.${encodeURIComponent(marketId)}&order=sort_order.asc&limit=30`
        );
        const faqsMap = new Map<string, any>();
        for (const f of sbFaqs || []) faqsMap.set(f.id, f);
        for (const f of sqlFaqs) if (!faqsMap.has(f.id)) faqsMap.set(f.id, f);
        const faqs = Array.from(faqsMap.values()).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

        // 5. Comment Likes map (merge SQLite + Supabase comment_likes)
        const likeCounts = db
          .prepare(
            `SELECT l.comment_id, COUNT(*) as count
             FROM market_comment_likes l
             GROUP BY l.comment_id`
          )
          .all() as Array<{ comment_id: string; count: number }>;
        const myLikedSet = new Set<string>();
        if (uid) {
          const myLikes = db
            .prepare(`SELECT comment_id FROM market_comment_likes WHERE user_id = ?`)
            .all(uid) as Array<{ comment_id: string }>;
          for (const ml of myLikes) myLikedSet.add(ml.comment_id);
        }
        const commentLikes: Record<string, { count: number; likedByMe: boolean }> = {};
        for (const lc of likeCounts) {
          commentLikes[lc.comment_id] = {
            count: Number(lc.count || 0),
            likedByMe: myLikedSet.has(lc.comment_id),
          };
        }

        const sbCommentLikes = await tryFetchSupabaseRows(
          'comment_likes',
          `select=comment_id,user_id&limit=1000`
        );
        if (sbCommentLikes && sbCommentLikes.length > 0) {
          const sbCounts = new Map<string, Set<string>>();
          for (const row of sbCommentLikes) {
            const cid = String(row.comment_id || '');
            const luid = String(row.user_id || '');
            if (!cid || !luid) continue;
            if (!sbCounts.has(cid)) sbCounts.set(cid, new Set());
            sbCounts.get(cid)!.add(luid);
          }
          for (const [cid, uidSet] of sbCounts.entries()) {
            const prev = commentLikes[cid];
            commentLikes[cid] = {
              count: Math.max(prev?.count || 0, uidSet.size),
              likedByMe: Boolean(prev?.likedByMe || (uid && uidSet.has(uid))),
            };
          }
        }

        // 6. Multi-outcome price history
        const sqlHist = db
          .prepare(`SELECT * FROM multi_outcome_price_history WHERE market_id = ? ORDER BY timestamp ASC LIMIT 500`)
          .all(marketId) as any[];
        const sbHist = await tryFetchSupabaseRows(
          'outcome_price_history',
          `market_id=eq.${encodeURIComponent(marketId)}&order=timestamp.asc&limit=500`
        );
        const outcomeHistory = (sbHist && sbHist.length >= sqlHist.length ? sbHist : sqlHist) || [];

        // 7. Multi-outcome positions & holders (merge SQLite + Supabase positions)
        const multiPositionsRows = db
          .prepare(
            `SELECT user_id, user_name, market_id, outcome_name, binary_side, shares, avg_price_cents, updated_at
             FROM multi_outcome_positions
             WHERE market_id = ? AND shares > 0
             ORDER BY shares DESC`
          )
          .all(marketId) as any[];

        const posMap = new Map<string, any>();
        for (const r of multiPositionsRows) {
          const key = `${r.user_id}_${r.outcome_name}_${r.binary_side}`;
          posMap.set(key, {
            id: `${r.user_id}_${r.market_id}_${r.outcome_name}_${r.binary_side}`,
            userId: r.user_id,
            userLabel: r.user_name || `Trader #${String(r.user_id).slice(0, 5)}`,
            outcome: r.outcome_name,
            binarySide: r.binary_side,
            shares: Number(r.shares || 0),
            avg_price: Number(((r.avg_price_cents || 50) / 100).toFixed(2)),
            updatedAt: r.updated_at,
          });
        }

        const sbMultiPos = await tryFetchSupabaseRows(
          'positions',
          `or=(market_id.eq.${encodeURIComponent(marketId)},marketId.eq.${encodeURIComponent(marketId)})&limit=500`
        );
        for (const sp of sbMultiPos || []) {
          const pShares = Number(sp.shares || 0);
          const pOutcomeRaw = String(sp.outcome || '');
          const pUserId = String(sp.user_id || sp.userId || '');
          if (pShares <= 0 || !pUserId) continue;
          const match = pOutcomeRaw.match(/^(.*)\s+\((Sim|Não)\)$/);
          if (match) {
            const oName = match[1].trim();
            const bSide = match[2] === 'Não' ? 'No' : 'Yes';
            const key = `${pUserId}_${oName}_${bSide}`;
            if (!posMap.has(key)) {
              posMap.set(key, {
                id: sp.id || key,
                userId: pUserId,
                userLabel: `Trader #${pUserId.slice(0, 5)}`,
                outcome: oName,
                binarySide: bSide,
                shares: pShares,
                avg_price: Number(sp.avg_price || 0.5),
                updatedAt: sp.updated_at || new Date().toISOString(),
              });
            }
          }
        }

        const multiPositions = Array.from(posMap.values()).sort((a, b) => b.shares - a.shares);
        const myMultiPositions = uid ? multiPositions.filter((p) => p.userId === uid) : [];

        res.json({
          bookmarked,
          bookmarkCount,
          metadata: resolvedMeta,
          proposals,
          faqs,
          commentLikes,
          outcomeHistory,
          multiPositions,
          myMultiPositions,
        });
      } catch (err: any) {
        res.status(500).json({ error: err?.message || 'Erro ao carregar interações do mercado.' });
      }
    }
  );

  // --- TOGGLE BOOKMARK ---
  router.post(
    '/markets/:marketId/bookmark',
    verifySupabaseRequest,
    rateLimit(30, 10_000),
    async (req: AuthenticatedRequest, res) => {
      try {
        const uid = req.actor!.uid;
        const marketId = String(req.params.marketId || '').trim();
        const existing = db
          .prepare(`SELECT 1 FROM market_bookmarks WHERE user_id = ? AND market_id = ?`)
          .get(uid, marketId);

        let bookmarked = false;
        if (existing) {
          db.prepare(`DELETE FROM market_bookmarks WHERE user_id = ? AND market_id = ?`).run(uid, marketId);
          bookmarked = false;
          if (isServerSupabaseConfigured) {
            fetch(
              `${SUPABASE_URL}/rest/v1/market_bookmarks?user_id=eq.${encodeURIComponent(uid)}&market_id=eq.${encodeURIComponent(marketId)}`,
              { method: 'DELETE', headers: getSupabaseRestHeaders(req.idToken) }
            ).catch(() => {});
          }
        } else {
          const now = new Date().toISOString();
          db.prepare(`INSERT OR IGNORE INTO market_bookmarks (user_id, market_id, created_at) VALUES (?, ?, ?)`).run(
            uid,
            marketId,
            now
          );
          bookmarked = true;
          const bId = `${marketId}_${uid}`.replace(/[^a-zA-Z0-9_-]/g, '_');
          createSupabaseDoc(req.idToken!, 'market_bookmarks', { user_id: uid, market_id: marketId, created_at: now }, bId, false).catch(() => {});
        }

        const countRow = db
          .prepare(`SELECT COUNT(*) as c FROM market_bookmarks WHERE market_id = ?`)
          .get(marketId) as { c: number };
        res.json({ bookmarked, bookmarkCount: Number(countRow?.c || 0) });
      } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Erro ao atualizar favorito.' });
      }
    }
  );

  // --- TOGGLE COMMENT LIKE ---
  router.post(
    '/markets/:marketId/comments/:commentId/like',
    verifySupabaseRequest,
    rateLimit(40, 10_000),
    async (req: AuthenticatedRequest, res) => {
      try {
        const uid = req.actor!.uid;
        const commentId = String(req.params.commentId || '').trim();
        const existing = db
          .prepare(`SELECT 1 FROM market_comment_likes WHERE comment_id = ? AND user_id = ?`)
          .get(commentId, uid);

        let liked = false;
        const likeDocId = `${commentId}_${uid}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        if (existing) {
          db.prepare(`DELETE FROM market_comment_likes WHERE comment_id = ? AND user_id = ?`).run(commentId, uid);
          liked = false;
          if (isServerSupabaseConfigured) {
            fetch(
              `${SUPABASE_URL}/rest/v1/comment_likes?comment_id=eq.${encodeURIComponent(commentId)}&user_id=eq.${encodeURIComponent(uid)}`,
              { method: 'DELETE', headers: getSupabaseRestHeaders(req.idToken) }
            ).catch(() => {});
          }
        } else {
          const now = new Date().toISOString();
          db.prepare(`INSERT OR IGNORE INTO market_comment_likes (comment_id, user_id, created_at) VALUES (?, ?, ?)`).run(
            commentId,
            uid,
            now
          );
          liked = true;
          createSupabaseDoc(
            req.idToken!,
            'comment_likes',
            { comment_id: commentId, user_id: uid, created_at: now },
            likeDocId,
            false
          ).catch(() => {});
        }

        const countRow = db
          .prepare(`SELECT COUNT(*) as c FROM market_comment_likes WHERE comment_id = ?`)
          .get(commentId) as { c: number };
        const count = Number(countRow?.c || 0);

        patchSupabaseFields(req.idToken!, 'comments', commentId, { likes: count }, false).catch(() => {});

        res.json({ commentId, liked, count });
      } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Erro ao reagir ao comentário.' });
      }
    }
  );

  // --- DELETE COMMENT (Author or Admin) ---
  router.delete(
    '/markets/:marketId/comments/:commentId',
    verifySupabaseRequest,
    rateLimit(20, 10_000),
    async (req: AuthenticatedRequest, res) => {
      try {
        const uid = req.actor!.uid;
        const isAdmin = req.actor!.role === 'MASTER_ADMIN' || req.actor!.role === 'OPERATIONAL_ADMIN';
        const commentId = String(req.params.commentId || '').trim();

        const commentDoc = await fetchSupabaseDoc(req.idToken!, 'comments', commentId).catch(() => null);
        if (!commentDoc) {
          throw new Error('Comentário não encontrado.');
        }
        if (commentDoc.user_id !== uid && !isAdmin) {
          res.status(403).json({ error: 'Sem permissão para remover este comentário.' });
          return;
        }

        await deleteSupabaseDoc(req.idToken!, 'comments', commentId);
        db.prepare(`DELETE FROM market_comment_likes WHERE comment_id = ?`).run(commentId);
        res.json({ deleted: true, commentId });
      } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Erro ao apagar comentário.' });
      }
    }
  );

  // --- SUBMIT RESOLUTION PROPOSAL ---
  router.post(
    '/markets/:marketId/resolution-proposals',
    verifySupabaseRequest,
    rateLimit(10, 30_000),
    async (req: AuthenticatedRequest, res) => {
      try {
        const uid = req.actor!.uid;
        const marketId = String(req.params.marketId || '').trim();
        const { proposedOutcome, evidenceUrl, rationale } = req.body || {};
        const cleanOutcome = String(proposedOutcome || '').trim();
        const cleanRationale = String(rationale || '').trim();
        const cleanEvidence = evidenceUrl ? String(evidenceUrl).trim() : null;

        if (!cleanOutcome) throw new Error('Selecione o resultado proposto.');
        if (cleanRationale.length < 10) throw new Error('Descreva a fundamentação com pelo menos 10 caracteres.');

        const userDoc = await fetchSupabaseDoc(req.idToken!, 'users', uid).catch(() => null);
        const userName = userDoc?.name || req.actor!.email?.split('@')[0] || 'Trader';
        const id = randomUUID();
        const now = new Date().toISOString();

        db.prepare(
          `INSERT INTO market_resolution_proposals
           (id, market_id, user_id, user_name, proposed_outcome, evidence_url, rationale, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        ).run(id, marketId, uid, userName, cleanOutcome, cleanEvidence, cleanRationale, now);

        createSupabaseDoc(
          req.idToken!,
          'market_resolution_proposals',
          {
            market_id: marketId,
            user_id: uid,
            user_name: userName,
            proposed_outcome: cleanOutcome,
            evidence_url: cleanEvidence,
            rationale: cleanRationale,
            status: 'pending',
            created_at: now,
          },
          id,
          false
        ).catch(() => {});

        res.json({
          proposal: {
            id,
            market_id: marketId,
            user_id: uid,
            user_name: userName,
            proposed_outcome: cleanOutcome,
            evidence_url: cleanEvidence,
            rationale: cleanRationale,
            status: 'pending',
            created_at: now,
          },
        });
      } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Erro ao submeter proposta de resolução.' });
      }
    }
  );

  // --- ADMIN: UPDATE MARKET RULES / ADDITIONAL CONTEXT / RESOLVER ---
  router.patch(
    '/markets/:marketId/metadata',
    verifySupabaseRequest,
    requireAdminMiddleware,
    rateLimit(20, 10_000),
    async (req: AuthenticatedRequest, res) => {
      try {
        const marketId = String(req.params.marketId || '').trim();
        const { additionalContext, description, resolverName, resolverAddress } = req.body || {};
        const now = new Date().toISOString();

        const existing = db
          .prepare(`SELECT * FROM market_metadata_overrides WHERE market_id = ?`)
          .get(marketId) as any;

        const nextContext =
          additionalContext !== undefined ? String(additionalContext).trim() : existing?.additional_context ?? null;
        const nextContextUpdated =
          additionalContext !== undefined ? now : existing?.additional_context_updated_at ?? now;
        const nextResolverName =
          resolverName !== undefined ? String(resolverName).trim() : existing?.resolver_name ?? 'MarketPay Oracle';
        const nextResolverAddress =
          resolverAddress !== undefined
            ? String(resolverAddress).trim()
            : existing?.resolver_address ?? 'mp_oracle_v1';
        const nextDesc =
          description !== undefined ? String(description).trim() : existing?.description_override ?? null;

        db.prepare(
          `INSERT INTO market_metadata_overrides
           (market_id, additional_context, additional_context_updated_at, resolver_name, resolver_address, description_override, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(market_id) DO UPDATE SET
             additional_context = excluded.additional_context,
             additional_context_updated_at = excluded.additional_context_updated_at,
             resolver_name = excluded.resolver_name,
             resolver_address = excluded.resolver_address,
             description_override = excluded.description_override,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`
        ).run(marketId, nextContext, nextContextUpdated, nextResolverName, nextResolverAddress, nextDesc, req.actor!.uid, now);

        const sbPatch: Record<string, any> = {};
        if (nextDesc !== null && description !== undefined) sbPatch.description = nextDesc;
        if (additionalContext !== undefined) {
          sbPatch.additional_context = nextContext;
          sbPatch.additional_context_updated_at = nextContextUpdated;
        }
        if (resolverName !== undefined) sbPatch.resolver_name = nextResolverName;
        if (resolverAddress !== undefined) sbPatch.resolver_address = nextResolverAddress;

        if (Object.keys(sbPatch).length > 0) {
          patchSupabaseFields(req.idToken!, 'markets', marketId, sbPatch, false).catch(() => {});
        }

        res.json({
          updated: true,
          metadata: {
            market_id: marketId,
            additional_context: nextContext,
            additional_context_updated_at: nextContextUpdated,
            resolver_name: nextResolverName,
            resolver_address: nextResolverAddress,
            description_override: nextDesc,
          },
        });
      } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Erro ao atualizar regras e contexto.' });
      }
    }
  );

  // --- ADMIN: ADD CUSTOM FAQ FOR A MARKET ---
  router.post(
    '/markets/:marketId/faqs',
    verifySupabaseRequest,
    requireAdminMiddleware,
    rateLimit(20, 10_000),
    async (req: AuthenticatedRequest, res) => {
      try {
        const marketId = String(req.params.marketId || '').trim();
        const question = String(req.body?.question || '').trim();
        const answer = String(req.body?.answer || '').trim();
        if (question.length < 5 || answer.length < 5) {
          throw new Error('Pergunta e resposta devem ter pelo menos 5 caracteres.');
        }

        const countRow = db
          .prepare(`SELECT COUNT(*) as c FROM market_faqs WHERE market_id = ?`)
          .get(marketId) as { c: number };
        const id = randomUUID();
        const now = new Date().toISOString();
        const sortOrder = Number(countRow?.c || 0);

        db.prepare(
          `INSERT INTO market_faqs (id, market_id, question, answer, sort_order, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id, marketId, question, answer, sortOrder, req.actor!.uid, now);

        createSupabaseDoc(
          req.idToken!,
          'market_faqs',
          { market_id: marketId, question, answer, sort_order: sortOrder, created_at: now },
          id,
          false
        ).catch(() => {});

        res.json({ faq: { id, market_id: marketId, question, answer, sort_order: sortOrder, created_at: now } });
      } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Erro ao adicionar pergunta frequente.' });
      }
    }
  );

  // --- ADMIN: DELETE CUSTOM FAQ ---
  router.delete(
    '/markets/:marketId/faqs/:faqId',
    verifySupabaseRequest,
    requireAdminMiddleware,
    rateLimit(20, 10_000),
    async (req: AuthenticatedRequest, res) => {
      try {
        const faqId = String(req.params.faqId || '').trim();
        db.prepare(`DELETE FROM market_faqs WHERE id = ?`).run(faqId);
        await deleteSupabaseDoc(req.idToken!, 'market_faqs', faqId);
        res.json({ deleted: true, faqId });
      } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Erro ao apagar pergunta frequente.' });
      }
    }
  );

  // --- ADMIN: ACCEPT OR REJECT RESOLUTION PROPOSAL ---
  router.patch(
    '/markets/:marketId/resolution-proposals/:proposalId',
    verifySupabaseRequest,
    requireAdminMiddleware,
    rateLimit(20, 10_000),
    async (req: AuthenticatedRequest, res) => {
      try {
        const proposalId = String(req.params.proposalId || '').trim();
        const nextStatus = String(req.body?.status || '').trim();
        if (!['accepted', 'rejected'].includes(nextStatus)) {
          throw new Error('Estado inválido para proposta (aceite: accepted ou rejected).');
        }
        db.prepare(`UPDATE market_resolution_proposals SET status = ?, reviewed_by = ? WHERE id = ?`).run(
          nextStatus,
          req.actor!.uid,
          proposalId
        );
        await patchSupabaseFields(
          req.idToken!,
          'market_resolution_proposals',
          proposalId,
          { status: nextStatus, reviewed_by: req.actor!.uid },
          false
        );
        res.json({ updated: true, proposalId, status: nextStatus });
      } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Erro ao atualizar proposta de resolução.' });
      }
    }
  );

  // --- MULTI-OUTCOME TRADE EXECUTION (Persists to SQLite + Supabase) ---
  router.post(
    '/markets/:marketId/multi-trade',
    verifySupabaseRequest,
    rateLimit(25, 10_000),
    async (req: AuthenticatedRequest, res) => {
      try {
        const result = await withMultiTradeLock(async () => {
          const uid = req.actor!.uid;
          const idToken = req.idToken!;
          const marketId = String(req.params.marketId || '').trim();
          const {
            outcomeName,
            side = 'Buy',
            binarySide = 'Yes',
            amountKz,
            shares: requestedShares,
          } = req.body || {};

          if (!['Buy', 'Sell'].includes(side) || !['Yes', 'No'].includes(binarySide)) {
            throw new Error('Parâmetros inválidos (side / binarySide).');
          }
          const cleanOutcomeName = String(outcomeName || '').trim();
          if (!cleanOutcomeName) {
            throw new Error('Selecione uma opção válida deste mercado.');
          }

          const [userDoc, marketDoc] = await Promise.all([
            fetchSupabaseDoc(idToken, 'users', uid),
            fetchSupabaseDoc(idToken, 'markets', marketId),
          ]);

          if (!userDoc) throw new Error('Conta de utilizador não encontrada.');
          if (userDoc.status === 'blocked') throw new Error('A sua conta encontra-se bloqueada.');
          if (!marketDoc) throw new Error('Mercado não encontrado.');
          if (marketDoc.resolved) throw new Error('Este mercado já foi resolvido.');
          if (marketDoc.status === 'blocked') throw new Error('Este mercado está bloqueado para negociação.');

          const outcomes: any[] = Array.isArray(marketDoc.outcomes) ? marketDoc.outcomes : [];
          const targetIdx = outcomes.findIndex((o) => o.name === cleanOutcomeName);
          if (targetIdx === -1) {
            throw new Error(`Opção "${cleanOutcomeName}" não encontrada neste mercado.`);
          }

          const targetOutcome = outcomes[targetIdx];
          const optionYesPrice = Math.max(0.01, Math.min(0.99, Number(targetOutcome.price || 0.5)));
          const execPrice = binarySide === 'Yes' ? optionYesPrice : Number((1 - optionYesPrice).toFixed(4));
          const execPriceCents = Math.max(1, Math.min(99, Math.round(execPrice * 100)));

          const fsBalCents = await getFreshSupabaseBalanceCents(idToken, uid);
          const recon = reconcileUserClobBalance(db, uid, fsBalCents);
          const now = new Date().toISOString();
          const userName = userDoc.name || req.actor!.email?.split('@')[0] || 'Trader';

          let executedShares = 0;
          let grossNotionalKz = 0;
          let feeKz = 0;
          let netDeltaCents = 0;

          if (side === 'Buy') {
            const parsedAmount = Number(amountKz || 0);
            if (!Number.isFinite(parsedAmount) || parsedAmount < 1) {
              throw new Error('Introduza um montante mínimo de 1 KZ para comprar.');
            }
            const amountCents = Math.round(parsedAmount * 100);
            if (recon.availableCents < amountCents) {
              throw new Error(
                `Saldo insuficiente (${(recon.availableCents / 100).toFixed(2)} KZ disponíveis).`
              );
            }
            feeKz = Number((parsedAmount * 0.01).toFixed(2));
            grossNotionalKz = Number((parsedAmount - feeKz).toFixed(2));
            executedShares = Number((grossNotionalKz / execPrice).toFixed(4));
            if (executedShares <= 0) {
              throw new Error('Montante insuficiente para adquirir quotas.');
            }
            netDeltaCents = -amountCents;

            db.transaction(() => {
              db.prepare(
                `UPDATE user_clob_accounts SET available_cents = available_cents - ?, updated_at = ? WHERE user_id = ?`
              ).run(amountCents, now, uid);

              const existingPos = db
                .prepare(
                  `SELECT shares, avg_price_cents FROM multi_outcome_positions
                   WHERE user_id = ? AND market_id = ? AND outcome_name = ? AND binary_side = ?`
                )
                .get(uid, marketId, cleanOutcomeName, binarySide) as
                | { shares: number; avg_price_cents: number }
                | undefined;

              const prevShares = Number(existingPos?.shares || 0);
              const prevAvg = Number(existingPos?.avg_price_cents || execPriceCents);
              const newShares = Number((prevShares + executedShares).toFixed(4));
              const newAvg =
                newShares > 0
                  ? Math.round((prevShares * prevAvg + executedShares * execPriceCents) / newShares)
                  : execPriceCents;

              db.prepare(
                `INSERT INTO multi_outcome_positions
                 (user_id, user_name, market_id, outcome_name, binary_side, shares, avg_price_cents, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(user_id, market_id, outcome_name, binary_side) DO UPDATE SET
                   user_name = excluded.user_name,
                   shares = excluded.shares,
                   avg_price_cents = excluded.avg_price_cents,
                   updated_at = excluded.updated_at`
              ).run(uid, userName, marketId, cleanOutcomeName, binarySide, newShares, newAvg, now);
            })();
          } else {
            const sellQty = Number(requestedShares || 0);
            if (!Number.isFinite(sellQty) || sellQty <= 0) {
              throw new Error('Introduza uma quantidade válida de quotas para vender.');
            }
            const existingPos = db
              .prepare(
                `SELECT shares, avg_price_cents FROM multi_outcome_positions
                 WHERE user_id = ? AND market_id = ? AND outcome_name = ? AND binary_side = ?`
              )
              .get(uid, marketId, cleanOutcomeName, binarySide) as
              | { shares: number; avg_price_cents: number }
              | undefined;

            const availShares = Number(existingPos?.shares || 0);
            if (availShares < sellQty) {
              throw new Error(`Quotas insuficientes para vender (${availShares.toFixed(2)} disponíveis).`);
            }

            executedShares = sellQty;
            grossNotionalKz = Number((sellQty * execPrice).toFixed(2));
            feeKz = Number((grossNotionalKz * 0.01).toFixed(2));
            const netProceedsKz = Math.max(0, Number((grossNotionalKz - feeKz).toFixed(2)));
            const creditCents = Math.round(netProceedsKz * 100);
            netDeltaCents = creditCents;

            db.transaction(() => {
              db.prepare(
                `UPDATE user_clob_accounts SET available_cents = available_cents + ?, updated_at = ? WHERE user_id = ?`
              ).run(creditCents, now, uid);

              const remaining = Math.max(0, Number((availShares - sellQty).toFixed(4)));
              if (remaining <= 0.0001) {
                db.prepare(
                  `DELETE FROM multi_outcome_positions
                   WHERE user_id = ? AND market_id = ? AND outcome_name = ? AND binary_side = ?`
                ).run(uid, marketId, cleanOutcomeName, binarySide);
              } else {
                db.prepare(
                  `UPDATE multi_outcome_positions SET shares = ?, updated_at = ?
                   WHERE user_id = ? AND market_id = ? AND outcome_name = ? AND binary_side = ?`
                ).run(remaining, now, uid, marketId, cleanOutcomeName, binarySide);
              }
            })();
          }

          // Recompute outcome probabilities smoothly based on net pool flow
          const shiftFactor = Math.min(0.08, Math.max(0.002, grossNotionalKz / Math.max(5000, Number(targetOutcome.pool || 1000) * 5)));
          const buyYesDirection = (side === 'Buy' && binarySide === 'Yes') || (side === 'Sell' && binarySide === 'No');
          const rawPrices = outcomes.map((o, i) => {
            const p = Math.max(0.01, Number(o.price || 0.01));
            if (i === targetIdx) {
              return buyYesDirection ? Math.min(0.95, p * (1 + shiftFactor)) : Math.max(0.01, p * (1 - shiftFactor));
            }
            return p;
          });
          const totalSum = rawPrices.reduce((s, p) => s + p, 0) || 1;
          const updatedOutcomes = outcomes.map((o, i) => {
            const nextPrice = Number(Math.max(0.01, Math.min(0.98, rawPrices[i] / totalSum)).toFixed(4));
            const prevPrice = Number(o.price || nextPrice);
            return {
              ...o,
              price: nextPrice,
              pool: i === targetIdx ? Number((Number(o.pool || 0) + grossNotionalKz).toFixed(2)) : Number(o.pool || 0),
              change_24h: Number(((nextPrice - prevPrice) * 100 + Number(o.change_24h || 0)).toFixed(1)),
            };
          });

          const newMarketVol = Number((Number(marketDoc.volume || 0) + grossNotionalKz).toFixed(2));

          // Update Supabase market + user balance + ledger + trades + positions + history
          const updatedAcc = db
            .prepare(`SELECT available_cents FROM user_clob_accounts WHERE user_id = ?`)
            .get(uid) as { available_cents: number };
          await updateSupabaseUserBalanceCents(idToken, uid, updatedAcc.available_cents);
          markUserBalanceSynced(db, uid, updatedAcc.available_cents);

          await recordSupabaseLedgerEntry(idToken, {
            userId: uid,
            type: side === 'Buy' ? 'COMPRA_MULTI' : 'VENDA_MULTI',
            amountKz: Number((netDeltaCents / 100).toFixed(2)),
            balanceBeforeKz: Number((recon.availableCents / 100).toFixed(2)),
            balanceAfterKz: Number((updatedAcc.available_cents / 100).toFixed(2)),
            reference: `${marketId}:${cleanOutcomeName}:${binarySide}`,
          });

          await patchSupabaseFields(
            idToken,
            'markets',
            marketId,
            {
              outcomes: updatedOutcomes,
              volume: newMarketVol,
            },
            false
          );

          const tradeLabel = `${cleanOutcomeName} (${binarySide === 'Yes' ? 'Sim' : 'Não'})`;
          await createSupabaseDoc(idToken, 'trades', {
            market_id: marketId,
            user_id: uid,
            side,
            outcome: tradeLabel,
            amount: grossNotionalKz,
            shares: executedShares,
            price: execPrice,
            fee: feeKz,
            engine: 'MULTI_POOL',
            timestamp: now,
          });

          // Mirror user's updated multi-position to Supabase positions table
          const updatedPosRow = db
            .prepare(
              `SELECT shares, avg_price_cents FROM multi_outcome_positions
               WHERE user_id = ? AND market_id = ? AND outcome_name = ? AND binary_side = ?`
            )
            .get(uid, marketId, cleanOutcomeName, binarySide) as
            | { shares: number; avg_price_cents: number }
            | undefined;
          const posDocId = `${uid}_${marketId}_${cleanOutcomeName}_${binarySide}`.replace(/[^a-zA-Z0-9_-]/g, '_');
          if (!updatedPosRow || updatedPosRow.shares <= 0) {
            await deleteSupabaseDoc(idToken, 'positions', posDocId);
          } else {
            await createSupabaseDoc(
              idToken,
              'positions',
              {
                userId: uid,
                user_id: uid,
                marketId,
                market_id: marketId,
                outcome: tradeLabel,
                shares: updatedPosRow.shares,
                available_shares: updatedPosRow.shares,
                reserved_shares: 0,
                avg_price: Number(((updatedPosRow.avg_price_cents || 50) / 100).toFixed(2)),
                updated_at: now,
              },
              posDocId,
              false
            );
          }

          // Save outcome price history snapshots for top outcomes
          const insertHist = db.prepare(
            `INSERT INTO multi_outcome_price_history (id, market_id, outcome_id, outcome_name, price, timestamp)
             VALUES (?, ?, ?, ?, ?, ?)`
          );
          for (const out of updatedOutcomes.slice(0, 8)) {
            const histId = randomUUID();
            insertHist.run(histId, marketId, String(out.id), out.name, out.price, now);
            createSupabaseDoc(
              idToken,
              'outcome_price_history',
              {
                market_id: marketId,
                outcome_id: String(out.id),
                outcome_name: out.name,
                price: out.price,
                timestamp: now,
              },
              histId,
              false
            ).catch(() => {});
          }

          return {
            executed: true,
            side,
            binarySide,
            outcomeName: cleanOutcomeName,
            filledShares: executedShares,
            execPrice,
            grossNotionalKz,
            feeKz,
            balanceKz: Number((updatedAcc.available_cents / 100).toFixed(2)),
            outcomes: updatedOutcomes,
            volume: newMarketVol,
          };
        });

        res.json(result);
      } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Erro ao executar negociação multi-opção.' });
      }
    }
  );

  // --- ADMIN: RESOLVE & LIQUIDATE MULTI-OUTCOME MARKET ---
  router.post(
    '/markets/:marketId/multi-resolve',
    verifySupabaseRequest,
    requireAdminMiddleware,
    rateLimit(10, 10_000),
    async (req: AuthenticatedRequest, res) => {
      try {
        const result = await withMultiTradeLock(async () => {
          const adminUid = req.actor!.uid;
          const idToken = req.idToken!;
          const marketId = String(req.params.marketId || '').trim();
          const winningOutcome = String(req.body?.winningOutcome || '').trim();
          const motive = String(req.body?.motive || '').trim();

          if (!winningOutcome) throw new Error('Selecione o resultado vencedor.');
          if (motive.length < 5) throw new Error('Indique um motivo ou fonte oficial (mínimo 5 caracteres).');

          const marketDoc = await fetchSupabaseDoc(idToken, 'markets', marketId);
          if (!marketDoc) throw new Error('Mercado não encontrado.');
          if (marketDoc.resolved) throw new Error('Este mercado já se encontra resolvido.');

          const now = new Date().toISOString();
          await patchSupabaseFields(
            idToken,
            'markets',
            marketId,
            {
              resolved: true,
              resolution_outcome: winningOutcome,
              status: 'resolved',
              resolved_at: now,
              resolution_motive: motive,
              resolved_by: adminUid,
            },
            true
          );

          // Gather all multi-outcome positions from SQLite + Supabase
          const sqlPositions = db
            .prepare(
              `SELECT user_id, outcome_name, binary_side, shares FROM multi_outcome_positions WHERE market_id = ? AND shares > 0`
            )
            .all(marketId) as Array<{ user_id: string; outcome_name: string; binary_side: string; shares: number }>;

          const posKeySet = new Set<string>();
          const allHoldings: Array<{ userId: string; outcomeName: string; binarySide: string; shares: number; sbDocId?: string }> = [];

          for (const sp of sqlPositions) {
            const k = `${sp.user_id}_${sp.outcome_name}_${sp.binary_side}`;
            posKeySet.add(k);
            allHoldings.push({
              userId: sp.user_id,
              outcomeName: sp.outcome_name,
              binarySide: sp.binary_side,
              shares: Number(sp.shares || 0),
            });
          }

          const sbPositions = await tryFetchSupabaseRows(
            'positions',
            `or=(market_id.eq.${encodeURIComponent(marketId)},marketId.eq.${encodeURIComponent(marketId)})&limit=1000`
          );
          for (const sp of sbPositions || []) {
            const shares = Number(sp.shares || 0);
            const uId = String(sp.user_id || sp.userId || '');
            const rawOut = String(sp.outcome || '');
            if (shares <= 0 || !uId) continue;
            const match = rawOut.match(/^(.*)\s+\((Sim|Não)\)$/);
            const oName = match ? match[1].trim() : rawOut;
            const bSide = match ? (match[2] === 'Não' ? 'No' : 'Yes') : 'Yes';
            const k = `${uId}_${oName}_${bSide}`;
            if (!posKeySet.has(k)) {
              posKeySet.add(k);
              allHoldings.push({ userId: uId, outcomeName: oName, binarySide: bSide, shares, sbDocId: sp.id });
            }
          }

          let payoutsCount = 0;
          let totalPaidKz = 0;

          for (const h of allHoldings) {
            const isWinner =
              (h.outcomeName === winningOutcome && h.binarySide === 'Yes') ||
              (h.outcomeName !== winningOutcome && h.binarySide === 'No');

            if (isWinner && h.shares > 0) {
              const payoutKz = Number((h.shares * 1).toFixed(2));
              const payoutCents = Math.round(payoutKz * 100);
              const fsBalCents = await getFreshSupabaseBalanceCents(idToken, h.userId).catch(() => 0);
              const recon = reconcileUserClobBalance(db, h.userId, fsBalCents);
              const newAvailableCents = recon.availableCents + payoutCents;

              db.prepare(`UPDATE user_clob_accounts SET available_cents = ?, updated_at = ? WHERE user_id = ?`).run(
                newAvailableCents,
                now,
                h.userId
              );

              await updateSupabaseUserBalanceCents(idToken, h.userId, newAvailableCents);
              markUserBalanceSynced(db, h.userId, newAvailableCents);

              await recordSupabaseLedgerEntry(idToken, {
                userId: h.userId,
                type: 'LIQUIDACAO_MERCADO',
                amountKz: payoutKz,
                balanceBeforeKz: Number((recon.availableCents / 100).toFixed(2)),
                balanceAfterKz: Number((newAvailableCents / 100).toFixed(2)),
                reference: `${marketId}:${winningOutcome}`,
              });

              payoutsCount++;
              totalPaidKz = Number((totalPaidKz + payoutKz).toFixed(2));
            }
          }

          // Clear settled positions in SQLite + Supabase
          db.prepare(`DELETE FROM multi_outcome_positions WHERE market_id = ?`).run(marketId);
          for (const sp of sbPositions || []) {
            if (sp.id) await deleteSupabaseDoc(idToken, 'positions', String(sp.id));
          }

          await createSupabaseDoc(idToken, 'audit_logs', {
            action: 'MULTI_MARKET_RESOLUTION',
            admin_id: adminUid,
            details: `Mercado multi-opção "${marketId}" resolvido como "${winningOutcome}". Liquidou ${payoutsCount} posições vencedoras (${totalPaidKz.toFixed(2)} KZ). Motivo: ${motive}`,
            created_at: now,
            timestamp: now,
          });

          return {
            resolved: true,
            marketId,
            winningOutcome,
            payoutsCount,
            totalPaidKz,
          };
        });

        res.json(result);
      } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Erro ao resolver e liquidar mercado multi-opção.' });
      }
    }
  );

  return router;
}
