"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// server/database.ts
var database_exports = {};
__export(database_exports, {
  RECOVERED_FEED_URL_PREFIX: () => RECOVERED_FEED_URL_PREFIX,
  RivuDatabase: () => RivuDatabase,
  SCHEMA_VERSION: () => SCHEMA_VERSION,
  isRecoveredFeed: () => isRecoveredFeed,
  validateFetchInterval: () => validateFetchInterval,
  validateSchema: () => validateSchema
});
module.exports = __toCommonJS(database_exports);

// server/search-pairs.ts
var asciiFold = (value) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());
function pairTerm(value) {
  return `g${Buffer.from(asciiFold(value), "utf8").toString("hex")}`;
}
function pairTokens(...values) {
  const raw = /* @__PURE__ */ new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    const chars = Array.from(value);
    for (const char of chars) raw.add(char);
    for (let index = 0; index + 1 < chars.length; index++) raw.add(chars[index] + chars[index + 1]);
  }
  return [...new Set([...raw].map(pairTerm))].join(" ");
}

// server/search-universal-proof.ts
function universalSearchProof(db) {
  if (!db.isTransaction) throw Error("\u641C\u7D22\u8986\u76D6\u8BC1\u660E\u9700\u8981\u8BFB\u53D6\u5FEB\u7167");
  let range;
  return (table, match) => {
    if (!range) {
      const statement2 = db.prepare("SELECT (SELECT rowid FROM entries ORDER BY rowid LIMIT 1) lo,(SELECT rowid FROM entries ORDER BY rowid DESC LIMIT 1) hi");
      statement2.setReadBigInts(true);
      range = statement2.get();
    }
    if (range.lo === null || range.hi === null) return true;
    const statement = db.prepare(`SELECT count(*) n FROM ${table} WHERE ${table} MATCH ? AND rowid>=? AND rowid<=?`);
    statement.setReadBigInts(true);
    const row = statement.get(match, range.lo, range.hi);
    return row.n === range.hi - range.lo + 1n;
  };
}

// server/search-posting-bits.ts
var MAX_TERMS = 8;
var MAX_SPAN = 4194304;
var MAX_PACKED_CHARS = 8 * 1024 * 1024;
var MAX_POSTINGS = 1e6;
var states = /* @__PURE__ */ new WeakMap();
function withSearchPostingBits(db, postings, consume) {
  if (!db.isTransaction) throw Error("\u641C\u7D22\u4F4D\u56FE\u9700\u8981\u8BFB\u53D6\u5FEB\u7167");
  if (!postings.length || postings.length > MAX_TERMS) return { accepted: false, reason: "term-budget" };
  let state = states.get(db);
  if (state?.active) return { accepted: false, reason: "nested-search" };
  const rangeStatement = db.prepare("SELECT (SELECT rowid FROM entries ORDER BY rowid LIMIT 1) lo,(SELECT rowid FROM entries ORDER BY rowid DESC LIMIT 1) hi");
  rangeStatement.setReadBigInts(true);
  const range = rangeStatement.get();
  if (range.lo !== null && (range.lo <= 0n || range.hi > BigInt(Number.MAX_SAFE_INTEGER) || range.hi - range.lo + 1n > BigInt(MAX_SPAN))) return { accepted: false, reason: "rowid-budget" };
  if (!state) {
    state = { active: false, slots: [] };
    const captured = state;
    for (let index = 0; index < MAX_TERMS; index++) db.function(`rivu_search_bits_${index}`, { deterministic: true }, (value) => {
      const slot = captured.slots[index];
      if (!slot || typeof value !== "number" || !Number.isSafeInteger(value) || value < slot.lo || value > slot.hi) return 0;
      const offset = value - slot.lo;
      return slot.bits[offset >> 3] & 1 << (offset & 7) ? 1 : 0;
    });
    states.set(db, state);
  }
  state.active = true;
  try {
    const lo = Number(range.lo ?? 0n), hi = Number(range.hi ?? -1n), span = Math.max(0, hi - lo + 1), names = [];
    let packedCharacters = 0, bitmapBytes = 0;
    const counts = [], payloads = [];
    for (const [index, posting] of postings.entries()) {
      const remaining = MAX_PACKED_CHARS - packedCharacters, charsPerRow = Math.max(1, String(hi).length) + 1;
      const cap = Math.min(MAX_POSTINGS, Math.floor(remaining / charsPerRow));
      if (cap < 1) return { accepted: false, reason: "posting-budget" };
      const packed = db.prepare(`SELECT group_concat(entry_rowid,',') payload,count(*) n FROM (SELECT entry_rowid FROM (${posting.sql}) WHERE entry_rowid>=? AND entry_rowid<=? LIMIT ?)`).get(...posting.args, lo, hi, cap + 1);
      if (packed.n > cap) return { accepted: false, reason: "posting-budget" };
      counts.push(packed.n);
      const payload = packed.payload ?? "";
      packedCharacters += payload.length;
      payloads.push(payload);
      if (packedCharacters > MAX_PACKED_CHARS) return { accepted: false, reason: "posting-budget" };
      const bits = new Uint8Array(Math.ceil(span / 8));
      let value2 = 0;
      if (payload) for (let cursor = 0; cursor <= payload.length; cursor++) {
        const code = cursor === payload.length ? 44 : payload.charCodeAt(cursor);
        if (code === 44) {
          if (!Number.isSafeInteger(value2) || value2 < lo || value2 > hi) throw Error("\u641C\u7D22posting\u884C\u53F7\u65E0\u6548");
          const offset = value2 - lo;
          bits[offset >> 3] |= 1 << (offset & 7);
          value2 = 0;
        } else {
          if (code < 48 || code > 57) throw Error("\u641C\u7D22posting\u884C\u53F7\u65E0\u6548");
          value2 = value2 * 10 + code - 48;
        }
      }
      state.slots[index] = { bits, lo, hi };
      bitmapBytes += bits.byteLength;
      names.push(`rivu_search_bits_${index}`);
    }
    const value = consume(names, counts, payloads);
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.then === "function") {
      if (value instanceof Promise) void value.catch(() => {
      });
      throw Error("\u641C\u7D22\u4F4D\u56FE\u5FC5\u987B\u540C\u6B65\u6D88\u8D39");
    }
    return { accepted: true, value, packedCharacters, bitmapBytes };
  } finally {
    state.slots.length = 0;
    state.active = false;
  }
}

// server/search-rowid-query.ts
function trySearchRowidPage(db, input, hydrate) {
  if (!db.isTransaction) return { accepted: false, reason: "snapshot-required" };
  if (!Number.isSafeInteger(input.offset) || !Number.isSafeInteger(input.offset + input.limit)) return { accepted: false, reason: "offset-range" };
  const { syntax } = input;
  if (!["all", "unread", "blocked"].includes(input.view || "all") || input.view === "unread" && input.where.includes(syntax.blocked)) return { accepted: false, reason: "view" };
  const conditions = [], values = [], postings = [];
  let consumed = 0, scoped = false;
  for (const part of input.where) {
    const count = (part.match(/\?/g) || []).length, args = input.args.slice(consumed, consumed + count);
    consumed += count;
    const long = part === syntax.indexedLong || part === syntax.frequentLong, pair = part === syntax.indexedPair || part === syntax.frequentPair;
    if (long || pair) {
      const indexed = long ? syntax.indexedLong : syntax.indexedPair;
      if (!indexed.startsWith("e.rowid IN (") || !indexed.endsWith(")")) return { accepted: false, reason: "posting-shape" };
      postings.push({ sql: `SELECT rowid entry_rowid FROM (${indexed.slice(12, -1)})`, args });
      continue;
    }
    let mapped;
    if (part === `NOT ${syntax.blocked}`) mapped = "s.blocked=0";
    else if (part === syntax.blocked) mapped = "s.blocked=1";
    else if (part === `NOT ${syntax.muted}` && input.view === "unread") mapped = "s.visible=1";
    else if (part === syntax.muted) mapped = part.replaceAll("e.id", "s.entry_id");
    else if (part === "e.read=0") mapped = "s.read=0";
    else if (part === "e.feed_id=?") {
      mapped = "s.feed_id=?";
      scoped = true;
    } else if (part === "f.category_id=?") {
      mapped = "s.feed_id IN (SELECT id FROM feeds WHERE category_id=?)";
      scoped = true;
    } else if (part === "f.title LIKE ?") {
      mapped = "s.feed_id IN (SELECT id FROM feeds WHERE title LIKE ?)";
      scoped = true;
    } else if (part === "(COALESCE(e.published_at,e.fetched_at)<=? AND (COALESCE(e.published_at,e.fetched_at)<? OR e.id<?))" || /^(?:COALESCE\(e\.published_at,e\.fetched_at\)|substr\(COALESCE\(e\.published_at,e\.fetched_at\),1,10\))(?:>=|<)\?$/.test(part)) mapped = part.replaceAll("COALESCE(e.published_at,e.fetched_at)", "s.sort_time").replaceAll("e.id", "s.entry_id");
    else return { accepted: false, reason: "predicate" };
    conditions.push(mapped);
    values.push(...args);
  }
  if (consumed !== input.args.length || !postings.length) return { accepted: false, reason: "parameters" };
  return withSearchPostingBits(db, postings, (names, counts, packed) => {
    const catalog = db.prepare("SELECT NOT EXISTS(SELECT 1 FROM rivu_source_entry_counts c LEFT JOIN feeds f ON f.id=c.feed_id WHERE f.id IS NULL) valid,(SELECT sum(entry_count) FROM rivu_source_entry_counts) total").get();
    if (!catalog.valid) conditions.push("EXISTS(SELECT 1 FROM feeds f WHERE f.id=s.feed_id)");
    const smallest = counts.indexOf(Math.min(...counts));
    if (!input.feedId && counts[smallest] <= 1e5 && catalog.total > counts[smallest] * 4) {
      const candidate = "[" + packed[smallest] + "]";
      const sparseConditions = [...conditions, ...names.flatMap((name, index2) => index2 === smallest ? [] : [`${name}(s.entry_rowid)`])];
      const base = `FROM rivu_search_entries s NOT INDEXED WHERE s.entry_rowid IN (SELECT value FROM json_each(?)) AND ${sparseConditions.length ? sparseConditions.join(" AND ") : "1"}`;
      if (input.offset <= counts[smallest] / 4) {
        const rows3 = db.prepare(`SELECT s.entry_id id ${base} ORDER BY s.sort_time DESC,s.entry_id DESC LIMIT ? OFFSET ?`).all(candidate, ...values, input.limit, input.offset);
        return hydrate(rows3.map((row) => row.id));
      }
      if (input.offset >= counts[smallest] / 2) {
        const count = db.prepare(`SELECT count(*) n ${base}`).get(candidate, ...values).n;
        if (input.offset >= count) return hydrate([]);
        if (input.offset > count / 2) {
          const pageSize = Math.min(input.limit, count - input.offset), reverseOffset = count - input.offset - pageSize;
          const rows3 = db.prepare(`SELECT s.entry_id id ${base} ORDER BY s.sort_time ASC,s.entry_id ASC LIMIT ? OFFSET ?`).all(candidate, ...values, pageSize, reverseOffset);
          return hydrate(rows3.reverse().map((row) => row.id));
        }
      }
      const sql = `WITH ranked AS (SELECT s.entry_id,ROW_NUMBER() OVER (ORDER BY s.sort_time DESC,s.entry_id DESC) ordinal ${base}) SELECT entry_id id FROM ranked WHERE ordinal>? AND ordinal<=? ORDER BY ordinal`;
      const rows2 = db.prepare(sql).all(candidate, ...values, input.offset, input.offset + input.limit);
      return hydrate(rows2.map((row) => row.id));
    }
    conditions.push(...names.map((name) => `${name}(s.entry_rowid)`));
    const index = input.feedId ? "rivu_search_feed" : scoped ? "rivu_search_timeline" : "rivu_search_unscoped";
    const rows = db.prepare(`SELECT s.entry_id id FROM rivu_search_entries s INDEXED BY ${index} WHERE ${conditions.join(" AND ")} ORDER BY s.sort_time DESC,s.entry_id DESC LIMIT ? OFFSET ?`).all(...values, input.limit, input.offset);
    return hydrate(rows.map((row) => row.id));
  });
}

