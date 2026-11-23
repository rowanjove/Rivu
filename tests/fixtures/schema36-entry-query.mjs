// server/search-pairs.ts
var asciiFold = (value) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());
function pairTerm(value) {
  return `g${Buffer.from(asciiFold(value), "utf8").toString("hex")}`;
}

// server/entry-query.ts
var entryColumns = ["id", "feed_id", "guid", "title", "author", "url", "published_at", "fetched_at", "content", "description", "cover", "language", "read", "starred", "archived", "saved", "hash", "full_content", "full_content_fetched_at", "body_revision"];
var ruleEffect = (type) => `(EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id WHERE rm.entry_id=e.id AND rr.enabled=1 AND rr.action_type='${type}')${type === "save" ? "" : ` OR EXISTS (SELECT 1 FROM ai_filter_decisions WHERE entry_id=e.id AND decision='${type}')`})`;
var blocked = ruleEffect("block");
var muted = ruleEffect("mute");
var ruleSaved = ruleEffect("save");
var ruleFields = `CASE WHEN ${ruleSaved} THEN 1 ELSE 0 END rule_saved,CASE WHEN ${muted} THEN 1 ELSE 0 END rule_muted,CASE WHEN ${blocked} THEN 1 ELSE 0 END rule_blocked`;
var searchDate = (value) => {
  const relative = value.match(/^(\d{1,4})d$/i);
  return relative ? new Date(Date.now() - Number(relative[1]) * 864e5).toISOString().slice(0, 10) : value;
};
var todayPrefix = "date('now','localtime')";
var todayPrefixEnd = `substr(${todayPrefix},1,9)||char(unicode(substr(${todayPrefix},10,1))+1)`;
var frequentSearchPredicate = "(EXISTS (SELECT 1 FROM entry_fts WHERE rowid=e.rowid AND entry_fts MATCH ?) OR EXISTS (SELECT 1 FROM ai_results a JOIN ai_result_fts ON ai_result_fts.rowid=a.rowid WHERE a.entry_id=e.id AND a.type='summary' AND ai_result_fts MATCH ? AND a.content LIKE ?))";
var indexedSearchPredicate = "e.rowid IN (SELECT rowid FROM entry_fts WHERE entry_fts MATCH ? UNION ALL SELECT e2.rowid FROM ai_result_fts JOIN ai_results a ON a.rowid=ai_result_fts.rowid JOIN entries e2 ON e2.id=a.entry_id WHERE ai_result_fts MATCH ? AND a.type='summary' AND a.content LIKE ?)";
var frequentPairPredicate = "(EXISTS (SELECT 1 FROM entry_pair_fts WHERE rowid=e.rowid AND entry_pair_fts MATCH ?) OR EXISTS (SELECT 1 FROM ai_results a JOIN ai_result_pair_fts ON ai_result_pair_fts.rowid=a.rowid WHERE a.entry_id=e.id AND a.type='summary' AND ai_result_pair_fts MATCH ?))";
var indexedPairPredicate = "e.rowid IN (SELECT rowid FROM entry_pair_fts WHERE entry_pair_fts MATCH ? UNION ALL SELECT e2.rowid FROM ai_result_pair_fts JOIN ai_results a ON a.rowid=ai_result_pair_fts.rowid JOIN entries e2 ON e2.id=a.entry_id WHERE ai_result_pair_fts MATCH ? AND a.type='summary')";
function queryEntry(db, id, metadataOnly = false) {
  const fields = entryColumns.filter((column) => !metadataOnly || !["content", "description", "full_content"].includes(column)).map((column) => `${["content", "description", "full_content"].includes(column) ? "e" : "m"}.${column}`).join(",");
  return db.prepare(`SELECT ${fields},f.title feed_title,f.site_url feed_site_url,f.url feed_url,f.allow_private feed_allow_private,${ruleFields} FROM entries e JOIN entries m INDEXED BY entries_list_metadata ON m.id=e.id JOIN feeds f ON f.id=m.feed_id WHERE e.id=?`).get(id);
}
function queryEntries(db, opts = {}) {
  const where = [];
  const args = [];
  let hasFrequentTerm = false, hasSelectiveTerm = false;
  let canBoundFrequent = true;
  const limit = opts.limit ?? 100, offset = opts.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) throw Object.assign(Error("\u5206\u9875\u53C2\u6570\u65E0\u6548"), { statusCode: 400 });
  if (opts.cursor) {
    if (typeof opts.cursor.sortTime !== "string" || opts.cursor.sortTime.length > 100 || !opts.cursor.sortTime || typeof opts.cursor.id !== "string" || !/^[0-9a-f-]{36}$/i.test(opts.cursor.id) || opts.offset) throw Object.assign(Error("\u5206\u9875\u6E38\u6807\u65E0\u6548"), { statusCode: 400 });
    where.push("(COALESCE(e.published_at,e.fetched_at)<=? AND (COALESCE(e.published_at,e.fetched_at)<? OR e.id<?))");
    args.push(opts.cursor.sortTime, opts.cursor.sortTime, opts.cursor.id);
  }
  if (opts.feedId) {
    where.push("e.feed_id=?");
    args.push(opts.feedId);
  }
  if (opts.categoryId) {
    where.push("f.category_id=?");
    args.push(opts.categoryId);
  }
  if (opts.tagId) {
    where.push("(EXISTS (SELECT 1 FROM entry_tags et WHERE et.entry_id=e.id AND et.tag_id=?) OR EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id WHERE rm.entry_id=e.id AND rr.enabled=1 AND rr.action_type='tag' AND rr.tag_id=?))");
    args.push(opts.tagId, opts.tagId);
  }
  if (opts.view === "images" || opts.view === "audio" || opts.view === "video") {
    where.push("EXISTS (SELECT 1 FROM entry_media em WHERE em.entry_id=e.id AND em.kind=?)");
    args.push(opts.view === "images" ? "image" : opts.view);
  }
  if (opts.view === "blocked" || /(?:^|\s)is:blocked(?:\s|$)/i.test(opts.query || "")) where.push(blocked);
  else where.push(`NOT ${blocked}`);
  if (opts.view === "unread") {
    where.push("e.read=0");
    where.push(`NOT ${muted}`);
  }
  if (opts.view === "starred") where.push("e.starred=1");
  if (opts.view === "saved") where.push(`(e.saved=1 OR ${ruleSaved})`);
  if (opts.view === "today") where.push(`(e.published_at>=${todayPrefix} AND e.published_at<(${todayPrefixEnd}))`);
  if (opts.view === "summary") where.push("EXISTS (SELECT 1 FROM ai_results a WHERE a.entry_id=e.id AND a.type='summary')");
  if (opts.query) {
    if (opts.query.length > 256) throw Object.assign(Error("\u641C\u7D22\u5185\u5BB9\u8FC7\u957F"), { statusCode: 400 });
    const terms = [];
    for (const token of opts.query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
      const match = token.match(/^(feed|tag|is|after|before):(.+)$/i);
      if (!match) {
        if (token.toUpperCase() !== "AND") terms.push(token.replace(/^"|"$/g, ""));
        continue;
      }
      const kind = match[1].toLowerCase(), rawValue = match[2], unquoted = rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1) : rawValue, value = kind === "is" ? unquoted.toLowerCase() : unquoted;
      if (kind === "feed") {
        where.push("f.title LIKE ?");
        args.push(`%${value}%`);
      } else if (kind === "tag") {
        where.push("(EXISTS (SELECT 1 FROM entry_tags et JOIN tags t ON t.id=et.tag_id WHERE et.entry_id=e.id AND t.name LIKE ?) OR EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id JOIN tags t ON t.id=rr.tag_id WHERE rm.entry_id=e.id AND rr.enabled=1 AND rr.action_type='tag' AND t.name LIKE ?))");
        args.push(`%${value}%`, `%${value}%`);
      } else if (kind === "is" && value === "starred") where.push("e.starred=1");
      else if (kind === "is" && value === "unread") where.push("e.read=0");
      else if (kind === "is" && value === "saved") where.push(`(e.saved=1 OR ${ruleSaved})`);
      else if (kind === "is" && value === "muted") where.push(muted);
      else if (kind === "after" || kind === "before") {
        const day = searchDate(value), field = /^\d{4}-\d{2}-\d{2}$/.test(day) ? "COALESCE(e.published_at,e.fetched_at)" : "substr(COALESCE(e.published_at,e.fetched_at),1,10)";
        where.push(`${field}${kind === "after" ? ">=" : "<"}?`);
        args.push(day);
      }
    }
    if (terms.length > 8) throw Object.assign(Error("\u641C\u7D22\u5173\u952E\u8BCD\u8FC7\u591A"), { statusCode: 400 });
    for (const term of terms) {
      if (Array.from(term).length >= 3) {
        const match = `"${term.replaceAll('"', '""')}"`;
        const count = db.prepare("SELECT count(*) n FROM (SELECT rowid FROM entry_fts WHERE entry_fts MATCH ? UNION ALL SELECT rowid FROM ai_result_fts WHERE ai_result_fts MATCH ? LIMIT 1001)").get(match, match);
        if (count.n > 1e3) {
          hasFrequentTerm = true;
          where.push(frequentSearchPredicate);
          if (/[%_]/.test(term)) canBoundFrequent = false;
          args.push(match, match, `%${term}%`);
        } else {
          hasSelectiveTerm = true;
          where.push(indexedSearchPredicate);
          args.push(match, match, `%${term}%`);
        }
      } else if (Array.from(term).length >= 1 && !/[%_]/.test(term)) {
        const token = pairTerm(term);
        const count = db.prepare("SELECT count(*) n FROM (SELECT rowid FROM entry_pair_fts WHERE entry_pair_fts MATCH ? UNION ALL SELECT rowid FROM ai_result_pair_fts WHERE ai_result_pair_fts MATCH ? LIMIT 1001)").get(token, token);
        if (count.n > 1e3) {
          hasFrequentTerm = true;
          where.push(frequentPairPredicate);
        } else {
          hasSelectiveTerm = true;
          where.push(indexedPairPredicate);
        }
        args.push(token, token);
      } else {
        where.push("e.rowid IN (SELECT e2.rowid FROM entries e2 WHERE e2.title LIKE ? OR e2.content LIKE ? OR e2.description LIKE ? OR e2.author LIKE ? UNION SELECT e3.rowid FROM ai_results a JOIN entries e3 ON e3.id=a.entry_id WHERE a.type='summary' AND a.content LIKE ?)");
        for (let i = 0; i < 5; i++) args.push(`%${term}%`);
      }
    }
  }
  const fields = opts.listOnly ? `e.id,e.feed_id,e.title,e.author,e.url,e.published_at,e.fetched_at,substr(e.content,1,512) content,substr(e.description,1,512) description,e.cover,e.read,e.starred,e.saved` : entryColumns.map((column) => `${["content", "description", "full_content"].includes(column) ? "e" : "m"}.${column}`).join(",");
  const metadataJoin = opts.listOnly ? "" : " JOIN entries m INDEXED BY entries_list_metadata ON m.id=e.id";
  const select = `SELECT ${fields},f.title feed_title,f.site_url feed_site_url,${ruleFields}`;
  const order = "ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC LIMIT ? OFFSET ?";
  if (hasFrequentTerm && offset === 0 && canBoundFrequent) {
    const cursorWhere = opts.cursor ? "WHERE COALESCE(e.published_at,e.fetched_at)<=? AND (COALESCE(e.published_at,e.fetched_at)<? OR e.id<?)" : "";
    const cursorArgs = opts.cursor ? [opts.cursor.sortTime, opts.cursor.sortTime, opts.cursor.id] : [];
    if (!opts.listOnly) {
      const candidates = `SELECT e.id,ROW_NUMBER() OVER (ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC) page_order FROM recent CROSS JOIN entries e INDEXED BY entries_list_metadata ON e.id=recent.id JOIN feeds f ON f.id=e.feed_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ${order}`;
      const bounded = `WITH recent AS MATERIALIZED (SELECT e.id FROM entries e ${cursorWhere} ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC LIMIT 200), selected AS MATERIALIZED (${candidates}), physical AS MATERIALIZED (SELECT selected.id,selected.page_order,m.rowid storage_rowid FROM selected CROSS JOIN entries m INDEXED BY entries_list_metadata ON m.id=selected.id ORDER BY m.rowid) ${select},physical.page_order _rivu_page_order FROM physical CROSS JOIN entries e ON e.rowid=physical.storage_rowid${metadataJoin} JOIN feeds f ON f.id=m.feed_id`;
      const page = db.prepare(bounded).all(...cursorArgs, ...args, limit, 0).sort((a, b) => Number(a._rivu_page_order) - Number(b._rivu_page_order)).map(({ _rivu_page_order, ...row }) => row);
      if (page.length === limit) return page;
    } else {
      const key = opts.listOnly ? "id" : "rowid", index = opts.listOnly ? " INDEXED BY entries_list_metadata" : "";
      const bounded = `WITH recent AS MATERIALIZED (SELECT e.${key} FROM entries e ${cursorWhere} ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC LIMIT 200) ${select} FROM recent CROSS JOIN entries e${index} ON e.${key}=recent.${key}${metadataJoin} JOIN feeds f ON f.id=e.feed_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ${order}`;
      const page = db.prepare(bounded).all(...cursorArgs, ...args, limit, 0);
      if (page.length === limit) return page;
    }
  }
  const fallbackWhere = hasFrequentTerm && !hasSelectiveTerm ? where.map((part) => part === frequentSearchPredicate ? indexedSearchPredicate : part === frequentPairPredicate ? indexedPairPredicate : part) : where;
  if (offset >= 1e4 && !opts.query && !opts.feedId && !opts.categoryId && ["all", "unread", "blocked", "summary", "images", "audio", "video"].includes(opts.view || "all")) {
    const feedCatalog = "WITH RECURSIVE rivu_feed_catalog(feed_id) AS (SELECT min(feed_id) FROM entries INDEXED BY entries_feed_id_identity UNION ALL SELECT (SELECT min(feed_id) FROM entries INDEXED BY entries_feed_id_identity WHERE feed_id>rivu_feed_catalog.feed_id) FROM rivu_feed_catalog WHERE feed_id IS NOT NULL)";
    const cleanFeed = `NOT EXISTS (${feedCatalog} SELECT 1 FROM rivu_feed_catalog x LEFT JOIN feeds f ON f.id=x.feed_id WHERE x.feed_id IS NOT NULL AND f.id IS NULL)`;
    const validFeed = `CASE WHEN ${cleanFeed} THEN 1 ELSE e.rowid IN (SELECT x.rowid FROM entries x INDEXED BY entries_feed_id_identity JOIN feeds f ON f.id=x.feed_id) END`;
    const indexedBlocked = "(COALESCE(e.id IN (SELECT rm.entry_id FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id WHERE rr.enabled=1 AND rr.action_type='block' AND rm.entry_id IS NOT NULL),0) OR COALESCE(e.id IN (SELECT entry_id FROM ai_filter_decisions WHERE decision='block' AND entry_id IS NOT NULL),0))";
    const noBlocks = "NOT EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id WHERE rr.enabled=1 AND rr.action_type='block') AND NOT EXISTS (SELECT 1 FROM ai_filter_decisions WHERE decision='block')";
    const indexedMuted = "(COALESCE(e.id IN (SELECT rm.entry_id FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id WHERE rr.enabled=1 AND rr.action_type='mute' AND rm.entry_id IS NOT NULL),0) OR COALESCE(e.id IN (SELECT entry_id FROM ai_filter_decisions WHERE decision='mute' AND entry_id IS NOT NULL),0))";
    const noMutes = "NOT EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id WHERE rr.enabled=1 AND rr.action_type='mute') AND NOT EXISTS (SELECT 1 FROM ai_filter_decisions WHERE decision='mute')";
    const candidateWhere = fallbackWhere.map((part) => part === `NOT ${blocked}` ? `CASE WHEN ${noBlocks} THEN 1 ELSE NOT ${indexedBlocked} END` : part === blocked ? `CASE WHEN ${noBlocks} THEN 0 ELSE ${indexedBlocked} END` : part === `NOT ${muted}` ? `CASE WHEN ${noMutes} THEN 1 ELSE NOT ${indexedMuted} END` : part);
    const candidateIndex = opts.view === "unread" ? "entries_unread_cursor" : "entries_cursor_sort";
    let candidates = `SELECT e.id,COALESCE(e.published_at,e.fetched_at) sort_time FROM entries e INDEXED BY ${candidateIndex} WHERE ${[validFeed, ...candidateWhere].join(" AND ")} ${order}`;
    let proof = "", pageArgs = [...args, limit, offset];
    if (["all", "unread"].includes(opts.view || "all") && !opts.tagId && !opts.cursor) {
      proof = `proof AS MATERIALIZED (SELECT CASE WHEN ${cleanFeed} AND ${noBlocks}${opts.view === "unread" ? ` AND ${noMutes}` : ""} THEN 1 ELSE 0 END clean), `;
      const fast = `SELECT e.id,COALESCE(e.published_at,e.fetched_at) sort_time FROM entries e INDEXED BY ${candidateIndex} ${opts.view === "unread" ? "WHERE e.read=0" : ""} ${order}`;
      const slow = candidates.replace(`FROM entries e INDEXED BY ${candidateIndex} WHERE`, `FROM proof CROSS JOIN entries e INDEXED BY ${candidateIndex} WHERE proof.clean=0 AND`);
      candidates = `SELECT page.id,page.sort_time FROM (${fast}) page CROSS JOIN proof WHERE proof.clean=1 UNION ALL SELECT page.id,page.sort_time FROM (${slow}) page`;
      pageArgs = [limit, offset, ...args, limit, offset];
    }
    if (!opts.listOnly) {
      const page2 = `WITH ${proof}selected AS MATERIALIZED (${candidates}), ranked AS MATERIALIZED (SELECT id,ROW_NUMBER() OVER (ORDER BY sort_time DESC,id DESC) page_order FROM selected), physical AS MATERIALIZED (SELECT ranked.id,ranked.page_order,m.rowid storage_rowid FROM ranked CROSS JOIN entries m INDEXED BY entries_list_metadata ON m.id=ranked.id ORDER BY m.rowid) ${select},physical.page_order _rivu_page_order FROM physical CROSS JOIN entries e ON e.rowid=physical.storage_rowid${metadataJoin} JOIN feeds f ON f.id=m.feed_id`;
      return db.prepare(page2).all(...pageArgs).sort((a, b) => Number(a._rivu_page_order) - Number(b._rivu_page_order)).map(({ _rivu_page_order, ...row }) => row);
    }
    const index = opts.listOnly ? " INDEXED BY entries_list_metadata" : "";
    const page = `WITH ${proof}selected AS MATERIALIZED (${candidates}) ${select} FROM selected CROSS JOIN entries e${index} ON e.id=selected.id${metadataJoin} JOIN feeds f ON f.id=${opts.listOnly ? "e" : "m"}.feed_id ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC`;
    return db.prepare(page).all(...pageArgs);
  }
  if (opts.listOnly) {
    const candidates = `SELECT e.id FROM entries e JOIN feeds f ON f.id=e.feed_id ${fallbackWhere.length ? "WHERE " + fallbackWhere.join(" AND ") : ""} ${order}`;
    const page = `WITH selected AS MATERIALIZED (${candidates}) ${select} FROM selected CROSS JOIN entries e INDEXED BY entries_list_metadata ON e.id=selected.id JOIN feeds f ON f.id=e.feed_id ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC`;
    return db.prepare(page).all(...args, limit, offset);
  }
  const sql = `${select} FROM entries e${metadataJoin} JOIN feeds f ON f.id=e.feed_id ${fallbackWhere.length ? "WHERE " + fallbackWhere.join(" AND ") : ""} ${order}`;
  return db.prepare(sql).all(...args, limit, offset);
}
export {
  blocked,
  entryColumns,
  muted,
  queryEntries,
  queryEntry,
  ruleFields,
  ruleSaved
};