// server/ai-search-candidate.ts
var COMMON = 1e3;
var MAX_PREFIX_ROWS = 65536;
function summaryCandidateMatch(db, term, fullMatch, frequent) {
  if (!frequent || !db.isTransaction || typeof term !== "string" || !/^[\p{L}\p{N}]{4,32}$/u.test(term)) return fullMatch;
  const countTo = (match, limit) => db.prepare("SELECT count(*) n FROM (SELECT rowid FROM ai_result_fts WHERE ai_result_fts MATCH ? LIMIT ?)").get(match, limit).n;
  const common = countTo(fullMatch, COMMON + 1);
  if (common <= COMMON) return fullMatch;
  const prefix = `"${Array.from(term).slice(0, 3).join("")}"`, candidates = countTo(prefix, MAX_PREFIX_ROWS + 1);
  if (candidates < common || candidates > MAX_PREFIX_ROWS) return fullMatch;
  const required = Math.ceil(candidates / 2);
  if (required > common && countTo(fullMatch, required) < required) return fullMatch;
  return prefix;
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
var frequentSearchPredicate = "(EXISTS (SELECT 1 FROM entry_fts WHERE rowid=e.rowid AND entry_fts MATCH ?) OR EXISTS (SELECT 1 FROM ai_results a CROSS JOIN ai_result_fts ON ai_result_fts.rowid=a.rowid WHERE a.entry_id=e.id AND a.type='summary' AND ai_result_fts MATCH ? AND a.content LIKE ?))";
var indexedSearchPredicate = "e.rowid IN (SELECT rowid FROM entry_fts WHERE entry_fts MATCH ? UNION ALL SELECT e2.rowid FROM ai_result_fts JOIN ai_results a ON a.rowid=ai_result_fts.rowid JOIN entries e2 ON e2.id=a.entry_id WHERE ai_result_fts MATCH ? AND a.type='summary' AND a.content LIKE ?)";
var frequentPairPredicate = "(EXISTS (SELECT 1 FROM entry_pair_fts WHERE rowid=e.rowid AND entry_pair_fts MATCH ?) OR EXISTS (SELECT 1 FROM ai_results a CROSS JOIN ai_result_pair_fts ON ai_result_pair_fts.rowid=a.rowid WHERE a.entry_id=e.id AND a.type='summary' AND ai_result_pair_fts MATCH ?))";
var indexedPairPredicate = "e.rowid IN (SELECT rowid FROM entry_pair_fts WHERE entry_pair_fts MATCH ? UNION ALL SELECT e2.rowid FROM ai_result_pair_fts JOIN ai_results a ON a.rowid=ai_result_pair_fts.rowid JOIN entries e2 ON e2.id=a.entry_id WHERE ai_result_pair_fts MATCH ? AND a.type='summary')";
function queryEntry(db, id, metadataOnly = false) {
  const fields = entryColumns.filter((column) => !metadataOnly || !["content", "description", "full_content"].includes(column)).map((column) => `${["content", "description", "full_content"].includes(column) ? "e" : "m"}.${column}`).join(",");
  return db.prepare(`SELECT ${fields},f.title feed_title,f.site_url feed_site_url,f.url feed_url,f.allow_private feed_allow_private,${ruleFields} FROM entries e JOIN entries m INDEXED BY entries_list_metadata ON m.id=e.id JOIN feeds f ON f.id=m.feed_id WHERE e.id=?`).get(id);
}
function queryEntries(db, opts = {}) {
  const ownsSnapshot = !!opts.query && !db.isTransaction;
  if (ownsSnapshot) db.exec("BEGIN");
  try {
    return queryEntriesInSnapshot(db, opts);
  } finally {
    if (ownsSnapshot) db.exec("ROLLBACK");
  }
}
function queryEntriesInSnapshot(db, opts) {
  const provesUniversal = opts.offset && opts.query ? universalSearchProof(db) : void 0;
  const where = [];
  const args = [];
  let hasFrequentTerm = false, hasSelectiveTerm = false;
  let canBoundFrequent = true, projectionQuerySafe = true, bucketCountQuerySafe = true;
  const bucketDateWhere = [], bucketDateArgs = [], bucketSourceWhere = [], bucketSourceArgs = [];
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
    bucketSourceWhere.push("feed_id IN (SELECT id FROM feeds WHERE category_id=?)");
    bucketSourceArgs.push(opts.categoryId);
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
      if (!["after", "before", "feed"].includes(match[1].toLowerCase())) bucketCountQuerySafe = false;
      const kind = match[1].toLowerCase(), rawValue = match[2], unquoted = rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1) : rawValue, value = kind === "is" ? unquoted.toLowerCase() : unquoted;
      if (kind === "feed") {
        where.push("f.title LIKE ?");
        args.push(`%${value}%`);
        bucketSourceWhere.push("feed_id IN (SELECT id FROM feeds WHERE title LIKE ?)");
        bucketSourceArgs.push(`%${value}%`);
      } else if (kind === "tag") {
        where.push("(EXISTS (SELECT 1 FROM entry_tags et JOIN tags t ON t.id=et.tag_id WHERE et.entry_id=e.id AND t.name LIKE ?) OR EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id JOIN tags t ON t.id=rr.tag_id WHERE rm.entry_id=e.id AND rr.enabled=1 AND rr.action_type='tag' AND t.name LIKE ?))");
        args.push(`%${value}%`, `%${value}%`);
      } else if (kind === "is" && value === "starred") where.push("e.starred=1");
      else if (kind === "is" && value === "unread") where.push("e.read=0");
      else if (kind === "is" && value === "saved") where.push(`(e.saved=1 OR ${ruleSaved})`);
      else if (kind === "is" && value === "muted") where.push(muted);
      else if (kind === "after" || kind === "before") {
        bucketDateWhere.push(`sort_bucket${kind === "after" ? ">=" : "<"}?`);
        const day = searchDate(value), field = /^\d{4}-\d{2}-\d{2}$/.test(day) ? "COALESCE(e.published_at,e.fetched_at)" : "substr(COALESCE(e.published_at,e.fetched_at),1,10)";
        where.push(`${field}${kind === "after" ? ">=" : "<"}?`);
        args.push(day);
        bucketDateArgs.push(day);
      }
    }
    if (terms.length > 8) throw Object.assign(Error("\u641C\u7D22\u5173\u952E\u8BCD\u8FC7\u591A"), { statusCode: 400 });
    for (const term of terms) {
      if (Array.from(term).length >= 3) {
        const match = `"${term.replaceAll('"', '""')}"`;
        const count = db.prepare("SELECT count(*) n FROM (SELECT rowid FROM entry_fts WHERE entry_fts MATCH ? UNION ALL SELECT rowid FROM ai_result_fts WHERE ai_result_fts MATCH ? LIMIT 1001)").get(match, match);
        if (count.n > 1e3 && provesUniversal?.("entry_fts", match)) continue;
        const aiMatch = summaryCandidateMatch(db, term, match, count.n > 1e3);
        projectionQuerySafe = false;
        if (count.n > 1e3) {
          hasFrequentTerm = true;
          where.push(frequentSearchPredicate);
          if (/[%_]/.test(term)) canBoundFrequent = false;
          args.push(match, aiMatch, `%${term}%`);
        } else {
          hasSelectiveTerm = true;
          where.push(indexedSearchPredicate);
          args.push(match, aiMatch, `%${term}%`);
        }
      } else if (Array.from(term).length >= 1 && !/[%_]/.test(term)) {
        const token = pairTerm(term);
        const count = db.prepare("SELECT count(*) n FROM (SELECT rowid FROM entry_pair_fts WHERE entry_pair_fts MATCH ? UNION ALL SELECT rowid FROM ai_result_pair_fts WHERE ai_result_pair_fts MATCH ? LIMIT 1001)").get(token, token);
        if (count.n > 1e3 && provesUniversal?.("entry_pair_fts", token)) continue;
        projectionQuerySafe = false;
        if (count.n > 1e3) {
          hasFrequentTerm = true;
          where.push(frequentPairPredicate);
        } else {
          hasSelectiveTerm = true;
          where.push(indexedPairPredicate);
        }
        args.push(token, token);
      } else {
        projectionQuerySafe = false;
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
  if (opts.query && hasFrequentTerm && !hasSelectiveTerm && !projectionQuerySafe) {
    const fast = trySearchRowidPage(db, { where: fallbackWhere, args, view: opts.view, feedId: opts.feedId, limit, offset, syntax: { blocked, muted, indexedLong: indexedSearchPredicate, frequentLong: frequentSearchPredicate, indexedPair: indexedPairPredicate, frequentPair: frequentPairPredicate } }, (ids) => {
      if (!ids.length) return [];
      const values = ids.map(() => "(?,?)").join(","), parameters = ids.flatMap((id, index) => [id, index]);
      return db.prepare(`WITH selected(id,ordinal) AS (VALUES ${values}) ${select} FROM selected CROSS JOIN entries e${opts.listOnly ? " INDEXED BY entries_list_metadata" : ""} ON e.id=selected.id${metadataJoin} JOIN feeds f ON f.id=e.feed_id ORDER BY selected.ordinal`).all(...parameters);
    });
    if (fast.accepted) return fast.value;
  }
  const rawSimple = /* @__PURE__ */ new Set([
    "e.read=0",
    `NOT ${blocked}`,
    "e.feed_id=?",
    "f.category_id=?",
    "f.title LIKE ?",
    "(COALESCE(e.published_at,e.fetched_at)<=? AND (COALESCE(e.published_at,e.fetched_at)<? OR e.id<?))"
  ]);
  const rawSafe = fallbackWhere.every((part) => rawSimple.has(part) || /^(?:COALESCE\(e\.published_at,e\.fetched_at\)|substr\(COALESCE\(e\.published_at,e\.fetched_at\),1,10\))(?:>=|<)\?$/.test(part));
  if ((!opts.view || opts.view === "all") && where.includes("e.read=0") && rawSafe) {
    const ownsSnapshot = !db.isTransaction;
    if (ownsSnapshot) db.exec("BEGIN");
    try {
      const catalog = db.prepare("SELECT NOT EXISTS(SELECT 1 FROM rivu_source_entry_counts c LEFT JOIN feeds f ON f.id=c.feed_id WHERE f.id IS NULL) valid").get();
      const predicates = fallbackWhere.filter((part) => part !== "e.read=0" && part !== `NOT ${blocked}`).map((part) => part.replace("f.category_id=?", "r.feed_id IN (SELECT id FROM feeds WHERE category_id=?)").replace("f.title LIKE ?", "r.feed_id IN (SELECT id FROM feeds WHERE title LIKE ?)").replaceAll("substr(COALESCE(e.published_at,e.fetched_at),1,10)", "r.sort_bucket").replaceAll("COALESCE(e.published_at,e.fetched_at)", "r.sort_time").replaceAll("e.feed_id", "r.feed_id").replaceAll("e.id", "r.entry_id"));
      if (!catalog.valid) predicates.push("EXISTS(SELECT 1 FROM feeds f WHERE f.id=r.feed_id)");
      if (opts.cursor) predicates.push("r.sort_bucket<=substr(?,1,10)");
      const index = opts.feedId ? "rivu_raw_unread_feed" : "rivu_raw_unread_timeline";
      const selected = `SELECT r.entry_id id FROM rivu_raw_unread_entries r INDEXED BY ${index} ${predicates.length ? "WHERE " + predicates.join(" AND ") : ""} ORDER BY r.sort_bucket DESC,r.sort_time DESC,r.entry_id DESC LIMIT ? OFFSET ?`;
      const page = `WITH selected AS MATERIALIZED (${selected}) ${select} FROM selected CROSS JOIN entries e${opts.listOnly ? " INDEXED BY entries_list_metadata" : ""} ON e.id=selected.id${metadataJoin} JOIN feeds f ON f.id=e.feed_id ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC`;
      return db.prepare(page).all(...args, ...opts.cursor ? [opts.cursor.sortTime] : [], limit, offset);
    } finally {
      if (ownsSnapshot) db.exec("ROLLBACK");
    }
  }
  const projectionWhere = fallbackWhere.map((part) => {
    if (part === `NOT ${blocked}`) return opts.view === "unread" ? "1" : "v.blocked=0";
    if (part === blocked) return "v.blocked=1";
    if (part === "e.read=0" && opts.view === "unread") return "v.visible=1";
    if (part === `NOT ${muted}` && opts.view === "unread") return "1";
    return part.replaceAll("COALESCE(e.published_at,e.fetched_at)", "v.sort_time").replace(/\be\.id\b/g, "v.entry_id").replace(/\be\.feed_id\b/g, "v.feed_id").replace("f.category_id=?", "v.feed_id IN (SELECT id FROM feeds WHERE category_id=?)").replace("f.title LIKE ?", "v.feed_id IN (SELECT id FROM feeds WHERE title LIKE ?)");
  });
  if (!opts.feedId && projectionQuerySafe && projectionWhere.every((part) => !/(?:\be|\bf)\./.test(part)) && !(opts.view === "unread" && fallbackWhere.includes(blocked)) && (offset > 0 || opts.cursor || opts.feedId || opts.categoryId || opts.query) && ["all", "unread", "blocked", "summary", "images", "audio", "video"].includes(opts.view || "all")) {
    const cleanFeed = "NOT EXISTS (SELECT 1 FROM rivu_source_entry_counts c LEFT JOIN feeds f ON f.id=c.feed_id WHERE f.id IS NULL)";
    const ownsSnapshot = !db.isTransaction;
    if (ownsSnapshot) db.exec("BEGIN");
    try {
      const catalog = db.prepare(`SELECT ${cleanFeed} valid`).get();
      const validFeed = catalog.valid ? "1" : "EXISTS(SELECT 1 FROM feeds f WHERE f.id=v.feed_id)";
      const candidateWhere = [...projectionWhere];
      let pageOffset = offset;
      const bucketArgs = [...bucketDateArgs];
      candidateWhere.push(...bucketDateWhere.map((part) => "v." + part));
      if (opts.cursor) {
        candidateWhere.push("v.sort_bucket<=substr(?,1,10)");
        bucketArgs.push(opts.cursor.sortTime);
      }
      if (offset > 0 && catalog.valid && !opts.feedId && !opts.tagId && bucketCountQuerySafe && ["all", "unread", "blocked"].includes(opts.view || "all")) {
        const count = opts.view === "unread" ? "visible_count" : opts.view === "blocked" ? "blocked_count" : "entry_count-blocked_count";
        let skipped = 0, found = false;
        let categoryOnly = !!opts.categoryId && bucketSourceWhere.length === 1, wholeScope = false;
        if (bucketSourceWhere.length && !categoryOnly) {
          const sourcePredicates = bucketSourceWhere.map((part) => part.replace(/\bfeed_id\b/g, "f.id"));
          const scope = opts.categoryId ? "f.category_id=?" : "1";
          const proof2 = db.prepare(`SELECT NOT EXISTS(SELECT 1 FROM feeds f WHERE ${scope} AND NOT (${sourcePredicates.join(" AND ")})) valid`).get(...opts.categoryId ? [opts.categoryId, ...bucketSourceArgs] : bucketSourceArgs);
          wholeScope = !!proof2.valid;
          categoryOnly = wholeScope && !!opts.categoryId;
        }
        let sourceIndex = "";
        if (bucketSourceWhere.length && !categoryOnly && !wholeScope) {
          const primary = db.prepare("SELECT name FROM pragma_index_list('rivu_feed_timeline_bucket_counts') WHERE origin='pk'").get();
          if (!primary) throw Error("\u6765\u6E90\u65F6\u95F4\u5206\u6876\u4E3B\u952E\u7F3A\u5931");
          sourceIndex = ` INDEXED BY "${primary.name.replaceAll('"', '""')}"`;
        }
        const buckets = categoryOnly ? db.prepare(`SELECT sort_bucket,${count} n FROM rivu_category_timeline_bucket_counts WHERE ${["category_id=?", `${count}>0`, ...bucketDateWhere].join(" AND ")} ORDER BY sort_bucket DESC`).iterate(opts.categoryId, ...bucketDateArgs) : bucketSourceWhere.length && !wholeScope ? db.prepare(`SELECT sort_bucket,SUM(${count}) n FROM rivu_feed_timeline_bucket_counts${sourceIndex} WHERE ${[...bucketSourceWhere, ...bucketDateWhere].join(" AND ")} GROUP BY sort_bucket HAVING SUM(${count})>0 ORDER BY sort_bucket DESC`).iterate(...bucketSourceArgs, ...bucketDateArgs) : db.prepare(`SELECT sort_bucket,${count} n FROM rivu_timeline_bucket_counts WHERE ${[`${count}>0`, ...bucketDateWhere].join(" AND ")} ORDER BY sort_bucket DESC`).iterate(...bucketDateArgs);
        for (const row of buckets) {
          const size = Number(row.n);
          if (offset < skipped + size) {
            candidateWhere.push("v.sort_bucket<=?");
            bucketArgs.push(row.sort_bucket);
            pageOffset = offset - skipped;
            found = true;
            break;
          }
          skipped += size;
        }
        if (!found) return [];
      }
      const scoped = projectionWhere.some((part) => part.includes("v.feed_id IN"));
      const candidateIndex = opts.view === "unread" ? scoped ? "rivu_visibility_unread_scoped" : "rivu_visibility_unread" : scoped ? "rivu_visibility_scoped" : "rivu_visibility_timeline";
      const candidates = `SELECT v.entry_id id,v.sort_time FROM rivu_entry_visibility v INDEXED BY ${candidateIndex} WHERE ${[validFeed, ...candidateWhere].join(" AND ")} ORDER BY v.sort_bucket DESC,v.sort_time DESC,v.entry_id DESC LIMIT ? OFFSET ?`;
      const proof = "", pageArgs = [...args, ...bucketArgs, limit, pageOffset];
      if (!opts.listOnly) {
        const page2 = `WITH ${proof}selected AS MATERIALIZED (${candidates}), ranked AS MATERIALIZED (SELECT id,ROW_NUMBER() OVER (ORDER BY sort_time DESC,id DESC) page_order FROM selected), physical AS MATERIALIZED (SELECT ranked.id,ranked.page_order,m.rowid storage_rowid FROM ranked CROSS JOIN entries m INDEXED BY entries_list_metadata ON m.id=ranked.id ORDER BY m.rowid) ${select},physical.page_order _rivu_page_order FROM physical CROSS JOIN entries e ON e.rowid=physical.storage_rowid${metadataJoin} JOIN feeds f ON f.id=m.feed_id`;
        return db.prepare(page2).all(...pageArgs).sort((a, b) => Number(a._rivu_page_order) - Number(b._rivu_page_order)).map(({ _rivu_page_order, ...row }) => row);
      }
      const index = opts.listOnly ? " INDEXED BY entries_list_metadata" : "";
      const page = `WITH ${proof}selected AS MATERIALIZED (${candidates}) ${select} FROM selected CROSS JOIN entries e${index} ON e.id=selected.id${metadataJoin} JOIN feeds f ON f.id=${opts.listOnly ? "e" : "m"}.feed_id ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC`;
      return db.prepare(page).all(...pageArgs);
    } finally {
      if (ownsSnapshot) db.exec("ROLLBACK");
    }
  }
  if (opts.listOnly) {
    const candidates = `SELECT e.id FROM entries e JOIN feeds f ON f.id=e.feed_id ${fallbackWhere.length ? "WHERE " + fallbackWhere.join(" AND ") : ""} ${order}`;
    const page = `WITH selected AS MATERIALIZED (${candidates}) ${select} FROM selected CROSS JOIN entries e INDEXED BY entries_list_metadata ON e.id=selected.id JOIN feeds f ON f.id=e.feed_id ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC`;
    return db.prepare(page).all(...args, limit, offset);
  }
  const sql = `${select} FROM entries e${metadataJoin} JOIN feeds f ON f.id=e.feed_id ${fallbackWhere.length ? "WHERE " + fallbackWhere.join(" AND ") : ""} ${order}`;
  return db.prepare(sql).all(...args, limit, offset);
}

// server/database.ts
var import_node_sqlite = require("node:sqlite");
var import_node_crypto3 = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// server/ai-text.ts
var import_jsdom = require("jsdom");
function aiPlainText(html) {
  const page = new import_jsdom.JSDOM(html);
  try {
    page.window.document.querySelectorAll("script,style,noscript").forEach((node) => node.remove());
    page.window.document.querySelectorAll("p,div,li,br,h1,h2,h3,blockquote").forEach((node) => node.append("\n"));
    const text = page.window.document.body.textContent?.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim() || "";
    return text;
  } finally {
    page.window.close();
  }
}

// server/media.ts
var import_jsdom2 = require("jsdom");
function mediaUrl(raw, base) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim(), base);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
function bodyImages(html, base) {
  if (!html || !/<img\b/i.test(html)) return [];
  const document = import_jsdom2.JSDOM.fragment(html), result = [], seen = /* @__PURE__ */ new Set();
  for (const image of document.querySelectorAll("img[src]")) {
    const url = mediaUrl(image.getAttribute("src"), base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push({ kind: "image", url, mime: null, source: "body", title: image.getAttribute("alt")?.trim().slice(0, 200) || null });
    if (result.length >= 50) break;
  }
  return result;
}
function uniqueMedia(items) {
  const seen = /* @__PURE__ */ new Set();
  return items.filter((item) => {
    const key = `${item.kind}:${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 60);
}

// server/entry-identity.ts
var import_node_crypto = require("node:crypto");
var digest = (value) => (0, import_node_crypto.createHash)("sha256").update(value).digest("hex");
function normalizedEntryUrl(raw, base, removeTracking = false) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 8192) return void 0;
  try {
    const url = new URL(raw, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return void 0;
    url.hash = "";
    if (removeTracking) {
      for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key) || /^(fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return void 0;
  }
}
function declaredCanonical(raw, articleUrl, base) {
  const article = normalizedEntryUrl(articleUrl, base), canonical = normalizedEntryUrl(raw, article || base, true);
  return article && canonical && new URL(article).origin === new URL(canonical).origin ? canonical : void 0;
}
function entryIdentities(input, base) {
  const result = [{ kind: "hash", value: input.hash }];
  if (input.guid?.trim()) result.push({ kind: "guid", value: digest(input.guid.trim()) });
  const url = normalizedEntryUrl(input.url, base), canonical = normalizedEntryUrl(input.url, base, true), declared = declaredCanonical(input.canonicalUrl, input.url || void 0, base);
  if (url) result.push({ kind: "url", value: url });
  for (const value of /* @__PURE__ */ new Set([canonical, declared])) if (value) result.push({ kind: "canonical", value });
  const body = input.content || input.description;
  if (body?.trim()) result.push({ kind: "content", value: digest(JSON.stringify([input.title.trim(), input.author?.trim() || "", body])) });
  return result;
}

// server/source-icons.ts
var import_node_crypto2 = require("node:crypto");
var headers = new Set(["png", "jpeg", "webp", "gif", "avif", "x-icon", "vnd.microsoft.icon"].map((type) => `data:image/${type};base64`));
function sourceIconKey(value) {
  if (typeof value !== "string" || value.length > 35e4) return null;
  const comma = value.indexOf(",");
  if (comma < 0 || !headers.has(value.slice(0, comma))) return null;
  const body = value.slice(comma + 1), bytes = Buffer.from(body, "base64");
  if (!bytes.length || bytes.length > 256 * 1024 || bytes.toString("base64").replace(/=+$/, "") !== body.replace(/=+$/, "")) return null;
  return (0, import_node_crypto2.createHash)("sha256").update(value).digest("hex");
}

// server/unread-counts.ts
var blocked2 = (entry) => `CASE WHEN (
 EXISTS(SELECT 1 FROM rule_matches rm JOIN rules r ON r.id=rm.rule_id WHERE rm.entry_id=${entry}.id AND r.enabled=1 AND r.action_type='block')
 OR EXISTS(SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=${entry}.id AND a.decision='block')
) THEN 1 ELSE 0 END`;
var visible = (entry) => `CASE WHEN ${entry}.read=0 AND NOT (
 EXISTS(SELECT 1 FROM rule_matches rm JOIN rules r ON r.id=rm.rule_id WHERE rm.entry_id=${entry}.id AND r.enabled=1 AND r.action_type IN ('block','mute'))
 OR EXISTS(SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=${entry}.id AND a.decision IN ('block','mute'))
) THEN 1 ELSE 0 END`;
var reconcile = (ids) => `UPDATE rivu_entry_visibility SET (feed_id,visible,sort_time,blocked,sort_bucket)=(
 SELECT e.feed_id,${visible("e")},COALESCE(e.published_at,e.fetched_at),${blocked2("e")},substr(COALESCE(e.published_at,e.fetched_at),1,10) FROM entries e INDEXED BY entries_list_metadata WHERE e.id=rivu_entry_visibility.entry_id
) WHERE entry_id IN (${ids}) AND EXISTS(SELECT 1 FROM entries e WHERE e.id=rivu_entry_visibility.entry_id);`;
var affectedRule = (id) => `SELECT entry_id FROM rule_matches WHERE rule_id=${id}`;
var feedCounter = (id) => `INSERT INTO rivu_feed_unread_counts(feed_id,unread_count)
 SELECT ${id},count(*) FROM rivu_entry_visibility WHERE feed_id=${id} AND visible=1
 ON CONFLICT(feed_id) DO UPDATE SET unread_count=excluded.unread_count;`;
var sourceBucketAdd = (entry, condition = "1") => `INSERT INTO rivu_feed_timeline_bucket_counts(sort_bucket,feed_id,category_id,entry_count,visible_count,blocked_count)
 SELECT ${entry}.sort_bucket,${entry}.feed_id,(SELECT category_id FROM feeds WHERE id=${entry}.feed_id),1,${entry}.visible,${entry}.blocked WHERE ${condition}
 ON CONFLICT(sort_bucket,feed_id) DO UPDATE SET entry_count=entry_count+1,visible_count=visible_count+excluded.visible_count,blocked_count=blocked_count+excluded.blocked_count;`;
var sourceBucketRemove = (entry, condition = "1") => `UPDATE rivu_feed_timeline_bucket_counts SET entry_count=entry_count-1,visible_count=visible_count-${entry}.visible,blocked_count=blocked_count-${entry}.blocked WHERE sort_bucket=${entry}.sort_bucket AND feed_id=${entry}.feed_id AND (${condition});
 DELETE FROM rivu_feed_timeline_bucket_counts WHERE sort_bucket=${entry}.sort_bucket AND feed_id=${entry}.feed_id AND entry_count=0 AND (${condition});`;
var categoryBucketAdd = (row, condition = "1") => `INSERT INTO rivu_category_timeline_bucket_counts(category_id,sort_bucket,entry_count,visible_count,blocked_count)
 SELECT ${row}.category_id,${row}.sort_bucket,${row}.entry_count,${row}.visible_count,${row}.blocked_count WHERE ${row}.category_id IS NOT NULL AND ${row}.entry_count>0 AND (${condition})
 ON CONFLICT(category_id,sort_bucket) DO UPDATE SET entry_count=entry_count+excluded.entry_count,visible_count=visible_count+excluded.visible_count,blocked_count=blocked_count+excluded.blocked_count;`;
var categoryBucketRemove = (row, condition = "1") => `UPDATE rivu_category_timeline_bucket_counts SET entry_count=entry_count-${row}.entry_count,visible_count=visible_count-${row}.visible_count,blocked_count=blocked_count-${row}.blocked_count WHERE category_id=${row}.category_id AND sort_bucket=${row}.sort_bucket AND (${condition});
 DELETE FROM rivu_category_timeline_bucket_counts WHERE category_id=${row}.category_id AND sort_bucket=${row}.sort_bucket AND entry_count=0 AND (${condition});`;
var unreadCountTriggerNames = [
  "rivu_unread_state_insert",
  "rivu_unread_state_update",
  "rivu_unread_state_delete",
  "rivu_unread_entry_insert",
  "rivu_unread_entry_update",
  "rivu_unread_entry_delete",
  "rivu_unread_feed_insert",
  "rivu_unread_feed_update",
  "rivu_unread_feed_delete",
  "rivu_unread_match_insert",
  "rivu_unread_match_delete",
  "rivu_unread_match_update",
  "rivu_unread_rule_insert",
  "rivu_unread_rule_update",
  "rivu_unread_rule_delete",
  "rivu_unread_ai_insert",
  "rivu_unread_ai_delete",
  "rivu_unread_ai_update",
  "rivu_unread_source_bucket_insert",
  "rivu_unread_source_bucket_update",
  "rivu_unread_source_bucket_delete"
];
function installUnreadCounts(db) {
  if (!db.isTransaction) throw Error("\u672A\u8BFB\u7EDF\u8BA1\u8FC1\u79FB\u5FC5\u987B\u5728\u4E8B\u52A1\u5185\u6267\u884C");
  if (!db.prepare("PRAGMA table_info(feeds)").all().some((row) => row.name === "category_id")) throw Error("\u6570\u636E\u5E93\u7ED3\u6784\u4E0D\u5B8C\u6574\uFF1Afeeds.category_id");
  for (const name of unreadCountTriggerNames) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec("DROP INDEX IF EXISTS rivu_visibility_timeline; DROP INDEX IF EXISTS rivu_visibility_unread; DROP INDEX IF EXISTS rivu_visibility_scoped; DROP INDEX IF EXISTS rivu_visibility_unread_scoped");
  db.exec(`CREATE TABLE IF NOT EXISTS rivu_entry_visibility (
   entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id) ON DELETE CASCADE ON UPDATE CASCADE,
   feed_id TEXT NOT NULL,visible INTEGER NOT NULL CHECK(visible IN (0,1)),
   sort_time TEXT NOT NULL DEFAULT '',blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),sort_bucket TEXT NOT NULL DEFAULT ''
 );
 `);
  const columns = new Set(db.prepare("PRAGMA table_info(rivu_entry_visibility)").all().map((row) => String(row.name)));
  if (!columns.has("sort_time")) db.exec("ALTER TABLE rivu_entry_visibility ADD COLUMN sort_time TEXT NOT NULL DEFAULT ''");
  if (!columns.has("sort_bucket")) db.exec("ALTER TABLE rivu_entry_visibility ADD COLUMN sort_bucket TEXT NOT NULL DEFAULT ''");
  if (!columns.has("blocked")) db.exec("ALTER TABLE rivu_entry_visibility ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1))");
  db.exec(`
 CREATE INDEX IF NOT EXISTS rivu_visibility_feed ON rivu_entry_visibility(feed_id,visible);
 CREATE TABLE IF NOT EXISTS rivu_feed_unread_counts (
   feed_id TEXT PRIMARY KEY NOT NULL REFERENCES feeds(id) ON DELETE CASCADE ON UPDATE CASCADE,
   unread_count INTEGER NOT NULL CHECK(unread_count>=0)
 );
 CREATE TABLE IF NOT EXISTS rivu_source_entry_counts (
   feed_id TEXT PRIMARY KEY NOT NULL,entry_count INTEGER NOT NULL CHECK(entry_count>=0)
 );
 CREATE TABLE IF NOT EXISTS rivu_timeline_bucket_counts (
   sort_bucket TEXT PRIMARY KEY NOT NULL,
   entry_count INTEGER NOT NULL CHECK(entry_count>=0),
   visible_count INTEGER NOT NULL CHECK(visible_count>=0),
   blocked_count INTEGER NOT NULL CHECK(blocked_count>=0),
   CHECK(visible_count+blocked_count<=entry_count)
 );
 DROP TABLE IF EXISTS rivu_feed_timeline_bucket_counts;
 DROP TABLE IF EXISTS rivu_category_timeline_bucket_counts;
 CREATE TABLE rivu_feed_timeline_bucket_counts (
   sort_bucket TEXT NOT NULL,feed_id TEXT NOT NULL,category_id TEXT,
   entry_count INTEGER NOT NULL CHECK(entry_count>=0),visible_count INTEGER NOT NULL CHECK(visible_count>=0),blocked_count INTEGER NOT NULL CHECK(blocked_count>=0),
   PRIMARY KEY(sort_bucket,feed_id),CHECK(visible_count+blocked_count<=entry_count)
 ) WITHOUT ROWID;
 CREATE TABLE rivu_category_timeline_bucket_counts (
   category_id TEXT NOT NULL,sort_bucket TEXT NOT NULL,
   entry_count INTEGER NOT NULL CHECK(entry_count>=0),visible_count INTEGER NOT NULL CHECK(visible_count>=0),blocked_count INTEGER NOT NULL CHECK(blocked_count>=0),
   PRIMARY KEY(category_id,sort_bucket),CHECK(visible_count+blocked_count<=entry_count)
 ) WITHOUT ROWID;
 DELETE FROM rivu_entry_visibility; DELETE FROM rivu_feed_unread_counts; DELETE FROM rivu_source_entry_counts; DELETE FROM rivu_timeline_bucket_counts;
 INSERT INTO rivu_entry_visibility(entry_id,feed_id,visible,sort_time,blocked,sort_bucket)
 SELECT e.id,e.feed_id,${visible("e")},COALESCE(e.published_at,e.fetched_at),${blocked2("e")},substr(COALESCE(e.published_at,e.fetched_at),1,10) FROM entries e INDEXED BY entries_list_metadata;
 INSERT INTO rivu_feed_unread_counts(feed_id,unread_count)
 SELECT f.id,(SELECT count(*) FROM rivu_entry_visibility v WHERE v.feed_id=f.id AND v.visible=1) FROM feeds f;
 INSERT INTO rivu_source_entry_counts(feed_id,entry_count)
 SELECT feed_id,count(*) FROM rivu_entry_visibility GROUP BY feed_id;
 INSERT INTO rivu_timeline_bucket_counts(sort_bucket,entry_count,visible_count,blocked_count)
 SELECT sort_bucket,count(*),sum(visible),sum(blocked) FROM rivu_entry_visibility GROUP BY sort_bucket;
 INSERT INTO rivu_feed_timeline_bucket_counts(sort_bucket,feed_id,category_id,entry_count,visible_count,blocked_count)
 SELECT v.sort_bucket,v.feed_id,f.category_id,count(*),sum(v.visible),sum(v.blocked) FROM rivu_entry_visibility v LEFT JOIN feeds f ON f.id=v.feed_id GROUP BY v.sort_bucket,v.feed_id;
 INSERT INTO rivu_category_timeline_bucket_counts(category_id,sort_bucket,entry_count,visible_count,blocked_count)
 SELECT category_id,sort_bucket,sum(entry_count),sum(visible_count),sum(blocked_count) FROM rivu_feed_timeline_bucket_counts WHERE category_id IS NOT NULL GROUP BY category_id,sort_bucket;
 CREATE INDEX rivu_source_bucket_feed ON rivu_feed_timeline_bucket_counts(feed_id,sort_bucket);
 CREATE INDEX rivu_visibility_scoped ON rivu_entry_visibility(blocked,sort_bucket DESC,sort_time DESC,entry_id DESC,feed_id);
 CREATE INDEX rivu_visibility_unread_scoped ON rivu_entry_visibility(sort_bucket DESC,sort_time DESC,entry_id DESC,feed_id) WHERE visible=1;
 CREATE INDEX rivu_visibility_timeline ON rivu_entry_visibility(blocked,sort_bucket DESC,sort_time DESC,entry_id DESC);
 CREATE INDEX rivu_visibility_unread ON rivu_entry_visibility(sort_bucket DESC,sort_time DESC,entry_id DESC) WHERE visible=1;

 CREATE TRIGGER rivu_unread_state_insert AFTER INSERT ON rivu_entry_visibility BEGIN
   ${sourceBucketAdd("NEW")}
   UPDATE rivu_feed_unread_counts SET unread_count=unread_count+NEW.visible WHERE feed_id=NEW.feed_id;
   INSERT INTO rivu_source_entry_counts(feed_id,entry_count) VALUES(NEW.feed_id,1)
   ON CONFLICT(feed_id) DO UPDATE SET entry_count=entry_count+1;
   INSERT INTO rivu_timeline_bucket_counts(sort_bucket,entry_count,visible_count,blocked_count) VALUES(NEW.sort_bucket,1,NEW.visible,NEW.blocked)
   ON CONFLICT(sort_bucket) DO UPDATE SET entry_count=entry_count+1,visible_count=visible_count+excluded.visible_count,blocked_count=blocked_count+excluded.blocked_count;
 END;
 CREATE TRIGGER rivu_unread_state_delete AFTER DELETE ON rivu_entry_visibility BEGIN
   ${sourceBucketRemove("OLD")}
   UPDATE rivu_feed_unread_counts SET unread_count=unread_count-OLD.visible WHERE feed_id=OLD.feed_id;
   UPDATE rivu_source_entry_counts SET entry_count=entry_count-1 WHERE feed_id=OLD.feed_id;
   DELETE FROM rivu_source_entry_counts WHERE feed_id=OLD.feed_id AND entry_count=0;
   UPDATE rivu_timeline_bucket_counts SET entry_count=entry_count-1,visible_count=visible_count-OLD.visible,blocked_count=blocked_count-OLD.blocked WHERE sort_bucket=OLD.sort_bucket;
   DELETE FROM rivu_timeline_bucket_counts WHERE sort_bucket=OLD.sort_bucket AND entry_count=0;
 END;
 CREATE TRIGGER rivu_unread_state_update AFTER UPDATE OF feed_id,visible,blocked,sort_bucket ON rivu_entry_visibility
 WHEN OLD.feed_id IS NOT NEW.feed_id OR OLD.visible IS NOT NEW.visible OR OLD.blocked IS NOT NEW.blocked OR OLD.sort_bucket IS NOT NEW.sort_bucket BEGIN
   ${sourceBucketRemove("OLD", "OLD.feed_id IS NOT NEW.feed_id OR OLD.sort_bucket IS NOT NEW.sort_bucket")}
   ${sourceBucketAdd("NEW", "OLD.feed_id IS NOT NEW.feed_id OR OLD.sort_bucket IS NOT NEW.sort_bucket")}
   UPDATE rivu_feed_timeline_bucket_counts SET visible_count=visible_count+NEW.visible-OLD.visible,blocked_count=blocked_count+NEW.blocked-OLD.blocked WHERE sort_bucket=NEW.sort_bucket AND feed_id=NEW.feed_id AND OLD.feed_id IS NEW.feed_id AND OLD.sort_bucket IS NEW.sort_bucket AND (OLD.visible IS NOT NEW.visible OR OLD.blocked IS NOT NEW.blocked);
   UPDATE rivu_feed_unread_counts SET unread_count=unread_count-OLD.visible WHERE feed_id=OLD.feed_id AND (OLD.feed_id IS NOT NEW.feed_id OR OLD.visible IS NOT NEW.visible);
   UPDATE rivu_feed_unread_counts SET unread_count=unread_count+NEW.visible WHERE feed_id=NEW.feed_id AND (OLD.feed_id IS NOT NEW.feed_id OR OLD.visible IS NOT NEW.visible);
   UPDATE rivu_source_entry_counts SET entry_count=entry_count-1 WHERE feed_id=OLD.feed_id AND OLD.feed_id IS NOT NEW.feed_id;
   DELETE FROM rivu_source_entry_counts WHERE feed_id=OLD.feed_id AND entry_count=0 AND OLD.feed_id IS NOT NEW.feed_id;
   INSERT INTO rivu_source_entry_counts(feed_id,entry_count) SELECT NEW.feed_id,1 WHERE OLD.feed_id IS NOT NEW.feed_id
   ON CONFLICT(feed_id) DO UPDATE SET entry_count=entry_count+1;
   UPDATE rivu_timeline_bucket_counts SET entry_count=entry_count-1,visible_count=visible_count-OLD.visible,blocked_count=blocked_count-OLD.blocked WHERE sort_bucket=OLD.sort_bucket AND OLD.sort_bucket IS NOT NEW.sort_bucket;
   DELETE FROM rivu_timeline_bucket_counts WHERE sort_bucket=OLD.sort_bucket AND entry_count=0 AND OLD.sort_bucket IS NOT NEW.sort_bucket;
   INSERT INTO rivu_timeline_bucket_counts(sort_bucket,entry_count,visible_count,blocked_count) SELECT NEW.sort_bucket,1,NEW.visible,NEW.blocked WHERE OLD.sort_bucket IS NOT NEW.sort_bucket
   ON CONFLICT(sort_bucket) DO UPDATE SET entry_count=entry_count+1,visible_count=visible_count+excluded.visible_count,blocked_count=blocked_count+excluded.blocked_count;
   UPDATE rivu_timeline_bucket_counts SET visible_count=visible_count+NEW.visible-OLD.visible,blocked_count=blocked_count+NEW.blocked-OLD.blocked WHERE sort_bucket=NEW.sort_bucket AND OLD.sort_bucket IS NEW.sort_bucket AND (OLD.visible IS NOT NEW.visible OR OLD.blocked IS NOT NEW.blocked);
 END;
 CREATE TRIGGER rivu_unread_entry_insert AFTER INSERT ON entries BEGIN
   INSERT INTO rivu_entry_visibility(entry_id,feed_id,visible,sort_time,blocked,sort_bucket) SELECT e.id,e.feed_id,${visible("e")},COALESCE(e.published_at,e.fetched_at),${blocked2("e")},substr(COALESCE(e.published_at,e.fetched_at),1,10) FROM entries e WHERE e.id=NEW.id
   ON CONFLICT(entry_id) DO UPDATE SET feed_id=excluded.feed_id,visible=excluded.visible,sort_time=excluded.sort_time,blocked=excluded.blocked,sort_bucket=excluded.sort_bucket;
 END;
 CREATE TRIGGER rivu_unread_entry_update AFTER UPDATE OF read,feed_id,id,published_at,fetched_at ON entries BEGIN
   UPDATE rivu_entry_visibility SET entry_id=NEW.id WHERE entry_id=OLD.id AND OLD.id IS NOT NEW.id;
   ${reconcile("SELECT NEW.id")}
 END;
 CREATE TRIGGER rivu_unread_entry_delete AFTER DELETE ON entries BEGIN DELETE FROM rivu_entry_visibility WHERE entry_id=OLD.id; END;
 CREATE TRIGGER rivu_unread_feed_insert AFTER INSERT ON feeds BEGIN
   ${feedCounter("NEW.id")}
   UPDATE rivu_feed_timeline_bucket_counts SET category_id=NEW.category_id WHERE feed_id=NEW.id AND category_id IS NOT NEW.category_id;
 END;
 CREATE TRIGGER rivu_unread_feed_update AFTER UPDATE OF id,category_id ON feeds WHEN OLD.id IS NOT NEW.id OR OLD.category_id IS NOT NEW.category_id BEGIN
   DELETE FROM rivu_feed_unread_counts WHERE feed_id=OLD.id AND OLD.id IS NOT NEW.id; ${feedCounter("NEW.id")}
   UPDATE rivu_feed_timeline_bucket_counts SET category_id=NULL WHERE feed_id=OLD.id AND OLD.id IS NOT NEW.id AND category_id IS NOT NULL;
   UPDATE rivu_feed_timeline_bucket_counts SET category_id=NEW.category_id WHERE feed_id=NEW.id AND category_id IS NOT NEW.category_id;
 END;
 CREATE TRIGGER rivu_unread_feed_delete AFTER DELETE ON feeds BEGIN
   DELETE FROM rivu_feed_unread_counts WHERE feed_id=OLD.id;
   UPDATE rivu_feed_timeline_bucket_counts SET category_id=NULL WHERE feed_id=OLD.id AND category_id IS NOT NULL;
 END;
 CREATE TRIGGER rivu_unread_source_bucket_insert AFTER INSERT ON rivu_feed_timeline_bucket_counts BEGIN ${categoryBucketAdd("NEW")} END;
 CREATE TRIGGER rivu_unread_source_bucket_delete AFTER DELETE ON rivu_feed_timeline_bucket_counts BEGIN ${categoryBucketRemove("OLD")} END;
 CREATE TRIGGER rivu_unread_source_bucket_update AFTER UPDATE OF category_id,sort_bucket,entry_count,visible_count,blocked_count ON rivu_feed_timeline_bucket_counts
 WHEN OLD.category_id IS NOT NEW.category_id OR OLD.sort_bucket IS NOT NEW.sort_bucket OR OLD.entry_count IS NOT NEW.entry_count OR OLD.visible_count IS NOT NEW.visible_count OR OLD.blocked_count IS NOT NEW.blocked_count BEGIN
   ${categoryBucketRemove("OLD", "OLD.category_id IS NOT NEW.category_id OR OLD.sort_bucket IS NOT NEW.sort_bucket")}
   ${categoryBucketAdd("NEW", "OLD.category_id IS NOT NEW.category_id OR OLD.sort_bucket IS NOT NEW.sort_bucket")}
   UPDATE rivu_category_timeline_bucket_counts SET entry_count=entry_count+NEW.entry_count-OLD.entry_count,visible_count=visible_count+NEW.visible_count-OLD.visible_count,blocked_count=blocked_count+NEW.blocked_count-OLD.blocked_count WHERE category_id=NEW.category_id AND sort_bucket=NEW.sort_bucket AND OLD.category_id IS NEW.category_id AND OLD.sort_bucket IS NEW.sort_bucket;
   DELETE FROM rivu_category_timeline_bucket_counts WHERE category_id=NEW.category_id AND sort_bucket=NEW.sort_bucket AND entry_count=0;
 END;
 CREATE TRIGGER rivu_unread_match_insert AFTER INSERT ON rule_matches BEGIN ${reconcile("SELECT NEW.entry_id")} END;
 CREATE TRIGGER rivu_unread_match_delete AFTER DELETE ON rule_matches BEGIN ${reconcile("SELECT OLD.entry_id")} END;
 CREATE TRIGGER rivu_unread_match_update AFTER UPDATE OF entry_id,rule_id ON rule_matches BEGIN
   ${reconcile("SELECT OLD.entry_id UNION SELECT NEW.entry_id")}
 END;
 CREATE TRIGGER rivu_unread_rule_insert AFTER INSERT ON rules BEGIN ${reconcile(affectedRule("NEW.id"))} END;
 CREATE TRIGGER rivu_unread_rule_delete AFTER DELETE ON rules BEGIN ${reconcile(affectedRule("OLD.id"))} END;
 CREATE TRIGGER rivu_unread_rule_update AFTER UPDATE OF id,enabled,action_type ON rules BEGIN
   ${reconcile(`${affectedRule("OLD.id")} UNION ${affectedRule("NEW.id")}`)}
 END;
 CREATE TRIGGER rivu_unread_ai_insert AFTER INSERT ON ai_filter_decisions BEGIN ${reconcile("SELECT NEW.entry_id")} END;
 CREATE TRIGGER rivu_unread_ai_delete AFTER DELETE ON ai_filter_decisions BEGIN ${reconcile("SELECT OLD.entry_id")} END;
 CREATE TRIGGER rivu_unread_ai_update AFTER UPDATE OF entry_id,decision ON ai_filter_decisions BEGIN
   ${reconcile("SELECT OLD.entry_id UNION SELECT NEW.entry_id")}
 END;`);
}
function validateVisibilityIndexes(db) {
  for (const [table, expectedKeys] of [["rivu_timeline_bucket_counts", ["sort_bucket"]], ["rivu_feed_timeline_bucket_counts", ["sort_bucket", "feed_id"]], ["rivu_category_timeline_bucket_counts", ["category_id", "sort_bucket"]]]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all(), keys = columns.filter((row) => Number(row.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
    const primary = db.prepare(`PRAGMA index_list(${table})`).all().find((row) => row.origin === "pk");
    const detail = primary ? db.prepare("SELECT * FROM pragma_index_xinfo(?)").all(primary.name).filter((row) => row.key === 1) : [];
    if (keys.map((row) => row.name).join(",") !== expectedKeys.join(",") || keys.some((row) => row.type !== "TEXT" || row.notnull !== 1) || primary?.unique !== 1 || primary?.partial !== 0 || detail.map((row) => row.name).join(",") !== expectedKeys.join(",") || detail.some((row) => row.coll !== "BINARY" || row.desc !== 0)) throw Error(`\u6570\u636E\u5E93\u65F6\u95F4\u5206\u6876\u4E3B\u952E\u65E0\u6548\uFF1A${table}`);
    if (expectedKeys.length === 2 && db.prepare("SELECT wr FROM pragma_table_list WHERE schema=? AND name=?").get("main", table)?.wr !== 1) throw Error(`\u6570\u636E\u5E93\u65F6\u95F4\u5206\u6876\u805A\u7C07\u7ED3\u6784\u65E0\u6548\uFF1A${table}`);
  }
  const sourceIndex = db.prepare(`SELECT name,"unique",partial FROM pragma_index_list('rivu_feed_timeline_bucket_counts') WHERE name='rivu_source_bucket_feed'`).get();
  const sourceKeys = db.prepare("SELECT name,coll,desc FROM pragma_index_xinfo('rivu_source_bucket_feed') WHERE key=1 ORDER BY seqno").all();
  if (!sourceIndex || sourceIndex.unique !== 0 || sourceIndex.partial !== 0 || sourceKeys.map((row) => row.name).join(",") !== "feed_id,sort_bucket" || sourceKeys.some((row) => row.coll !== "BINARY" || row.desc !== 0)) throw Error("\u6570\u636E\u5E93\u6765\u6E90\u5206\u6876\u5B9A\u4F4D\u7D22\u5F15\u65E0\u6548");
  for (const [name, expected, partial] of [
    ["rivu_visibility_timeline", "blocked:0,sort_bucket:1,sort_time:1,entry_id:1", 0],
    ["rivu_visibility_unread", "sort_bucket:1,sort_time:1,entry_id:1", 1],
    ["rivu_visibility_scoped", "blocked:0,sort_bucket:1,sort_time:1,entry_id:1,feed_id:0", 0],
    ["rivu_visibility_unread_scoped", "sort_bucket:1,sort_time:1,entry_id:1,feed_id:0", 1]
  ]) {
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=? AND tbl_name='rivu_entry_visibility'").get(name);
    const detail = db.prepare(`PRAGMA index_xinfo(${name})`).all().filter((row) => row.key === 1);
    const definition = detail.map((row) => `${row.name}:${row.desc}`).join(",");
    const flags = db.prepare("PRAGMA index_list(rivu_entry_visibility)").all().find((row) => row.name === name);
    if (!index || definition !== expected || detail.some((row) => row.coll !== "BINARY") || flags?.partial !== partial || partial && !/\bWHERE\s+visible\s*=\s*1\s*$/i.test(String(index.sql))) throw Error(`\u6570\u636E\u5E93\u6392\u5E8F\u7D22\u5F15\u65E0\u6548\uFF1A${name}`);
  }
}
function validateUnreadCounts(db) {
  validateVisibilityIndexes(db);
  for (const name of unreadCountTriggerNames) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw Error(`\u672A\u8BFB\u7EDF\u8BA1\u89E6\u53D1\u5668\u7F3A\u5931\uFF1A${name}`);
  const mismatch = db.prepare(`SELECT e.id FROM entries e INDEXED BY entries_list_metadata LEFT JOIN rivu_entry_visibility v ON v.entry_id=e.id
 WHERE v.entry_id IS NULL OR v.feed_id IS NOT e.feed_id OR v.visible IS NOT (${visible("e")})
 OR v.sort_bucket IS NOT substr(COALESCE(e.published_at,e.fetched_at),1,10) OR v.sort_time IS NOT COALESCE(e.published_at,e.fetched_at) OR v.blocked IS NOT (${blocked2("e")}) LIMIT 1`).get();
  if (mismatch || db.prepare("SELECT 1 FROM rivu_entry_visibility v LEFT JOIN entries e ON e.id=v.entry_id WHERE e.id IS NULL LIMIT 1").get()) throw Error("\u6587\u7AE0\u53EF\u89C1\u72B6\u6001\u4E0E\u539F\u6570\u636E\u4E0D\u4E00\u81F4");
  if (db.prepare(`WITH expected AS MATERIALIZED (
 SELECT sort_bucket,count(*) entry_count,sum(visible) visible_count,sum(blocked) blocked_count FROM rivu_entry_visibility GROUP BY sort_bucket
 ) SELECT e.sort_bucket FROM expected e LEFT JOIN rivu_timeline_bucket_counts c ON c.sort_bucket=e.sort_bucket
 WHERE c.sort_bucket IS NULL OR c.entry_count IS NOT e.entry_count OR c.visible_count IS NOT e.visible_count OR c.blocked_count IS NOT e.blocked_count
 UNION ALL SELECT c.sort_bucket FROM rivu_timeline_bucket_counts c LEFT JOIN expected e ON e.sort_bucket=c.sort_bucket WHERE e.sort_bucket IS NULL LIMIT 1`).get()) throw Error("\u65F6\u95F4\u5206\u6876\u8BA1\u6570\u4E0E\u6587\u7AE0\u72B6\u6001\u4E0D\u4E00\u81F4");
  if (db.prepare(`WITH expected AS MATERIALIZED (
 SELECT sort_bucket,feed_id,count(*) entry_count,sum(visible) visible_count,sum(blocked) blocked_count FROM rivu_entry_visibility GROUP BY sort_bucket,feed_id
 ) SELECT e.sort_bucket FROM expected e LEFT JOIN rivu_feed_timeline_bucket_counts c ON c.sort_bucket=e.sort_bucket AND c.feed_id=e.feed_id
 WHERE c.sort_bucket IS NULL OR c.entry_count IS NOT e.entry_count OR c.visible_count IS NOT e.visible_count OR c.blocked_count IS NOT e.blocked_count
 UNION ALL SELECT c.sort_bucket FROM rivu_feed_timeline_bucket_counts c LEFT JOIN expected e ON e.sort_bucket=c.sort_bucket AND e.feed_id=c.feed_id WHERE e.sort_bucket IS NULL LIMIT 1`).get()) throw Error("\u6765\u6E90\u65F6\u95F4\u5206\u6876\u8BA1\u6570\u4E0E\u6587\u7AE0\u72B6\u6001\u4E0D\u4E00\u81F4");
  if (db.prepare("SELECT 1 FROM rivu_feed_timeline_bucket_counts c LEFT JOIN feeds f ON f.id=c.feed_id WHERE c.category_id IS NOT f.category_id LIMIT 1").get()) throw Error("\u6765\u6E90\u65F6\u95F4\u5206\u6876\u5206\u7C7B\u4E0E\u6765\u6E90\u4E0D\u4E00\u81F4");
  if (db.prepare(`WITH expected AS MATERIALIZED (
 SELECT f.category_id,v.sort_bucket,count(*) entry_count,sum(v.visible) visible_count,sum(v.blocked) blocked_count FROM rivu_entry_visibility v JOIN feeds f ON f.id=v.feed_id WHERE f.category_id IS NOT NULL GROUP BY f.category_id,v.sort_bucket
 ) SELECT e.category_id FROM expected e LEFT JOIN rivu_category_timeline_bucket_counts c ON c.category_id=e.category_id AND c.sort_bucket=e.sort_bucket
 WHERE c.category_id IS NULL OR c.entry_count IS NOT e.entry_count OR c.visible_count IS NOT e.visible_count OR c.blocked_count IS NOT e.blocked_count
 UNION ALL SELECT c.category_id FROM rivu_category_timeline_bucket_counts c LEFT JOIN expected e ON e.category_id=c.category_id AND e.sort_bucket=c.sort_bucket WHERE e.category_id IS NULL LIMIT 1`).get()) throw Error("\u5206\u7C7B\u65F6\u95F4\u5206\u6876\u8BA1\u6570\u4E0E\u6587\u7AE0\u72B6\u6001\u4E0D\u4E00\u81F4");
  if (db.prepare(`SELECT c.feed_id FROM rivu_source_entry_counts c
 WHERE c.entry_count<=0 OR c.entry_count IS NOT (SELECT count(*) FROM rivu_entry_visibility v WHERE v.feed_id=c.feed_id)
 UNION ALL SELECT v.feed_id FROM rivu_entry_visibility v LEFT JOIN rivu_source_entry_counts c ON c.feed_id=v.feed_id WHERE c.feed_id IS NULL LIMIT 1`).get()) throw Error("\u6765\u6E90\u6761\u76EE\u8BA1\u6570\u4E0E\u6587\u7AE0\u72B6\u6001\u4E0D\u4E00\u81F4");
  if (db.prepare(`SELECT f.id FROM feeds f LEFT JOIN rivu_feed_unread_counts c ON c.feed_id=f.id WHERE c.feed_id IS NULL OR c.unread_count IS NOT
 (SELECT count(*) FROM rivu_entry_visibility v WHERE v.feed_id=f.id AND v.visible=1) LIMIT 1`).get() || db.prepare("SELECT 1 FROM rivu_feed_unread_counts c LEFT JOIN feeds f ON f.id=c.feed_id WHERE f.id IS NULL LIMIT 1").get()) throw Error("\u8BA2\u9605\u672A\u8BFB\u8BA1\u6570\u4E0E\u6587\u7AE0\u72B6\u6001\u4E0D\u4E00\u81F4");
}

// server/raw-unread-projection.ts
var rawUnreadTriggerNames = ["rivu_raw_unread_state_insert", "rivu_raw_unread_state_update", "rivu_raw_unread_state_delete"];
var eligible = `e.read=0 AND NOT EXISTS(SELECT 1 FROM rule_matches m JOIN rules r ON r.id=m.rule_id WHERE m.entry_id=e.id AND r.enabled=1 AND r.action_type='block') AND NOT EXISTS(SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=e.id AND a.decision='block')`;
var reconcile2 = `DELETE FROM rivu_raw_unread_entries WHERE entry_id=NEW.entry_id AND (NEW.blocked<>0 OR NOT EXISTS(SELECT 1 FROM entries e INDEXED BY entries_list_metadata WHERE e.id=NEW.entry_id AND e.read=0));
 INSERT INTO rivu_raw_unread_entries(entry_id,feed_id,sort_time,sort_bucket)
 SELECT NEW.entry_id,NEW.feed_id,NEW.sort_time,NEW.sort_bucket FROM entries e INDEXED BY entries_list_metadata WHERE e.id=NEW.entry_id AND e.read=0 AND NEW.blocked=0
 ON CONFLICT(entry_id) DO UPDATE SET feed_id=excluded.feed_id,sort_time=excluded.sort_time,sort_bucket=excluded.sort_bucket;`;
function installRawUnreadProjection(db) {
  if (!db.isTransaction) throw Error("\u539F\u59CB\u672A\u8BFB\u6295\u5F71\u5FC5\u987B\u5728\u8FC1\u79FB\u4E8B\u52A1\u5185\u5B89\u88C5");
  for (const name of rawUnreadTriggerNames) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec(`CREATE TABLE IF NOT EXISTS rivu_raw_unread_entries(
  entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id) ON DELETE CASCADE ON UPDATE CASCADE,
  feed_id TEXT NOT NULL,sort_time TEXT NOT NULL,sort_bucket TEXT NOT NULL
 );
 DELETE FROM rivu_raw_unread_entries;
 INSERT INTO rivu_raw_unread_entries(entry_id,feed_id,sort_time,sort_bucket)
 SELECT v.entry_id,v.feed_id,v.sort_time,v.sort_bucket FROM rivu_entry_visibility v CROSS JOIN entries e INDEXED BY entries_list_metadata ON e.id=v.entry_id WHERE v.blocked=0 AND e.read=0;
 CREATE INDEX IF NOT EXISTS rivu_raw_unread_timeline ON rivu_raw_unread_entries(sort_bucket DESC,sort_time DESC,entry_id DESC,feed_id);
 CREATE INDEX IF NOT EXISTS rivu_raw_unread_feed ON rivu_raw_unread_entries(feed_id,sort_bucket DESC,sort_time DESC,entry_id DESC);
 CREATE TRIGGER rivu_raw_unread_state_insert AFTER INSERT ON rivu_entry_visibility BEGIN ${reconcile2} END;
 CREATE TRIGGER rivu_raw_unread_state_update AFTER UPDATE OF entry_id,feed_id,visible,blocked,sort_time,sort_bucket ON rivu_entry_visibility BEGIN
  DELETE FROM rivu_raw_unread_entries WHERE entry_id=OLD.entry_id AND OLD.entry_id IS NOT NEW.entry_id;
  ${reconcile2}
 END;
 CREATE TRIGGER rivu_raw_unread_state_delete AFTER DELETE ON rivu_entry_visibility BEGIN DELETE FROM rivu_raw_unread_entries WHERE entry_id=OLD.entry_id; END;`);
  validateRawUnreadStructure(db);
}
function validateRawUnreadStructure(db) {
  const columns = db.prepare("PRAGMA table_info(rivu_raw_unread_entries)").all();
  for (const name of ["entry_id", "feed_id", "sort_time", "sort_bucket"]) {
    const column = columns.find((row) => row.name === name);
    if (!column || column.type !== "TEXT" || column.notnull !== 1 || column.pk !== (name === "entry_id" ? 1 : 0)) throw Error("\u539F\u59CB\u672A\u8BFB\u5217\u7EA6\u675F\u65E0\u6548\uFF1A" + name);
  }
  const foreign = db.prepare("PRAGMA foreign_key_list(rivu_raw_unread_entries)").all();
  if (foreign.length !== 1 || foreign[0].table !== "entries" || foreign[0].from !== "entry_id" || foreign[0].to !== "id" || foreign[0].on_update !== "CASCADE" || foreign[0].on_delete !== "CASCADE") throw Error("\u539F\u59CB\u672A\u8BFB\u8EAB\u4EFD\u5916\u952E\u65E0\u6548");
  const indexes = db.prepare("PRAGMA index_list(rivu_raw_unread_entries)").all(), primary = indexes.find((row) => row.origin === "pk");
  if (!primary || primary.unique !== 1 || primary.partial !== 0 || indexes.some((row) => row.unique === 1 && row.origin !== "pk")) throw Error("\u539F\u59CB\u672A\u8BFB\u4E3B\u952E\u65E0\u6548");
  const primaryKeys = db.prepare("SELECT name,coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno").all(primary.name);
  if (primaryKeys.length !== 1 || primaryKeys[0].name !== "entry_id" || primaryKeys[0].coll !== "BINARY") throw Error("\u539F\u59CB\u672A\u8BFB\u4E3B\u952E\u6392\u5E8F\u65E0\u6548");
  for (const name of rawUnreadTriggerNames) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw Error("\u539F\u59CB\u672A\u8BFB\u89E6\u53D1\u5668\u7F3A\u5931\uFF1A" + name);
  for (const [name, expected] of [["rivu_raw_unread_timeline", "sort_bucket:1,sort_time:1,entry_id:1,feed_id:0"], ["rivu_raw_unread_feed", "feed_id:0,sort_bucket:1,sort_time:1,entry_id:1"]]) {
    const index = indexes.find((row) => row.name === name);
    if (!index || index.unique !== 0 || index.partial !== 0) throw Error("\u539F\u59CB\u672A\u8BFB\u7D22\u5F15\u6807\u5FD7\u65E0\u6548\uFF1A" + name);
    const keys = db.prepare("SELECT name,desc,coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno").all(name);
    if (keys.map((row) => `${row.name}:${row.desc}`).join(",") !== expected || keys.some((row) => row.coll !== "BINARY")) throw Error("\u539F\u59CB\u672A\u8BFB\u7D22\u5F15\u65E0\u6548\uFF1A" + name);
  }
}
function validateRawUnreadProjection(db) {
  validateRawUnreadStructure(db);
  if (db.prepare(`SELECT r.entry_id FROM rivu_raw_unread_entries r LEFT JOIN entries e INDEXED BY entries_list_metadata ON e.id=r.entry_id
  WHERE e.id IS NULL OR r.feed_id IS NOT e.feed_id OR r.sort_time IS NOT COALESCE(e.published_at,e.fetched_at) OR r.sort_bucket IS NOT substr(COALESCE(e.published_at,e.fetched_at),1,10) OR NOT (${eligible})
  UNION ALL SELECT e.id FROM entries e INDEXED BY entries_list_metadata LEFT JOIN rivu_raw_unread_entries r ON r.entry_id=e.id WHERE ${eligible} AND r.entry_id IS NULL LIMIT 1`).get()) throw Error("\u539F\u59CB\u672A\u8BFB\u6295\u5F71\u4E0E\u6587\u7AE0\u6216\u5C4F\u853D\u72B6\u6001\u4E0D\u4E00\u81F4");
}

// server/stable-storage.ts
var tables = ["entries", "ai_results"];
var quote = (name) => '"' + name.replaceAll('"', '""') + '"';
function installStableStorageKeys(db) {
  if (!db.isTransaction || db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 0 || db.prepare("PRAGMA legacy_alter_table").get()?.legacy_alter_table !== 1) throw Error("\u7A33\u5B9A\u5B58\u50A8\u8FC1\u79FB\u9700\u8981\u4E8B\u52A1\u3001\u5173\u95ED\u5916\u952E\u6267\u884C\u5E76\u542F\u7528\u517C\u5BB9\u91CD\u547D\u540D");
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((row) => row.name === "storage_id")) {
      validateStableStorageTable(db, table);
      continue;
    }
    if (columns.some((row) => ["rowid", "_rowid_", "oid"].includes(String(row.name).toLowerCase()))) throw Error("\u539F\u8868\u906E\u853D\u7269\u7406\u884C\u53F7\uFF0C\u62D2\u7EDD\u8FC1\u79FB");
    const primary = columns.filter((row) => Number(row.pk) > 0);
    if (primary.length !== 1 || primary[0].name !== "id" || primary[0].type !== "TEXT") throw Error("\u539F\u8868\u4E1A\u52A1\u8EAB\u4EFD\u7EA6\u675F\u4E0D\u53D7\u652F\u6301\uFF1A" + table);
    const staging = `rivu_stable_${table}`;
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(staging)) throw Error("\u7A33\u5B9A\u5B58\u50A8\u8FC1\u79FB\u6682\u5B58\u540D\u5DF2\u5B58\u5728\uFF1A" + staging);
    const original = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const prefix = new RegExp(`^CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?(?:"${table}"|${table})\\s*\\(`, "i");
    if (!prefix.test(original.sql) || !/\bid\s+TEXT\s+PRIMARY\s+KEY\b/i.test(original.sql)) throw Error("\u539F\u8868\u5B9A\u4E49\u4E0D\u53D7\u652F\u6301\uFF1A" + table);
    const sql = original.sql.replace(prefix, `CREATE TABLE ${staging} (storage_id INTEGER PRIMARY KEY NOT NULL,`).replace(/\bid\s+TEXT\s+PRIMARY\s+KEY\b/i, "id TEXT UNIQUE");
    const attached = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END,name").all(table);
    db.exec(sql);
    const names = columns.map((row) => quote(String(row.name))).join(",");
    db.exec(`INSERT INTO ${staging}(storage_id,${names}) SELECT rowid,${names} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${staging} RENAME TO ${table};`);
    for (const item of attached) db.exec(item.sql);
    db.exec(`CREATE TRIGGER rivu_${table}_storage_immutable BEFORE UPDATE ON ${table} WHEN NEW.storage_id IS NOT OLD.storage_id BEGIN SELECT RAISE(ABORT,'\u7A33\u5B9A\u5B58\u50A8\u8EAB\u4EFD\u4E0D\u53EF\u66F4\u6539'); END`);
    validateStableStorageTable(db, table);
  }
}
function validateStableStorageTable(db, table) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all(), storage = columns.find((row) => row.name === "storage_id"), id = columns.find((row) => row.name === "id");
  if (!storage || storage.type !== "INTEGER" || storage.pk !== 1 || storage.notnull !== 1 || !id || id.type !== "TEXT" || id.pk !== 0) throw Error("\u7A33\u5B9A\u5B58\u50A8\u4E3B\u952E\u65E0\u6548\uFF1A" + table);
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all();
  if (indexes.some((row) => row.origin === "pk")) throw Error("\u7A33\u5B9A\u5B58\u50A8\u952E\u5FC5\u987B\u662F\u7269\u7406\u884C\u53F7\u522B\u540D\uFF1A" + table);
  const identity = indexes.some((index) => {
    if (index.unique !== 1 || index.partial !== 0) return false;
    const keys = db.prepare("SELECT name,coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno").all(index.name);
    return keys.length === 1 && keys[0].name === "id" && keys[0].coll === "BINARY";
  });
  if (!identity) throw Error("\u7A33\u5B9A\u5B58\u50A8\u4E1A\u52A1\u8EAB\u4EFD\u552F\u4E00\u7EA6\u675F\u65E0\u6548\uFF1A" + table);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=? AND tbl_name=?").get(`rivu_${table}_storage_immutable`, table)) throw Error("\u7A33\u5B9A\u5B58\u50A8\u8EAB\u4EFD\u4FDD\u62A4\u7F3A\u5931\uFF1A" + table);
}
function validateStableStorageKeys(db) {
  for (const table of tables) validateStableStorageTable(db, table);
}

// server/search-rowid-projection.ts
var searchRowidTriggers = ["rivu_search_state_insert", "rivu_search_state_update", "rivu_search_state_delete", "rivu_search_rowid_update"];
var reconcile3 = `INSERT INTO rivu_search_entries(entry_rowid,entry_id,feed_id,sort_time,blocked,visible,read)
 SELECT e.rowid,NEW.entry_id,NEW.feed_id,NEW.sort_time,NEW.blocked,NEW.visible,e.read FROM entries e INDEXED BY entries_list_metadata WHERE e.id=NEW.entry_id
 ON CONFLICT(entry_id) DO UPDATE SET entry_rowid=excluded.entry_rowid,feed_id=excluded.feed_id,sort_time=excluded.sort_time,blocked=excluded.blocked,visible=excluded.visible,read=excluded.read;`;
var blocked3 = `EXISTS(SELECT 1 FROM rule_matches m JOIN rules r ON r.id=m.rule_id WHERE m.entry_id=e.id AND r.enabled=1 AND r.action_type='block') OR EXISTS(SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=e.id AND a.decision='block')`;
var muted2 = `EXISTS(SELECT 1 FROM rule_matches m JOIN rules r ON r.id=m.rule_id WHERE m.entry_id=e.id AND r.enabled=1 AND r.action_type='mute') OR EXISTS(SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=e.id AND a.decision='mute')`;
function installSearchRowidProjection(db) {
  if (!db.isTransaction) throw Error("\u641C\u7D22\u884C\u53F7\u6295\u5F71\u5FC5\u987B\u5728\u8FC1\u79FB\u4E8B\u52A1\u5185\u5B89\u88C5");
  for (const name of searchRowidTriggers) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec(`CREATE TABLE IF NOT EXISTS rivu_search_entries(
  entry_rowid INTEGER PRIMARY KEY NOT NULL,
  entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id) ON DELETE CASCADE ON UPDATE CASCADE,
  feed_id TEXT NOT NULL,sort_time TEXT NOT NULL,
  blocked INTEGER NOT NULL CHECK(blocked IN (0,1)),visible INTEGER NOT NULL CHECK(visible IN (0,1)),read INTEGER NOT NULL
 );
 DELETE FROM rivu_search_entries;
 INSERT INTO rivu_search_entries SELECT e.rowid,e.id,v.feed_id,v.sort_time,v.blocked,v.visible,e.read FROM rivu_entry_visibility v CROSS JOIN entries e INDEXED BY entries_list_metadata ON e.id=v.entry_id;
 CREATE INDEX IF NOT EXISTS rivu_search_timeline ON rivu_search_entries(blocked,sort_time DESC,entry_id DESC,entry_rowid,feed_id,visible,read);
 CREATE INDEX IF NOT EXISTS rivu_search_unscoped ON rivu_search_entries(blocked,sort_time DESC,entry_id DESC,entry_rowid,visible,read);
 CREATE INDEX IF NOT EXISTS rivu_search_feed ON rivu_search_entries(feed_id,blocked,sort_time DESC,entry_id DESC,entry_rowid,visible,read);
 CREATE TRIGGER rivu_search_state_insert AFTER INSERT ON rivu_entry_visibility BEGIN ${reconcile3} END;
 CREATE TRIGGER rivu_search_state_update AFTER UPDATE OF entry_id,feed_id,sort_time,blocked,visible ON rivu_entry_visibility BEGIN
  DELETE FROM rivu_search_entries WHERE entry_id=OLD.entry_id AND OLD.entry_id IS NOT NEW.entry_id;
  ${reconcile3}
 END;
 CREATE TRIGGER rivu_search_state_delete AFTER DELETE ON rivu_entry_visibility BEGIN DELETE FROM rivu_search_entries WHERE entry_id=OLD.entry_id; END;
 CREATE TRIGGER rivu_search_rowid_update AFTER UPDATE OF rowid,_rowid_,oid ON entries BEGIN UPDATE rivu_search_entries SET entry_rowid=NEW.rowid WHERE entry_id=NEW.id; END;`);
  validateSearchRowidStructure(db);
}
function validateSearchRowidStructure(db) {
  const columns = db.prepare("PRAGMA table_info(rivu_search_entries)").all();
  for (const name of ["entry_rowid", "entry_id", "feed_id", "sort_time", "blocked", "visible", "read"]) {
    const column = columns.find((row) => row.name === name), type = ["entry_id", "feed_id", "sort_time"].includes(name) ? "TEXT" : "INTEGER";
    if (!column || column.type !== type || column.notnull !== 1 || column.pk !== (name === "entry_rowid" ? 1 : 0)) throw Error("\u641C\u7D22\u884C\u53F7\u5217\u7EA6\u675F\u65E0\u6548\uFF1A" + name);
  }
  const foreign = db.prepare("PRAGMA foreign_key_list(rivu_search_entries)").all();
  if (foreign.length !== 1 || foreign[0].table !== "entries" || foreign[0].from !== "entry_id" || foreign[0].to !== "id" || foreign[0].on_update !== "CASCADE" || foreign[0].on_delete !== "CASCADE") throw Error("\u641C\u7D22\u884C\u53F7\u8EAB\u4EFD\u5916\u952E\u65E0\u6548");
  const indexes = db.prepare("PRAGMA index_list(rivu_search_entries)").all(), unique = indexes.filter((row) => row.unique === 1);
  if (unique.length !== 1 || unique[0].partial !== 0) throw Error("\u641C\u7D22\u6587\u7AE0\u8EAB\u4EFD\u552F\u4E00\u7EA6\u675F\u65E0\u6548");
  const identity = db.prepare("SELECT name,coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno").all(unique[0].name);
  if (identity.length !== 1 || identity[0].name !== "entry_id" || identity[0].coll !== "BINARY") throw Error("\u641C\u7D22\u6587\u7AE0\u8EAB\u4EFD\u7D22\u5F15\u65E0\u6548");
  for (const [name, expected] of [["rivu_search_timeline", "blocked:0,sort_time:1,entry_id:1,entry_rowid:0,feed_id:0,visible:0,read:0"], ["rivu_search_unscoped", "blocked:0,sort_time:1,entry_id:1,entry_rowid:0,visible:0,read:0"], ["rivu_search_feed", "feed_id:0,blocked:0,sort_time:1,entry_id:1,entry_rowid:0,visible:0,read:0"]]) {
    const index = indexes.find((row) => row.name === name);
    const keys = db.prepare("SELECT name,desc,coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno").all(name);
    if (!index || index.unique !== 0 || index.partial !== 0 || keys.map((row) => `${row.name}:${row.desc}`).join(",") !== expected || keys.some((row) => row.coll !== "BINARY")) throw Error("\u641C\u7D22\u65F6\u95F4\u7D22\u5F15\u65E0\u6548\uFF1A" + name);
  }
  for (const name of searchRowidTriggers) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw Error("\u641C\u7D22\u884C\u53F7\u89E6\u53D1\u5668\u7F3A\u5931\uFF1A" + name);
}
function validateSearchRowidProjection(db) {
  validateSearchRowidStructure(db);
  const mismatch = db.prepare(`SELECT e.id FROM entries e INDEXED BY entries_list_metadata LEFT JOIN rivu_search_entries s ON s.entry_id=e.id
 WHERE s.entry_id IS NULL OR s.entry_rowid IS NOT e.rowid OR s.feed_id IS NOT e.feed_id OR s.sort_time IS NOT COALESCE(e.published_at,e.fetched_at)
 OR s.read IS NOT e.read OR s.blocked IS NOT CASE WHEN (${blocked3}) THEN 1 ELSE 0 END
 OR s.visible IS NOT CASE WHEN e.read=0 AND NOT (${blocked3}) AND NOT (${muted2}) THEN 1 ELSE 0 END
 UNION ALL SELECT s.entry_id FROM rivu_search_entries s LEFT JOIN entries e INDEXED BY entries_list_metadata ON e.id=s.entry_id WHERE e.id IS NULL LIMIT 1`).get();
  if (mismatch) throw Error("\u641C\u7D22\u884C\u53F7\u6295\u5F71\u4E0E\u539F\u59CB\u6587\u7AE0\u6216\u89C4\u5219\u4E0D\u4E00\u81F4");
}

// server/database.ts
var SCHEMA_VERSION = 43;
function validateFetchInterval(value) {
  if (value === void 0) return void 0;
  if (typeof value !== "number" || !Number.isInteger(value) || ![0, 15, 30, 60, 180, 360, 720].includes(value)) throw Object.assign(Error("\u5237\u65B0\u9891\u7387\u65E0\u6548"), { statusCode: 400 });
  return value;
}
var RECOVERED_FEED_URL_PREFIX = "https://recovered.invalid/feed/";
var isRecoveredFeed = (feed) => {
  if (typeof feed.url !== "string") return false;
  try {
    return new URL(feed.url).hostname.replace(/\.$/, "") === "recovered.invalid";
  } catch {
    return false;
  }
};
var migrationPermits = /* @__PURE__ */ new WeakSet();
var REQUIRED_COLUMNS = {
  feeds: ["id", "title", "url", "site_url", "description", "icon", "type", "category_id", "last_fetched_at", "last_success_at", "fetch_interval", "enabled", "failure_count", "last_error", "next_fetch_at", "created_at", "rsshub_instance_id", "allow_private", "json_mapping", "folder_authorized"],
  feed_icon_keys: ["feed_id", "icon_key"],
  newsletter_files: ["feed_id", "file_name", "modified_ms", "size", "failed"],
  categories: ["id", "name", "icon", "sort", "created_at"],
  entries: ["storage_id", ...entryColumns],
  entry_media: ["entry_id", "kind", "url", "mime", "source", "title", "created_at"],
  entry_identities: ["feed_id", "entry_id", "kind", "value"],
  ai_filter_decisions: ["entry_id", "decision", "reason", "criteria", "provider", "model", "content_hash", "updated_at"],
  permanent_archives: ["id", "source_entry_id", "feed_id", "feed_title", "title", "url", "created_at", "updated_at"],
  archive_versions: ["id", "archive_id", "content_hash", "body_html", "created_at"],
  archive_assets: ["id", "archive_id", "version_id", "kind", "url", "mime", "bytes", "data"],
  ai_results: ["id", "entry_id", "type", "language", "provider", "model", "content", "prompt_version", "content_hash", "created_at"],
  ai_conversations: ["id", "title", "entry_ids", "created_at", "updated_at"],
  ai_messages: ["id", "conversation_id", "role", "content", "citations", "provider", "model", "created_at"],
  ai_rules: ["id", "name", "enabled", "auto_run", "conditions", "action_type", "max_items", "provider", "model", "credential_id", "last_error", "created_at", "updated_at"],
  ai_rule_jobs: ["rule_id", "entry_id", "source_hash", "provider", "model", "status", "attempts", "last_error", "created_at", "updated_at"],
  rsshub_instances: ["id", "name", "base_url", "enabled", "created_at", "allow_private"],
  tags: ["id", "name", "color"],
  entry_tags: ["entry_id", "tag_id"],
  cached_images: ["url", "file_name", "mime", "bytes", "saved_at", "last_accessed_at"],
  reading_positions: ["entry_id", "progress", "updated_at"],
  offline_saves: ["entry_id", "include_images", "status", "last_error", "updated_at"],
  rules: ["id", "name", "priority", "enabled", "conditions", "action_type", "tag_id", "created_at", "updated_at"],
  rule_matches: ["rule_id", "entry_id", "created_at"],
  rivu_entry_visibility: ["entry_id", "feed_id", "visible", "sort_time", "blocked", "sort_bucket"],
  rivu_raw_unread_entries: ["entry_id", "feed_id", "sort_time", "sort_bucket"],
  rivu_feed_unread_counts: ["feed_id", "unread_count"],
  rivu_source_entry_counts: ["feed_id", "entry_count"],
  rivu_timeline_bucket_counts: ["sort_bucket", "entry_count", "visible_count", "blocked_count"],
  rivu_feed_timeline_bucket_counts: ["sort_bucket", "feed_id", "category_id", "entry_count", "visible_count", "blocked_count"],
  rivu_category_timeline_bucket_counts: ["category_id", "sort_bucket", "entry_count", "visible_count", "blocked_count"],
  smart_folders: ["id", "name", "query", "sort", "created_at", "updated_at"],
  app_meta: ["key", "value"],
  entry_fts: ["title", "content", "description", "author"],
  ai_result_fts: ["content"],
  entry_pair_fts: ["pairs"],
  ai_result_pair_fts: ["pairs"]
};
function archiveAssetKeys(db) {
  return db.prepare("PRAGMA index_list(archive_assets)").all().filter((index) => index.unique && !index.partial).map((index) => db.prepare(`PRAGMA index_info('${index.name.replaceAll("'", "''")}')`).all().map((column) => column.name).join(","));
}
function validateSchema(db, checkForeignKeys = true) {
  validateStableStorageKeys(db);
  validateSearchRowidStructure(db);
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const name of required) if (!columns.has(name)) throw Error(`\u6570\u636E\u5E93\u7ED3\u6784\u4E0D\u5B8C\u6574\uFF1A${table}.${name}`);
  }
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='feed_icon_keys_update'").get()) throw Error("\u6570\u636E\u5E93\u7ED3\u6784\u4E0D\u5B8C\u6574\uFF1Afeed_icon_keys_update");
  for (const name of ["entry_body_revision_insert", "entry_body_revision_update"]) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw Error(`\u6570\u636E\u5E93\u7ED3\u6784\u4E0D\u5B8C\u6574\uFF1A${name}`);
  for (const name of ["entries_ai_identity", "entries_list_metadata", "entries_unread_cursor"]) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=? AND tbl_name='entries'").get(name)) throw Error(`\u6570\u636E\u5E93\u7ED3\u6784\u4E0D\u5B8C\u6574\uFF1A${name}`);
  for (const table of ["permanent_archives", "archive_versions", "archive_assets"]) for (const event of ["insert", "update", "delete"]) {
    const name = `archive_revision_${table}_${event}`;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw Error(`\u6570\u636E\u5E93\u7ED3\u6784\u4E0D\u5B8C\u6574\uFF1A${name}`);
  }
  const revision = db.prepare("SELECT value FROM app_meta WHERE key='archive_revision'").get();
  if (!revision || !/^\d{1,19}$/.test(revision.value)) throw Error("\u5F52\u6863\u4FEE\u8BA2\u8BB0\u5F55\u65E0\u6548");
  const assetKeys = archiveAssetKeys(db);
  if (!assetKeys.includes("version_id,kind,url") || assetKeys.includes("version_id,url")) throw Error("\u5F52\u6863\u8D44\u6E90\u8EAB\u4EFD\u7D22\u5F15\u65E0\u6548");
  validateVisibilityIndexes(db);
  validateRawUnreadStructure(db);
  for (const name of unreadCountTriggerNames) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw Error(`\u6570\u636E\u5E93\u7ED3\u6784\u4E0D\u5B8C\u6574\uFF1A${name}`);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='rivu_visibility_feed'").get()) throw Error("\u6570\u636E\u5E93\u7ED3\u6784\u4E0D\u5B8C\u6574\uFF1Arivu_visibility_feed");
  if (checkForeignKeys) {
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length) throw Error("\u6570\u636E\u5E93\u5B58\u5728\u5931\u6548\u7684\u5173\u8054\u8BB0\u5F55");
  }
}
var invalidReadScope = (message) => Object.assign(new Error(message), { statusCode: 400 });
var RivuDatabase = class _RivuDatabase {
  constructor(path, onMigrationStage, requireCurrent = false, permit) {
    this.path = path;
    if (requireCurrent && (!(0, import_node_fs.existsSync)(path) || (0, import_node_fs.statSync)(path).size === 0)) throw Error("\u540E\u53F0\u5199\u5165\u9700\u8981\u5DF2\u521D\u59CB\u5316\u7684\u6570\u636E\u5E93");
    const reportStage = (stage) => {
      try {
        onMigrationStage?.(stage);
      } catch {
      }
    };
    (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(path), { recursive: true });
    const existing = (0, import_node_fs.existsSync)(path) && (0, import_node_fs.statSync)(path).size > 0;
    if (permit && (!migrationPermits.delete(permit) || permit.path !== (0, import_node_path.resolve)(path) || !permit.db.isTransaction)) throw Error("\u65E0\u6548\u7684\u8FC1\u79FB\u5FEB\u7167\u8BB8\u53EF");
    this.db = permit?.db ?? new import_node_sqlite.DatabaseSync(path);
    try {
      this.db.function("rivu_pairs", { deterministic: true, varargs: true }, pairTokens);
      const version = Number(this.db.prepare("PRAGMA user_version").get().user_version);
      if (requireCurrent && version !== SCHEMA_VERSION) throw Error("\u540E\u53F0\u5199\u5165\u4E0D\u80FD\u521B\u5EFA\u6216\u8FC1\u79FB\u6570\u636E\u5E93");
      if (version > SCHEMA_VERSION) throw Error(`\u6570\u636E\u5E93\u7248\u672C ${version} \u9AD8\u4E8E\u5F53\u524D\u652F\u6301\u7248\u672C ${SCHEMA_VERSION}`);
      if (permit && version !== permit.version) throw Error("\u6570\u636E\u5E93\u7248\u672C\u4E0E\u8FC1\u79FB\u524D\u5FEB\u7167\u4E0D\u4E00\u81F4");
      if (existing && version < SCHEMA_VERSION && !permit) throw Error("\u5DF2\u6709\u6570\u636E\u5E93\u5347\u7EA7\u9700\u8981\u4F7F\u7528\u5F02\u6B65 RivuDatabase.open");
      if (!permit) this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      if (version === SCHEMA_VERSION) {
        validateSchema(this.db, false);
        this.initializeIconKeys();
        return;
      }
      if (!permit) this.db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON");
      reportStage("schema");
      if (!this.db.isTransaction) this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const name of rawUnreadTriggerNames) this.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
        if (version >= 35 && version <= 42) {
          reportStage("index");
          if (version < 41) installUnreadCounts(this.db);
          installRawUnreadProjection(this.db);
          installStableStorageKeys(this.db);
          installSearchRowidProjection(this.db);
          reportStage("verify");
          validateSchema(this.db);
          validateUnreadCounts(this.db);
          validateRawUnreadProjection(this.db);
          validateSearchRowidProjection(this.db);
          const check2 = this.db.prepare("PRAGMA integrity_check").get();
          if (check2.integrity_check !== "ok") throw Error("\u6570\u636E\u5E93\u8FC1\u79FB\u540E\u5B8C\u6574\u6027\u6821\u9A8C\u5931\u8D25");
          this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
          this.db.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF");
          this.initializeIconKeys();
          reportStage("done");
          return;
        }
        for (const name of unreadCountTriggerNames) this.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS feeds (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL UNIQUE, site_url TEXT, description TEXT, icon TEXT, type TEXT NOT NULL DEFAULT 'rss', category_id TEXT REFERENCES categories(id) ON DELETE SET NULL, last_fetched_at TEXT, last_success_at TEXT, fetch_interval INTEGER NOT NULL DEFAULT 30, enabled INTEGER NOT NULL DEFAULT 1, failure_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_fetch_at TEXT, created_at TEXT NOT NULL, allow_private INTEGER NOT NULL DEFAULT 0 CHECK(allow_private IN (0,1)), json_mapping TEXT, folder_authorized INTEGER NOT NULL DEFAULT 0 CHECK(folder_authorized IN (0,1)));
      CREATE TABLE IF NOT EXISTS feed_icon_keys (feed_id TEXT PRIMARY KEY NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,icon_key TEXT);
      CREATE TRIGGER IF NOT EXISTS feed_icon_keys_update AFTER UPDATE OF icon,id ON feeds BEGIN DELETE FROM feed_icon_keys WHERE feed_id IN (OLD.id,NEW.id); END;
      CREATE TABLE IF NOT EXISTS newsletter_files (feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, file_name TEXT NOT NULL, modified_ms INTEGER NOT NULL, size INTEGER NOT NULL, failed INTEGER NOT NULL DEFAULT 0 CHECK(failed IN (0,1)), PRIMARY KEY(feed_id,file_name));
      CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, guid TEXT, title TEXT NOT NULL, author TEXT, url TEXT, published_at TEXT, fetched_at TEXT NOT NULL, content TEXT, description TEXT, cover TEXT, language TEXT, read INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, saved INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL, UNIQUE(feed_id, hash));
      CREATE TABLE IF NOT EXISTS entry_media (entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('image','audio','video')), url TEXT NOT NULL, mime TEXT, source TEXT NOT NULL CHECK(source IN ('cover','body','enclosure','metadata')), title TEXT, created_at TEXT NOT NULL, PRIMARY KEY(entry_id,kind,url));
      CREATE UNIQUE INDEX IF NOT EXISTS entries_feed_id_identity ON entries(feed_id,id);
      CREATE TABLE IF NOT EXISTS entry_identities (feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, entry_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('hash','guid','url','canonical','content')), value TEXT NOT NULL, PRIMARY KEY(feed_id,kind,value,entry_id), FOREIGN KEY(feed_id,entry_id) REFERENCES entries(feed_id,id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS entry_identities_entry ON entry_identities(entry_id);
      CREATE TABLE IF NOT EXISTS ai_filter_decisions (entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id) ON DELETE CASCADE, decision TEXT NOT NULL CHECK(decision IN ('mute','block')), reason TEXT NOT NULL, criteria TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS permanent_archives (id TEXT PRIMARY KEY, source_entry_id TEXT NOT NULL UNIQUE, feed_id TEXT NOT NULL, feed_title TEXT NOT NULL, title TEXT NOT NULL, url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_versions (id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES permanent_archives(id) ON DELETE CASCADE, content_hash TEXT NOT NULL, body_html TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS archive_versions_time ON archive_versions(archive_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS archive_assets (id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES permanent_archives(id) ON DELETE CASCADE, version_id TEXT NOT NULL REFERENCES archive_versions(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('image','audio','video','snapshot')), url TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, UNIQUE(version_id,kind,url));
      CREATE INDEX IF NOT EXISTS archive_assets_archive ON archive_assets(archive_id,version_id);
      CREATE INDEX IF NOT EXISTS entry_media_kind ON entry_media(kind,entry_id);
      CREATE INDEX IF NOT EXISTS entries_feed_time ON entries(feed_id, published_at DESC);
      CREATE INDEX IF NOT EXISTS entries_time ON entries(published_at DESC);
      CREATE INDEX IF NOT EXISTS entries_sort_time ON entries(COALESCE(published_at,fetched_at) DESC);
      CREATE INDEX IF NOT EXISTS entries_feed_sort_time ON entries(feed_id,COALESCE(published_at,fetched_at) DESC);
      CREATE INDEX IF NOT EXISTS entries_feed_unread ON entries(feed_id,read);
      CREATE INDEX IF NOT EXISTS entries_cursor_sort ON entries(COALESCE(published_at,fetched_at) DESC,id DESC);
      CREATE INDEX IF NOT EXISTS entries_feed_cursor_sort ON entries(feed_id,COALESCE(published_at,fetched_at) DESC,id DESC);
      CREATE TABLE IF NOT EXISTS ai_results (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, type TEXT NOT NULL, language TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL, model TEXT NOT NULL, content TEXT NOT NULL, prompt_version TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(entry_id, type, language, provider, model));
      CREATE VIRTUAL TABLE IF NOT EXISTS ai_result_fts USING fts5(content, content='ai_results', content_rowid='rowid', tokenize='trigram');
      CREATE VIRTUAL TABLE IF NOT EXISTS ai_result_pair_fts USING fts5(pairs, content='', contentless_delete=1, detail=none);
      CREATE TRIGGER IF NOT EXISTS ai_result_ai AFTER INSERT ON ai_results BEGIN INSERT INTO ai_result_fts(rowid,content) VALUES (new.rowid,new.content); END;
      CREATE TRIGGER IF NOT EXISTS ai_result_ad AFTER DELETE ON ai_results BEGIN INSERT INTO ai_result_fts(ai_result_fts,rowid,content) VALUES ('delete',old.rowid,old.content); END;
      CREATE TRIGGER IF NOT EXISTS ai_result_au AFTER UPDATE OF content ON ai_results BEGIN INSERT INTO ai_result_fts(ai_result_fts,rowid,content) VALUES ('delete',old.rowid,old.content); INSERT INTO ai_result_fts(rowid,content) VALUES (new.rowid,new.content); END;
      CREATE TABLE IF NOT EXISTS ai_conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, entry_ids TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, citations TEXT NOT NULL DEFAULT '[]', provider TEXT, model TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_messages_conversation ON ai_messages(conversation_id,created_at);
      CREATE TABLE IF NOT EXISTS ai_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), auto_run INTEGER NOT NULL DEFAULT 0 CHECK(auto_run IN (0,1)), conditions TEXT NOT NULL, action_type TEXT NOT NULL CHECK(action_type IN ('summary','keywords','classification')), max_items INTEGER NOT NULL DEFAULT 10 CHECK(max_items BETWEEN 1 AND 20), provider TEXT, model TEXT, credential_id TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_rule_jobs (rule_id TEXT NOT NULL REFERENCES ai_rules(id) ON DELETE CASCADE, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, source_hash TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','paused')), attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(rule_id,entry_id));
      CREATE INDEX IF NOT EXISTS ai_rule_jobs_status ON ai_rule_jobs(status,updated_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(title, content, description, author, content='entries', content_rowid='rowid', tokenize='trigram');
      CREATE VIRTUAL TABLE IF NOT EXISTS entry_pair_fts USING fts5(pairs, content='', contentless_delete=1, detail=none);
      CREATE TRIGGER IF NOT EXISTS entry_ai AFTER INSERT ON entries BEGIN INSERT INTO entry_fts(rowid,title,content,description,author) VALUES (new.rowid,new.title,new.content,new.description,new.author); END;
      CREATE TRIGGER IF NOT EXISTS entry_ad AFTER DELETE ON entries BEGIN INSERT INTO entry_fts(entry_fts,rowid,title,content,description,author) VALUES ('delete',old.rowid,old.title,old.content,old.description,old.author); END;
      CREATE TRIGGER IF NOT EXISTS entry_au AFTER UPDATE OF title,content,description,author ON entries BEGIN INSERT INTO entry_fts(entry_fts,rowid,title,content,description,author) VALUES ('delete',old.rowid,old.title,old.content,old.description,old.author); INSERT INTO entry_fts(rowid,title,content,description,author) VALUES (new.rowid,new.title,new.content,new.description,new.author); END;
      CREATE TABLE IF NOT EXISTS rsshub_instances (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, allow_private INTEGER NOT NULL DEFAULT 0 CHECK(allow_private IN (0,1)));
      CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL DEFAULT '#38A7F8');
      CREATE TABLE IF NOT EXISTS entry_tags (entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(entry_id,tag_id));
      CREATE INDEX IF NOT EXISTS entry_tags_tag ON entry_tags(tag_id,entry_id);
      CREATE TABLE IF NOT EXISTS cached_images (url TEXT PRIMARY KEY, file_name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, saved_at TEXT NOT NULL, last_accessed_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cached_images_access ON cached_images(last_accessed_at);
      CREATE TABLE IF NOT EXISTS reading_positions (entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, progress REAL NOT NULL CHECK(progress >= 0 AND progress <= 1), updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS offline_saves (entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, include_images INTEGER NOT NULL CHECK(include_images IN (0,1)), status TEXT NOT NULL CHECK(status IN ('running','ready','partial','failed','interrupted')), last_error TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), conditions TEXT NOT NULL, action_type TEXT NOT NULL CHECK(action_type IN ('tag','save','mute','block')), tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rule_matches (rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(rule_id,entry_id));
      CREATE INDEX IF NOT EXISTS rule_matches_entry ON rule_matches(entry_id,rule_id);
      CREATE TABLE IF NOT EXISTS smart_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, query TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
        const columns = this.db.prepare("PRAGMA table_info(feeds)").all();
        if (!columns.some((x) => x.name === "rsshub_instance_id")) this.db.exec("ALTER TABLE feeds ADD COLUMN rsshub_instance_id TEXT REFERENCES rsshub_instances(id) ON DELETE SET NULL");
        if (!columns.some((x) => x.name === "allow_private")) this.db.exec("ALTER TABLE feeds ADD COLUMN allow_private INTEGER NOT NULL DEFAULT 0 CHECK(allow_private IN (0,1))");
        if (!columns.some((x) => x.name === "last_success_at")) {
          this.db.exec("ALTER TABLE feeds ADD COLUMN last_success_at TEXT");
          if (["last_fetched_at", "failure_count", "last_error"].every((name) => columns.some((column) => column.name === name))) this.db.exec("UPDATE feeds SET last_success_at=last_fetched_at WHERE failure_count=0 AND last_error IS NULL");
        }
        if (!columns.some((x) => x.name === "json_mapping")) this.db.exec("ALTER TABLE feeds ADD COLUMN json_mapping TEXT");
        if (!columns.some((x) => x.name === "folder_authorized")) this.db.exec("ALTER TABLE feeds ADD COLUMN folder_authorized INTEGER NOT NULL DEFAULT 0 CHECK(folder_authorized IN (0,1))");
        const newsletterColumns = this.db.prepare("PRAGMA table_info(newsletter_files)").all();
        if (!newsletterColumns.some((x) => x.name === "failed")) this.db.exec("ALTER TABLE newsletter_files ADD COLUMN failed INTEGER NOT NULL DEFAULT 0 CHECK(failed IN (0,1))");
        const missingSources = this.db.prepare("SELECT DISTINCT e.feed_id id FROM entries e LEFT JOIN feeds f ON f.id=e.feed_id WHERE f.id IS NULL").all();
        const recovered = missingSources.length ? this.db.prepare("INSERT INTO feeds(id,title,url,description,type,enabled,last_error,created_at) VALUES (?,?,?,?,?,?,?,?)") : null;
        for (const source of missingSources) {
          const digest2 = (0, import_node_crypto3.createHash)("sha256").update(source.id).digest("hex");
          recovered.run(source.id, "\u6062\u590D\u7684\u539F\u8BA2\u9605\uFF08\u6765\u6E90\u5730\u5740\u7F3A\u5931\uFF09", `${RECOVERED_FEED_URL_PREFIX}${digest2}`, "\u65E7\u6570\u636E\u5E93\u4E2D\u7684\u6587\u7AE0\u5DF2\u4FDD\u7559\uFF1B\u539F\u8BA2\u9605\u5730\u5740\u65E0\u6CD5\u4ECE\u73B0\u6709\u6570\u636E\u6062\u590D\u3002", "rss", 0, "\u6765\u6E90\u5730\u5740\u7F3A\u5931\uFF0C\u8BF7\u91CD\u65B0\u6DFB\u52A0\u539F\u8BA2\u9605\u3002", (/* @__PURE__ */ new Date()).toISOString());
        }
        if (columns.some((column) => column.name === "enabled") && columns.some((column) => column.name === "url")) {
          const disable = this.db.prepare("UPDATE feeds SET enabled=0 WHERE id=?");
          for (const feed of this.db.prepare("SELECT id,url FROM feeds").all()) if (isRecoveredFeed(feed)) disable.run(feed.id);
        }
        const instanceColumns = this.db.prepare("PRAGMA table_info(rsshub_instances)").all();
        if (!instanceColumns.some((x) => x.name === "allow_private")) this.db.exec("ALTER TABLE rsshub_instances ADD COLUMN allow_private INTEGER NOT NULL DEFAULT 0 CHECK(allow_private IN (0,1))");
        const entryColumns2 = this.db.prepare("PRAGMA table_info(entries)").all();
        if (!entryColumns2.some((x) => x.name === "full_content")) this.db.exec("ALTER TABLE entries ADD COLUMN full_content TEXT");
        if (!entryColumns2.some((x) => x.name === "full_content_fetched_at")) this.db.exec("ALTER TABLE entries ADD COLUMN full_content_fetched_at TEXT");
        const aiColumns = this.db.prepare("PRAGMA table_info(ai_results)").all();
        if (!aiColumns.some((x) => x.name === "content_hash")) this.db.exec("ALTER TABLE ai_results ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
        if (version < 19) reportStage("index");
        if (version < 16) this.db.exec("INSERT INTO ai_result_fts(ai_result_fts) VALUES('rebuild')");
        if (version < 18) {
          this.db.exec("INSERT INTO entry_pair_fts(rowid,pairs) SELECT rowid,rivu_pairs(title,content,description,author,full_content) FROM entries");
          this.db.exec("INSERT INTO ai_result_pair_fts(rowid,pairs) SELECT rowid,rivu_pairs(content) FROM ai_results");
        } else if (version < 19) {
          this.db.exec("DELETE FROM entry_pair_fts; DELETE FROM ai_result_pair_fts");
          this.db.exec("INSERT INTO entry_pair_fts(rowid,pairs) SELECT rowid,rivu_pairs(title,content,description,author,full_content) FROM entries");
          this.db.exec("INSERT INTO ai_result_pair_fts(rowid,pairs) SELECT rowid,rivu_pairs(content) FROM ai_results");
        }
        const aiRuleColumns = this.db.prepare("PRAGMA table_info(ai_rules)").all();
        if (!aiRuleColumns.some((x) => x.name === "last_error")) this.db.exec("ALTER TABLE ai_rules ADD COLUMN last_error TEXT");
        if (!aiRuleColumns.some((x) => x.name === "credential_id")) this.db.exec("ALTER TABLE ai_rules ADD COLUMN credential_id TEXT");
        const archiveAssetColumns = this.db.prepare("PRAGMA table_info(archive_assets)").all();
        if (!archiveAssetColumns.some((x) => x.name === "version_id")) this.db.exec(`
      CREATE TABLE archive_assets_v15 (id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES permanent_archives(id) ON DELETE CASCADE, version_id TEXT NOT NULL REFERENCES archive_versions(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('image','audio','video','snapshot')), url TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, UNIQUE(version_id,kind,url));
      INSERT INTO archive_assets_v15(id,archive_id,version_id,kind,url,mime,bytes,data) SELECT a.id,a.archive_id,(SELECT v.id FROM archive_versions v WHERE v.archive_id=a.archive_id ORDER BY v.created_at DESC,v.rowid DESC LIMIT 1),a.kind,a.url,a.mime,a.bytes,a.data FROM archive_assets a;
      DROP TABLE archive_assets;
      ALTER TABLE archive_assets_v15 RENAME TO archive_assets;
      CREATE INDEX archive_assets_archive ON archive_assets(archive_id,version_id);
    `);
        if (version < 13) {
          const old = this.db.prepare("SELECT e.id,e.url,e.cover,COALESCE(NULLIF(e.full_content,''),NULLIF(e.content,''),e.description,'') body,f.url feed_url FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE (e.cover IS NOT NULL AND e.cover<>'') OR e.full_content LIKE '%<img%' OR e.content LIKE '%<img%' OR e.description LIKE '%<img%'").all();
          const insert = this.db.prepare("INSERT OR IGNORE INTO entry_media(entry_id,kind,url,mime,source,title,created_at) VALUES (?,?,?,?,?,?,?)");
          for (const row of old) {
            const base = row.url || row.feed_url, cover = mediaUrl(row.cover, base), items = cover ? [{ kind: "image", url: cover, mime: null, source: "cover", title: null }] : [];
            items.push(...bodyImages(row.body, base));
            for (const media of uniqueMedia(items)) insert.run(row.id, media.kind, media.url, media.mime, media.source, media.title, (/* @__PURE__ */ new Date()).toISOString());
          }
        }
        this.db.exec(`
      DROP TRIGGER IF EXISTS entry_ai; DROP TRIGGER IF EXISTS entry_ad; DROP TRIGGER IF EXISTS entry_au;
      CREATE TRIGGER entry_ai AFTER INSERT ON entries BEGIN INSERT INTO entry_fts(rowid,title,content,description,author) VALUES (new.rowid,new.title,COALESCE(new.full_content,new.content),new.description,new.author); END;
      CREATE TRIGGER entry_ad AFTER DELETE ON entries BEGIN INSERT INTO entry_fts(entry_fts,rowid,title,content,description,author) VALUES ('delete',old.rowid,old.title,COALESCE(old.full_content,old.content),old.description,old.author); END;
      CREATE TRIGGER entry_au AFTER UPDATE OF title,content,full_content,description,author ON entries BEGIN INSERT INTO entry_fts(entry_fts,rowid,title,content,description,author) VALUES ('delete',old.rowid,old.title,COALESCE(old.full_content,old.content),old.description,old.author); INSERT INTO entry_fts(rowid,title,content,description,author) VALUES (new.rowid,new.title,COALESCE(new.full_content,new.content),new.description,new.author); END;
      CREATE TRIGGER IF NOT EXISTS entry_pair_ai AFTER INSERT ON entries BEGIN INSERT INTO entry_pair_fts(rowid,pairs) VALUES (new.rowid,rivu_pairs(new.title,new.content,new.description,new.author,new.full_content)); END;
      CREATE TRIGGER IF NOT EXISTS entry_pair_ad AFTER DELETE ON entries BEGIN DELETE FROM entry_pair_fts WHERE rowid=old.rowid; END;
      CREATE TRIGGER IF NOT EXISTS entry_pair_au AFTER UPDATE OF title,content,description,author,full_content ON entries BEGIN DELETE FROM entry_pair_fts WHERE rowid=old.rowid; INSERT INTO entry_pair_fts(rowid,pairs) VALUES (new.rowid,rivu_pairs(new.title,new.content,new.description,new.author,new.full_content)); END;
      CREATE TRIGGER IF NOT EXISTS ai_result_pair_ai AFTER INSERT ON ai_results BEGIN INSERT INTO ai_result_pair_fts(rowid,pairs) VALUES (new.rowid,rivu_pairs(new.content)); END;
      CREATE TRIGGER IF NOT EXISTS ai_result_pair_ad AFTER DELETE ON ai_results BEGIN DELETE FROM ai_result_pair_fts WHERE rowid=old.rowid; END;
      CREATE TRIGGER IF NOT EXISTS ai_result_pair_au AFTER UPDATE OF content ON ai_results BEGIN DELETE FROM ai_result_pair_fts WHERE rowid=old.rowid; INSERT INTO ai_result_pair_fts(rowid,pairs) VALUES (new.rowid,rivu_pairs(new.content)); END;
    `);
        const seeded = this.db.prepare("SELECT value FROM app_meta WHERE key='rsshub_seeded'").get();
        if (version < 27) {
          const insertIdentity = this.db.prepare("INSERT OR IGNORE INTO entry_identities(feed_id,entry_id,kind,value) VALUES (?,?,?,?)");
          const rows = this.db.prepare("SELECT e.id,e.feed_id,e.guid,e.title,e.author,e.url,e.content,e.description,e.hash,f.url feed_url FROM entries e JOIN feeds f ON f.id=e.feed_id").iterate();
          for (const row of rows) {
            const input = row;
            for (const identity of entryIdentities(input, input.feed_url)) insertIdentity.run(input.feed_id, input.id, identity.kind, identity.value);
          }
        }
        if (!seeded) {
          const count = Number(this.db.prepare("SELECT count(*) n FROM rsshub_instances").get().n);
          if (count === 0) this.db.prepare("INSERT INTO rsshub_instances(id,name,base_url,created_at) VALUES (?,?,?,?)").run((0, import_node_crypto3.randomUUID)(), "RSSHub \u5B98\u65B9", "https://rsshub.app", (/* @__PURE__ */ new Date()).toISOString());
          this.db.prepare("INSERT INTO app_meta(key,value) VALUES ('rsshub_seeded','1')").run();
        }
        if (!archiveAssetKeys(this.db).includes("version_id,kind,url") || archiveAssetKeys(this.db).includes("version_id,url")) {
          this.db.exec(`CREATE TABLE archive_assets_v32 (id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES permanent_archives(id) ON DELETE CASCADE, version_id TEXT NOT NULL REFERENCES archive_versions(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('image','audio','video','snapshot')), url TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, UNIQUE(version_id,kind,url));
        INSERT INTO archive_assets_v32 SELECT id,archive_id,version_id,kind,url,mime,bytes,data FROM archive_assets;
        DROP TABLE archive_assets;
        ALTER TABLE archive_assets_v32 RENAME TO archive_assets;
        CREATE INDEX archive_assets_archive ON archive_assets(archive_id,version_id);`);
        }
        this.db.prepare("INSERT OR IGNORE INTO app_meta(key,value) VALUES ('archive_revision','0')").run();
        for (const table of ["permanent_archives", "archive_versions", "archive_assets"]) for (const event of ["insert", "update", "delete"]) {
          this.db.exec(`CREATE TRIGGER IF NOT EXISTS archive_revision_${table}_${event} AFTER ${event.toUpperCase()} ON ${table} BEGIN UPDATE app_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='archive_revision'; END;`);
        }
        if (!this.db.prepare("PRAGMA table_info(entries)").all().some((column) => column.name === "body_revision")) this.db.exec("ALTER TABLE entries ADD COLUMN body_revision TEXT NOT NULL DEFAULT '00000000000000000000000000000000' CHECK(length(body_revision)=32 AND body_revision NOT GLOB '*[^0-9a-f]*')");
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS entry_body_revision_insert AFTER INSERT ON entries BEGIN UPDATE entries SET body_revision=lower(hex(randomblob(16))) WHERE rowid=new.rowid; END;
      CREATE TRIGGER IF NOT EXISTS entry_body_revision_update AFTER UPDATE OF title,content,description,full_content ON entries WHEN old.title IS NOT new.title OR old.content IS NOT new.content OR old.description IS NOT new.description OR old.full_content IS NOT new.full_content BEGIN UPDATE entries SET body_revision=lower(hex(randomblob(16))) WHERE rowid=new.rowid; END;`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS entries_unread_cursor ON entries(read,COALESCE(published_at,fetched_at) DESC,id DESC,feed_id) WHERE read=0;
      CREATE INDEX IF NOT EXISTS entries_ai_identity ON entries(id,title,body_revision);
      CREATE INDEX IF NOT EXISTS entries_list_metadata ON entries(id,feed_id,title,author,url,published_at,fetched_at,substr(content,1,512),substr(description,1,512),cover,read,starred,saved,COALESCE(published_at,fetched_at),guid,language,archived,hash,full_content_fetched_at,body_revision);`);
        installUnreadCounts(this.db);
        installRawUnreadProjection(this.db);
        installStableStorageKeys(this.db);
        installSearchRowidProjection(this.db);
        reportStage("verify");
        validateSchema(this.db);
        validateUnreadCounts(this.db);
        validateRawUnreadProjection(this.db);
        validateSearchRowidProjection(this.db);
        const metadataColumns = REQUIRED_COLUMNS.feeds.filter((column) => column !== "icon" && column !== "title");
        this.db.exec(`CREATE INDEX IF NOT EXISTS feeds_metadata ON feeds(title COLLATE NOCASE,${metadataColumns.join(",")})`);
        if (version < 29) {
          const insert = this.db.prepare("INSERT INTO feed_icon_keys(feed_id,icon_key) VALUES (?,?) ON CONFLICT(feed_id) DO UPDATE SET icon_key=excluded.icon_key");
          for (const row of this.db.prepare("SELECT id,icon FROM feeds").iterate()) insert.run(row.id, sourceIconKey(row.icon));
        }
        const check = this.db.prepare("PRAGMA integrity_check").get();
        if (check.integrity_check !== "ok") throw Error("\u6570\u636E\u5E93\u8FC1\u79FB\u540E\u5B8C\u6574\u6027\u6821\u9A8C\u5931\u8D25");
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        this.db.exec("COMMIT");
        this.db.exec("PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF");
        this.initializeIconKeys();
        reportStage("done");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  db;
  iconKeys = /* @__PURE__ */ new Map();
  feedMetadataRows = null;
  iconDataVersion = 0;
  initializeIconKeys() {
    for (const row of this.db.prepare("SELECT feed_id,icon_key FROM feed_icon_keys").all()) if (row.icon_key === null || typeof row.icon_key === "string" && /^[a-f0-9]{64}$/.test(row.icon_key)) this.iconKeys.set(String(row.feed_id), row.icon_key);
    this.db.function("rivu_invalidate_icon", (id) => {
      if (typeof id === "string") this.iconKeys.delete(id);
      this.feedMetadataRows = null;
      return null;
    });
    this.db.function("rivu_invalidate_feed_metadata", () => {
      this.feedMetadataRows = null;
      return null;
    });
    this.db.exec(`CREATE TEMP TRIGGER rivu_icon_insert AFTER INSERT ON main.feeds BEGIN SELECT rivu_invalidate_icon(NEW.id); END;
      CREATE TEMP TRIGGER rivu_icon_update AFTER UPDATE OF icon,id ON main.feeds BEGIN SELECT rivu_invalidate_icon(OLD.id); SELECT rivu_invalidate_icon(NEW.id); END;
      CREATE TEMP TRIGGER rivu_icon_delete AFTER DELETE ON main.feeds BEGIN SELECT rivu_invalidate_icon(OLD.id); END;
      CREATE TEMP TRIGGER rivu_metadata_feed_update AFTER UPDATE ON main.feeds BEGIN SELECT rivu_invalidate_feed_metadata(); END;
      CREATE TEMP TRIGGER rivu_metadata_category_insert AFTER INSERT ON main.categories BEGIN SELECT rivu_invalidate_feed_metadata(); END;
      CREATE TEMP TRIGGER rivu_metadata_category_update AFTER UPDATE ON main.categories BEGIN SELECT rivu_invalidate_feed_metadata(); END;
      CREATE TEMP TRIGGER rivu_metadata_category_delete AFTER DELETE ON main.categories BEGIN SELECT rivu_invalidate_feed_metadata(); END;`);
    this.iconDataVersion = Number(this.db.prepare("PRAGMA data_version").get().data_version);
  }
  feedIconKey(id) {
    if (!this.db.isTransaction && this.iconKeys.has(id)) return this.iconKeys.get(id);
    const cached = this.db.prepare("SELECT icon_key FROM feed_icon_keys WHERE feed_id=?").get(id);
    if (cached && (cached.icon_key === null || typeof cached.icon_key === "string" && /^[a-f0-9]{64}$/.test(cached.icon_key))) {
      if (!this.db.isTransaction) this.iconKeys.set(id, cached.icon_key);
      return cached.icon_key;
    }
    const row = this.db.prepare("SELECT icon FROM feeds WHERE id=?").get(id);
    const key = sourceIconKey(row?.icon);
    if (row) this.db.prepare("INSERT INTO feed_icon_keys(feed_id,icon_key) VALUES (?,?) ON CONFLICT(feed_id) DO UPDATE SET icon_key=excluded.icon_key").run(id, key);
    if (!this.db.isTransaction) this.iconKeys.set(id, key);
    return key;
  }
  invalidateFeedIconKey(id) {
    this.iconKeys.delete(id);
    this.db.prepare("DELETE FROM feed_icon_keys WHERE feed_id=?").run(id);
  }
  static async open(path, onMigrationStage) {
    if (!(0, import_node_fs.existsSync)(path) || (0, import_node_fs.statSync)(path).size === 0) return new _RivuDatabase(path, onMigrationStage);
    const probe = new import_node_sqlite.DatabaseSync(path, { readOnly: true });
    let version;
    try {
      version = Number(probe.prepare("PRAGMA user_version").get().user_version);
    } finally {
      probe.close();
    }
    if (version > SCHEMA_VERSION) throw Error(`\u6570\u636E\u5E93\u7248\u672C ${version} \u9AD8\u4E8E\u5F53\u524D\u652F\u6301\u7248\u672C ${SCHEMA_VERSION}`);
    if (version === SCHEMA_VERSION) return new _RivuDatabase(path, onMigrationStage, true);
    const walBytes = (0, import_node_fs.existsSync)(path + "-wal") ? BigInt((0, import_node_fs.statSync)(path + "-wal").size) : 0n;
    const required = (BigInt((0, import_node_fs.statSync)(path).size) + walBytes) * 4n + 1024n * 1024n * 1024n;
    const available = (0, import_node_fs.statfsSync)((0, import_node_path.dirname)(path), { bigint: true });
    if (available.bsize * available.bavail < required) throw Error(`\u6570\u636E\u5E93\u5347\u7EA7\u9700\u8981\u7EA6 ${(Number(required) / 1024 ** 3).toFixed(1)} GiB \u53EF\u7528\u7A7A\u95F4\u4EE5\u4FDD\u7559\u8FC1\u79FB\u524D\u5FEB\u7167\u548C\u91CD\u5EFA\u7D22\u5F15`);
    const snapshot = (0, import_node_path.join)((0, import_node_path.dirname)(path), `pre-migration-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${(0, import_node_crypto3.randomUUID)()}.db`);
    const partial = (0, import_node_path.join)((0, import_node_path.dirname)(path), `.rivu-migration-${(0, import_node_crypto3.randomUUID)()}.partial`);
    const source = new import_node_sqlite.DatabaseSync(path);
    let reader, delegated = false, snapshotReady = false;
    try {
      source.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE");
      if (Number(source.prepare("PRAGMA user_version").get().user_version) !== version) throw Error("\u6570\u636E\u5E93\u7248\u672C\u5728\u5347\u7EA7\u51C6\u5907\u671F\u95F4\u5DF2\u6539\u53D8\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00");
      try {
        onMigrationStage?.("snapshot");
      } catch {
      }
      reader = new import_node_sqlite.DatabaseSync(path, { readOnly: true });
      await (0, import_node_sqlite.backup)(reader, partial);
      reader.close();
      reader = void 0;
      const check = new import_node_sqlite.DatabaseSync(partial);
      try {
        check.exec("PRAGMA journal_mode=DELETE");
        if (Number(check.prepare("PRAGMA user_version").get().user_version) !== version || check.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("\u8FC1\u79FB\u524D\u5FEB\u7167\u6821\u9A8C\u5931\u8D25");
      } finally {
        check.close();
      }
      const handle = (0, import_node_fs.openSync)(partial, "r+");
      try {
        (0, import_node_fs.fsyncSync)(handle);
      } finally {
        (0, import_node_fs.closeSync)(handle);
      }
      (0, import_node_fs.renameSync)(partial, snapshot);
      snapshotReady = true;
      const permit = { path: (0, import_node_path.resolve)(path), version, db: source };
      migrationPermits.add(permit);
      delegated = true;
      return new _RivuDatabase(path, onMigrationStage, false, permit);
    } catch (error) {
      if (!snapshotReady) for (const suffix of ["", "-wal", "-shm", "-journal"]) try {
        (0, import_node_fs.rmSync)(partial + suffix, { force: true });
      } catch {
      }
      throw error;
    } finally {
      try {
        reader?.close();
      } finally {
        if (!delegated) {
          try {
            if (source.isTransaction) source.exec("ROLLBACK");
          } finally {
            source.close();
          }
        }
      }
    }
  }
  close() {
    this.db.close();
  }
  feeds(metadataOnly = false) {
    if (metadataOnly) {
      const version = Number(this.db.prepare("PRAGMA data_version").get().data_version);
      if (version !== this.iconDataVersion) {
        this.iconKeys.clear();
        this.feedMetadataRows = null;
        this.iconDataVersion = version;
      }
    }
    const columns = metadataOnly ? REQUIRED_COLUMNS.feeds.filter((column) => column !== "icon").map((column) => `f.${column}`).join(",") : "f.*";
    if (metadataOnly) {
      let rows2 = !this.db.isTransaction ? this.feedMetadataRows : null;
      if (!rows2) {
        rows2 = this.db.prepare(`SELECT ${columns},c.name category_name, CASE WHEN f.enabled=0 THEN 'paused' WHEN f.failure_count>=5 THEN 'error' WHEN f.failure_count>0 THEN 'retrying' ELSE 'healthy' END health FROM feeds f LEFT JOIN categories c ON c.id=f.category_id ORDER BY f.title COLLATE NOCASE`).all();
        if (!this.db.isTransaction) this.feedMetadataRows = rows2;
      }
      const counts = new Map(this.db.prepare("SELECT feed_id,unread_count FROM rivu_feed_unread_counts").all().map((row) => [String(row.feed_id), Number(row.unread_count)]));
      return rows2.map((row) => ({ ...row, icon: null, iconKey: this.feedIconKey(String(row.id)), unread_count: counts.get(String(row.id)) ?? 0 }));
    }
    const rows = this.db.prepare(`SELECT ${columns}, c.name category_name, COALESCE(u.unread_count,0) unread_count, CASE WHEN f.enabled=0 THEN 'paused' WHEN f.failure_count>=5 THEN 'error' WHEN f.failure_count>0 THEN 'retrying' ELSE 'healthy' END health FROM feeds f LEFT JOIN categories c ON c.id=f.category_id LEFT JOIN rivu_feed_unread_counts u ON u.feed_id=f.id ORDER BY f.title COLLATE NOCASE`).all();
    return rows;
  }
  feed(id) {
    return this.db.prepare("SELECT * FROM feeds WHERE id=?").get(id);
  }
  addFeed(input) {
    const interval = validateFetchInterval(input.fetchInterval);
    if (isRecoveredFeed(input)) throw Object.assign(Error("\u6B64\u5730\u5740\u4FDD\u7559\u7ED9\u5386\u53F2\u6587\u7AE0\u6062\u590D\uFF0C\u4E0D\u80FD\u4F5C\u4E3A\u65B0\u8BA2\u9605"), { statusCode: 400 });
    const id = (0, import_node_crypto3.randomUUID)();
    this.db.exec("SAVEPOINT add_feed_with_icon_key");
    try {
      this.db.prepare("INSERT INTO feeds(id,title,url,site_url,description,icon,category_id,fetch_interval,created_at,type,rsshub_instance_id,allow_private,json_mapping,folder_authorized) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, input.title, input.url, input.siteUrl ?? null, input.description ?? null, input.icon ?? null, input.categoryId ?? null, interval ?? 30, (/* @__PURE__ */ new Date()).toISOString(), input.type ?? "rss", input.rsshubInstanceId ?? null, Number(input.allowPrivate === true), input.jsonMapping ?? null, Number(input.type === "newsletter" && input.folderAuthorized === true));
      this.db.prepare("INSERT INTO feed_icon_keys(feed_id,icon_key) VALUES (?,?)").run(id, sourceIconKey(input.icon));
      this.db.exec("RELEASE add_feed_with_icon_key");
    } catch (error) {
      this.db.exec("ROLLBACK TO add_feed_with_icon_key; RELEASE add_feed_with_icon_key");
      throw error;
    }
    return this.feed(id);
  }
  updateFeed(id, patch) {
    validateFetchInterval(patch.fetchInterval);
    const current = this.feed(id);
    if (!current) return void 0;
    if (patch.enabled !== void 0 && typeof patch.enabled !== "boolean") throw Object.assign(Error("\u8BA2\u9605\u72B6\u6001\u65E0\u6548"), { statusCode: 400 });
    if (patch.enabled === true && isRecoveredFeed(current)) throw Object.assign(Error("\u539F\u8BA2\u9605\u5730\u5740\u7F3A\u5931\uFF0C\u65E0\u6CD5\u542F\u7528\uFF1B\u8BF7\u91CD\u65B0\u6DFB\u52A0\u539F\u8BA2\u9605"), { statusCode: 400 });
    this.db.prepare("UPDATE feeds SET title=?,category_id=?,enabled=?,fetch_interval=?,allow_private=? WHERE id=?").run(patch.title ?? String(current.title), patch.categoryId === void 0 ? current.category_id : patch.categoryId, patch.enabled === void 0 ? Number(current.enabled) : Number(patch.enabled), patch.fetchInterval ?? Number(current.fetch_interval), patch.allowPrivate === void 0 ? Number(current.allow_private) : Number(patch.allowPrivate), id);
    return this.feed(id);
  }
  updateJsonMapping(id, mapping) {
    const feed = this.feed(id);
    if (!feed || feed.type !== "custom_json") return void 0;
    this.db.prepare("UPDATE feeds SET json_mapping=? WHERE id=?").run(mapping, id);
    return this.feed(id);
  }
  reconnectNewsletter(id, url) {
    const current = this.feed(id);
    if (!current || current.type !== "newsletter") return void 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE feeds SET url=?,folder_authorized=1,last_error=NULL,failure_count=0,next_fetch_at=NULL WHERE id=?").run(url, id);
      if (url !== current.url) {
        this.db.prepare("DELETE FROM newsletter_files WHERE feed_id=?").run(id);
        this.db.prepare("DELETE FROM app_meta WHERE key=?").run(`newsletter_audit:${id}`);
      }
      this.db.exec("COMMIT");
      return this.feed(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  deleteFeed(id) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM ai_results WHERE entry_id IN (SELECT id FROM entries WHERE feed_id=?)").run(id);
      this.db.prepare("DELETE FROM entry_tags WHERE entry_id IN (SELECT id FROM entries WHERE feed_id=?)").run(id);
      this.db.prepare("DELETE FROM entries WHERE feed_id=?").run(id);
      const changes = this.db.prepare("DELETE FROM feeds WHERE id=?").run(id).changes;
      this.db.prepare("DELETE FROM app_meta WHERE key=?").run(`newsletter_audit:${id}`);
      this.db.prepare("DELETE FROM app_meta WHERE key=?").run("feed-metadata-write");
      this.db.exec("COMMIT");
      return changes;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  categories() {
    return this.db.prepare("SELECT * FROM categories ORDER BY sort,name").all();
  }
  addCategory(name) {
    const id = (0, import_node_crypto3.randomUUID)();
    this.db.prepare("INSERT INTO categories(id,name,created_at) VALUES (?,?,?)").run(id, name.trim(), (/* @__PURE__ */ new Date()).toISOString());
    return this.db.prepare("SELECT * FROM categories WHERE id=?").get(id);
  }
  deleteCategory(id) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE feeds SET category_id=NULL WHERE category_id=?").run(id);
      const changes = this.db.prepare("DELETE FROM categories WHERE id=?").run(id).changes;
      this.db.exec("COMMIT");
      return changes;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  addEntries(feedId, entries, inTransaction = false) {
    if (inTransaction && !this.db.isTransaction) throw Error("\u6587\u7AE0\u5199\u5165\u9700\u8981\u5DF2\u6709\u4E8B\u52A1");
    const insert = this.db.prepare("INSERT INTO entries(id,feed_id,guid,title,author,url,published_at,fetched_at,content,description,cover,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    const insertMedia = this.db.prepare("INSERT OR IGNORE INTO entry_media(entry_id,kind,url,mime,source,title,created_at) VALUES (?,?,?,?,?,?,?)");
    const insertIdentity = this.db.prepare("INSERT OR IGNORE INTO entry_identities(feed_id,entry_id,kind,value) VALUES (?,?,?,?)");
    const lookup = this.db.prepare("SELECT entry_id FROM entry_identities WHERE feed_id=? AND kind=? AND value=? LIMIT 2");
    const contentLookup = this.db.prepare("SELECT e.id FROM entry_identities i JOIN entries e ON e.id=i.entry_id WHERE i.feed_id=? AND i.kind=? AND i.value=? AND (?='' OR e.published_at IS NULL OR e.published_at='' OR e.published_at=? OR julianday(e.published_at)=julianday(?)) LIMIT 2");
    const existing = this.db.prepare("SELECT id FROM entries WHERE feed_id=? AND hash=?");
    const feed = this.feed(feedId);
    if (!feed) throw Error("\u8BA2\u9605\u4E0D\u5B58\u5728");
    const conflict = () => Object.assign(Error("\u6587\u7AE0\u6807\u8BC6\u5B58\u5728\u51B2\u7A81\uFF0C\u672C\u6279\u6B21\u5DF2\u4FDD\u7559\u539F\u6570\u636E\uFF1B\u8BF7\u68C0\u67E5\u6765\u6E90\u7684 GUID \u6216\u6587\u7AE0\u5730\u5740"), { statusCode: 409 });
    if (!inTransaction) this.db.exec("BEGIN");
    try {
      let added = 0;
      for (const e of entries) {
        const identities = entryIdentities(e, String(feed.url)), matches = /* @__PURE__ */ new Set();
        let ambiguous = false;
        const exact = existing.get(feedId, e.hash);
        if (exact) matches.add(exact.id);
        for (const identity of identities.filter((value) => value.kind !== "content")) {
          const rows = lookup.all(feedId, identity.kind, identity.value);
          if (rows.length > 1) ambiguous = true;
          else if (rows.length === 1) matches.add(rows[0].entry_id);
        }
        if (matches.size > 1 || !matches.size && ambiguous) throw conflict();
        if (!matches.size && feed.type !== "newsletter" && !identities.some((value) => value.kind === "url" || value.kind === "canonical")) {
          const content = identities.find((value) => value.kind === "content");
          if (content) {
            const published = e.publishedAt || "", parsed = Date.parse(published), iso = Number.isFinite(parsed) ? new Date(parsed).toISOString() : published;
            const rows = contentLookup.all(feedId, "content", content.value, published, published, iso);
            for (const row of rows) matches.add(row.id);
            if (matches.size > 1) throw conflict();
          }
        }
        const created = !matches.size, id = matches.values().next().value || (0, import_node_crypto3.randomUUID)(), now = (/* @__PURE__ */ new Date()).toISOString();
        if (created) {
          insert.run(id, feedId, e.guid ?? null, e.title, e.author ?? null, e.url ?? null, e.publishedAt ?? null, now, e.content ?? null, e.description ?? null, e.cover ?? null, e.hash);
          added++;
        }
        for (const identity of identities) insertIdentity.run(feedId, id, identity.kind, identity.value);
        if (e.media === void 0) continue;
        if (!created) this.db.prepare("DELETE FROM entry_media WHERE entry_id=? AND source IN ('cover','enclosure','metadata')").run(id);
        for (const media of e.media.slice(0, 60)) {
          if (!created && media.source === "body") continue;
          insertMedia.run(id, media.kind, media.url, media.mime, media.source, media.title, now);
        }
      }
      if (!inTransaction) this.db.exec("COMMIT");
      return added;
    } catch (error) {
      if (!inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  entryMedia(id) {
    return this.db.prepare("SELECT kind,url,mime,source,title FROM entry_media WHERE entry_id=? ORDER BY CASE source WHEN 'cover' THEN 0 WHEN 'body' THEN 1 WHEN 'enclosure' THEN 2 ELSE 3 END,url").all(id);
  }
  markFetch(id, error) {
    const feed = this.db.prepare("SELECT failure_count,fetch_interval FROM feeds WHERE id=?").get(id);
    if (!feed) return;
    const now = Date.now(), attemptAt = new Date(now).toISOString(), failed = error !== void 0, failures = failed ? Number(feed.failure_count) + 1 : 0;
    const minutes = failed ? Math.min(24 * 60, Math.max(Number(feed.fetch_interval), 1) * 2 ** Math.min(failures, 6)) : Number(feed.fetch_interval);
    this.db.prepare("UPDATE feeds SET last_fetched_at=?,last_success_at=CASE WHEN ? THEN last_success_at ELSE ? END,failure_count=?,last_error=?,next_fetch_at=? WHERE id=?").run(attemptAt, Number(failed), attemptAt, failures, failed ? error || "\u672A\u77E5\u9519\u8BEF" : null, new Date(now + minutes * 6e4).toISOString(), id);
  }
  refreshableFeeds(dueOnly = false) {
    return this.db.prepare(`SELECT id,url FROM feeds WHERE enabled=1${dueOnly ? " AND fetch_interval>0 AND (next_fetch_at IS NULL OR next_fetch_at<=?)" : ""}`).all(...dueOnly ? [(/* @__PURE__ */ new Date()).toISOString()] : []).filter((feed) => !isRecoveredFeed(feed));
  }
  dueFeeds() {
    return this.refreshableFeeds(true);
  }
  entries(opts = {}) {
    return queryEntries(this.db, opts);
  }
  entry(id) {
    return queryEntry(this.db, id);
  }
  aiBodySnapshot(id) {
    return this.db.prepare("SELECT id,title,COALESCE(NULLIF(full_content,''),NULLIF(content,''),description,'') html,body_revision FROM entries WHERE id=?").get(id);
  }
  aiBodyIdentity(id) {
    return this.db.prepare("SELECT id,title,body_revision FROM entries INDEXED BY entries_ai_identity WHERE id=?").get(id);
  }
  markRead(scope, inTransaction = false) {
    if (inTransaction && !this.db.isTransaction) throw Error("\u6279\u91CF\u5DF2\u8BFB\u9700\u8981\u5DF2\u6709\u4E8B\u52A1");
    const active = Object.entries(scope).filter(([, value2]) => value2 !== void 0);
    if (active.length !== 1) throw invalidReadScope("\u6279\u91CF\u64CD\u4F5C\u5FC5\u987B\u4E14\u53EA\u80FD\u6307\u5B9A\u4E00\u4E2A\u8303\u56F4");
    const [kind, value] = active[0];
    if (kind === "ids") {
      if (!Array.isArray(value) || value.length === 0 || value.length > 5e3 || value.some((id) => typeof id !== "string" || !id)) throw invalidReadScope("\u6587\u7AE0\u9009\u62E9\u8303\u56F4\u65E0\u6548");
      const changed = [];
      if (!inTransaction) this.db.exec("BEGIN");
      try {
        for (let offset = 0; offset < value.length; offset += 400) {
          const chunk = [...new Set(value.slice(offset, offset + 400))];
          const placeholders = chunk.map(() => "?").join(",");
          const rows2 = this.db.prepare(`UPDATE entries SET read=1 WHERE read=0 AND id IN (${placeholders}) RETURNING id`).all(...chunk);
          changed.push(...rows2.map((row) => row.id));
        }
        if (!inTransaction) this.db.exec("COMMIT");
        return changed;
      } catch (error) {
        if (!inTransaction) this.db.exec("ROLLBACK");
        throw error;
      }
    }
    let where = "e.read=0";
    const args = [];
    if (kind === "view") {
      if (!["unread", "today", "all", "starred", "saved", "summary", "blocked", "images", "audio", "video"].includes(String(value))) throw invalidReadScope("\u65E0\u6548\u7684\u89C6\u56FE\u8303\u56F4");
      where += value === "blocked" ? ` AND ${blocked}` : ` AND NOT ${blocked}`;
      if (value === "unread") where += ` AND NOT ${muted}`;
      if (value === "today") where += " AND substr(e.published_at,1,10)=date('now','localtime')";
      if (value === "starred") where += " AND e.starred=1";
      if (value === "saved") where += ` AND (e.saved=1 OR ${ruleSaved})`;
      if (value === "summary") where += " AND EXISTS (SELECT 1 FROM ai_results a WHERE a.entry_id=e.id AND a.type='summary')";
      if (value === "images" || value === "audio" || value === "video") {
        where += " AND EXISTS (SELECT 1 FROM entry_media em WHERE em.entry_id=e.id AND em.kind=?)";
        args.push(value === "images" ? "image" : value);
      }
    } else if (kind === "feedId" || kind === "categoryId" || kind === "tagId") {
      if (typeof value !== "string" || !value) throw invalidReadScope("\u65E0\u6548\u7684\u8303\u56F4 ID");
      where += ` AND NOT ${blocked}`;
      if (kind === "feedId") where += " AND e.feed_id=?";
      if (kind === "categoryId") where += " AND f.category_id=?";
      if (kind === "tagId") {
        where += " AND (EXISTS (SELECT 1 FROM entry_tags et WHERE et.entry_id=e.id AND et.tag_id=?) OR EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id WHERE rm.entry_id=e.id AND rr.enabled=1 AND rr.action_type='tag' AND rr.tag_id=?))";
        args.push(value, value);
      } else args.push(value);
    } else throw invalidReadScope("\u65E0\u6548\u7684\u6279\u91CF\u64CD\u4F5C\u8303\u56F4");
    const rows = this.db.prepare(`UPDATE entries SET read=1 WHERE id IN (SELECT e.id FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE ${where}) RETURNING id`).all(...args);
    return rows.map((row) => row.id);
  }
  undoMarkRead(ids, inTransaction = false) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)) throw Error("\u64A4\u9500\u8303\u56F4\u65E0\u6548");
    if (inTransaction && !this.db.isTransaction) throw Error("\u64A4\u9500\u5DF2\u8BFB\u9700\u8981\u5DF2\u6709\u4E8B\u52A1");
    if (!inTransaction) this.db.exec("BEGIN");
    try {
      let changed = 0;
      for (let offset = 0; offset < ids.length; offset += 400) {
        const chunk = ids.slice(offset, offset + 400);
        const placeholders = chunk.map(() => "?").join(",");
        changed += Number(this.db.prepare(`UPDATE entries SET read=0 WHERE read=1 AND id IN (${placeholders})`).run(...chunk).changes);
      }
      if (!inTransaction) this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      if (!inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  updateEntry(id, patch) {
    const current = this.entryState(id);
    if (!current) return void 0;
    this.db.prepare("UPDATE entries SET read=?,starred=?,saved=?,archived=? WHERE id=?").run(...["read", "starred", "saved", "archived"].map((k) => patch[k] === void 0 ? Number(current[k]) : Number(patch[k])), id);
    return this.entry(id);
  }
  readingPosition(id) {
    return this.db.prepare("SELECT progress,updated_at FROM reading_positions WHERE entry_id=?").get(id);
  }
  entryState(id) {
    return this.db.prepare("SELECT e.id,e.feed_id,e.read,e.starred,e.saved,e.archived FROM entries e INDEXED BY entries_list_metadata JOIN feeds f ON f.id=e.feed_id WHERE e.id=? LIMIT 1").get(id);
  }
  hasEntry(id) {
    return !!this.db.prepare("SELECT 1 FROM entries e INDEXED BY entries_list_metadata JOIN feeds f ON f.id=e.feed_id WHERE e.id=? LIMIT 1").get(id);
  }
  saveReadingPosition(id, progress) {
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw invalidReadScope("\u9605\u8BFB\u8FDB\u5EA6\u65E0\u6548");
    if (!this.hasEntry(id)) return void 0;
    this.db.prepare("INSERT INTO reading_positions(entry_id,progress,updated_at) VALUES (?,?,?) ON CONFLICT(entry_id) DO UPDATE SET progress=excluded.progress,updated_at=excluded.updated_at").run(id, progress, (/* @__PURE__ */ new Date()).toISOString());
    return this.readingPosition(id);
  }
  offlineSave(id) {
    return this.db.prepare("SELECT include_images,status,last_error,updated_at FROM offline_saves WHERE entry_id=?").get(id);
  }
  setOfflineSave(id, includeImages, status, error) {
    if (!this.hasEntry(id)) return void 0;
    this.db.prepare("INSERT INTO offline_saves(entry_id,include_images,status,last_error,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET include_images=excluded.include_images,status=excluded.status,last_error=excluded.last_error,updated_at=excluded.updated_at").run(id, Number(includeImages), status, error ?? null, (/* @__PURE__ */ new Date()).toISOString());
    return this.offlineSave(id);
  }
  interruptOfflineSaves() {
    this.db.prepare("UPDATE offline_saves SET status='interrupted',last_error='\u4E0A\u6B21\u79BB\u7EBF\u4FDD\u5B58\u88AB\u4E2D\u65AD',updated_at=? WHERE status='running'").run((/* @__PURE__ */ new Date()).toISOString());
  }
  aiResult(entryId, type, language) {
    return this.db.prepare("SELECT id,entry_id,type,language,provider,model,content,prompt_version,created_at,content_hash FROM ai_results WHERE entry_id=? AND type=? AND language=? ORDER BY created_at DESC LIMIT 1").get(entryId, type, language);
  }
  validAIResult(entryId, type, language, provider, model, hash, promptVersion) {
    return this.db.prepare("SELECT id,entry_id,type,language,provider,model,content,prompt_version,created_at,content_hash FROM ai_results WHERE entry_id=? AND type=? AND language=? AND provider=? AND model=? AND content_hash=? AND prompt_version=? LIMIT 1").get(entryId, type, language, provider, model, hash, promptVersion);
  }
  saveAI(entryId, type, language, provider, model, content, hash = "", promptVersion = "v1") {
    this.db.prepare("INSERT INTO ai_results(id,entry_id,type,language,provider,model,content,prompt_version,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entry_id,type,language,provider,model) DO UPDATE SET content=excluded.content,prompt_version=excluded.prompt_version,content_hash=excluded.content_hash,created_at=excluded.created_at").run((0, import_node_crypto3.randomUUID)(), entryId, type, language, provider, model, content, promptVersion, hash, (/* @__PURE__ */ new Date()).toISOString());
    return this.aiResult(entryId, type, language);
  }
  rsshubInstances() {
    return this.db.prepare("SELECT * FROM rsshub_instances ORDER BY created_at").all();
  }
  rsshubInstance(id) {
    return this.db.prepare("SELECT * FROM rsshub_instances WHERE id=?").get(id);
  }
  addRsshubInstance(name, baseUrl, allowPrivate = false) {
    const id = (0, import_node_crypto3.randomUUID)();
    this.db.prepare("INSERT INTO rsshub_instances(id,name,base_url,allow_private,created_at) VALUES (?,?,?,?,?)").run(id, name, baseUrl, Number(allowPrivate), (/* @__PURE__ */ new Date()).toISOString());
    return this.rsshubInstance(id);
  }
  deleteRsshubInstance(id) {
    return this.db.prepare("DELETE FROM rsshub_instances WHERE id=?").run(id).changes;
  }
  tags() {
    return this.db.prepare("SELECT * FROM tags ORDER BY name COLLATE NOCASE").all();
  }
  filterDecision(entryId) {
    return this.db.prepare("SELECT * FROM ai_filter_decisions WHERE entry_id=?").get(entryId);
  }
  setFilterDecision(entryId, value) {
    if (!this.hasEntry(entryId)) throw Object.assign(Error("\u6587\u7AE0\u4E0D\u5B58\u5728"), { statusCode: 404 });
    this.db.exec("BEGIN");
    try {
      if (value.decision === "keep") this.db.prepare("DELETE FROM ai_filter_decisions WHERE entry_id=?").run(entryId);
      else this.db.prepare("INSERT INTO ai_filter_decisions(entry_id,decision,reason,criteria,provider,model,content_hash,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET decision=excluded.decision,reason=excluded.reason,criteria=excluded.criteria,provider=excluded.provider,model=excluded.model,content_hash=excluded.content_hash,updated_at=excluded.updated_at").run(entryId, value.decision, value.reason, value.criteria, value.provider, value.model, value.content_hash, (/* @__PURE__ */ new Date()).toISOString());
      this.db.exec("COMMIT");
      return this.filterDecision(entryId) || null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  addTag(name, color = "#38A7F8") {
    const id = (0, import_node_crypto3.randomUUID)();
    this.db.prepare("INSERT INTO tags(id,name,color) VALUES (?,?,?)").run(id, name.trim(), color);
    return this.db.prepare("SELECT * FROM tags WHERE id=?").get(id);
  }
  appendEntryTagNames(entryId, names, reconcile4) {
    const entry = this.entryState(entryId);
    if (!entry) throw Object.assign(Error("\u6587\u7AE0\u4E0D\u5B58\u5728"), { statusCode: 404 });
    this.db.exec("BEGIN");
    try {
      const find = this.db.prepare("SELECT id FROM tags WHERE name=?");
      const add = this.db.prepare("INSERT OR IGNORE INTO entry_tags(entry_id,tag_id) VALUES (?,?)");
      for (const name of names) {
        const existing = find.get(name);
        const tag = existing || this.addTag(name);
        add.run(entryId, tag.id);
      }
      reconcile4(entry.feed_id);
      const result = this.entryTags(entryId);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  deleteTag(id) {
    return this.db.prepare("DELETE FROM tags WHERE id=?").run(id).changes;
  }
  entryTags(entryId) {
    return this.db.prepare("SELECT t.*,CASE WHEN EXISTS (SELECT 1 FROM entry_tags et WHERE et.entry_id=? AND et.tag_id=t.id) THEN 1 ELSE 0 END manual,CASE WHEN EXISTS (SELECT 1 FROM rule_matches rm JOIN rules r ON r.id=rm.rule_id WHERE rm.entry_id=? AND r.enabled=1 AND r.action_type='tag' AND r.tag_id=t.id) THEN 1 ELSE 0 END rule_based FROM tags t WHERE manual=1 OR rule_based=1 ORDER BY t.name").all(entryId, entryId);
  }
  setEntryTags(entryId, tagIds) {
    if (!this.hasEntry(entryId)) return void 0;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM entry_tags WHERE entry_id=?").run(entryId);
      const add = this.db.prepare("INSERT INTO entry_tags(entry_id,tag_id) VALUES (?,?)");
      for (const id of [...new Set(tagIds)]) add.run(entryId, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.entryTags(entryId);
  }
  setFullContent(id, html, canonicalUrl, inTransaction = false) {
    if (inTransaction && !this.db.isTransaction) throw Error("\u6B63\u6587\u5199\u5165\u9700\u8981\u5DF2\u5F00\u542F\u4E8B\u52A1");
    if (!inTransaction) this.db.exec("BEGIN");
    try {
      const current = this.db.prepare("SELECT e.full_content,e.content,e.description,e.url,f.url feed_url FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE e.id=?").get(id);
      const sameText = current && aiPlainText(current.full_content || current.content || current.description || "").slice(0, 4e4) === aiPlainText(html || current.content || current.description || "").slice(0, 4e4);
      if (canonicalUrl && current) {
        const canonical = declaredCanonical(canonicalUrl, current.url || void 0, current.feed_url);
        if (canonical) {
          const source = this.db.prepare("SELECT feed_id FROM entries WHERE id=?").get(id);
          const conflict = this.db.prepare("SELECT entry_id FROM entry_identities WHERE feed_id=? AND kind=? AND value=? AND entry_id<>? LIMIT 1").get(source.feed_id, "canonical", canonical, id);
          if (!conflict) this.db.prepare("INSERT OR IGNORE INTO entry_identities(feed_id,entry_id,kind,value) VALUES (?,?,?,?)").run(source.feed_id, id, "canonical", canonical);
        }
      }
      if (current?.full_content === html) {
        this.db.prepare("UPDATE entries SET full_content_fetched_at=? WHERE id=?").run((/* @__PURE__ */ new Date()).toISOString(), id);
      } else {
        this.db.prepare("UPDATE entries SET full_content=?,full_content_fetched_at=? WHERE id=?").run(html, (/* @__PURE__ */ new Date()).toISOString(), id);
        this.db.prepare("DELETE FROM entry_media WHERE entry_id=? AND source='body'").run(id);
        const insert = this.db.prepare("INSERT OR IGNORE INTO entry_media(entry_id,kind,url,mime,source,title,created_at) VALUES (?,?,?,?,?,?,?)");
        for (const media of bodyImages(html, current?.url || current?.feed_url)) insert.run(id, media.kind, media.url, media.mime, media.source, media.title, (/* @__PURE__ */ new Date()).toISOString());
        if (!sameText) this.db.prepare("DELETE FROM ai_results WHERE entry_id=? AND type IN ('summary','translation','keywords','classification','explain','rewrite','custom','tags','filter')").run(id);
      }
      if (!inTransaction) this.db.exec("COMMIT");
    } catch (error) {
      if (!inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    return this.entry(id);
  }
  cachedImage(url) {
    return this.db.prepare("SELECT * FROM cached_images WHERE url=?").get(url);
  }
  cachedImages() {
    return this.db.prepare("SELECT * FROM cached_images ORDER BY last_accessed_at ASC").all();
  }
  saveCachedImage(url, fileName, mime, bytes) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare("INSERT INTO cached_images(url,file_name,mime,bytes,saved_at,last_accessed_at) VALUES (?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET file_name=excluded.file_name,mime=excluded.mime,bytes=excluded.bytes,last_accessed_at=excluded.last_accessed_at").run(url, fileName, mime, bytes, now, now);
  }
  touchCachedImage(url) {
    this.db.prepare("UPDATE cached_images SET last_accessed_at=? WHERE url=?").run((/* @__PURE__ */ new Date()).toISOString(), url);
  }
  deleteCachedImage(url) {
    this.db.prepare("DELETE FROM cached_images WHERE url=?").run(url);
  }
  backup(dest) {
    return (0, import_node_sqlite.backup)(this.db, dest);
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RECOVERED_FEED_URL_PREFIX,
  RivuDatabase,
  SCHEMA_VERSION,
  isRecoveredFeed,
  validateFetchInterval,
  validateSchema
});
