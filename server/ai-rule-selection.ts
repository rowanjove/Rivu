import type {RuleConditions} from './rules';
export function selection(conditions:RuleConditions,feedId?:string,since?:string){
  const where:string[]=[];const args:string[]=[];
  if(feedId){where.push('e.feed_id=?');args.push(feedId);}
  if(since){where.push('e.fetched_at>=?');args.push(since);}
  if(conditions.feedId){where.push('e.feed_id=?');args.push(conditions.feedId);}
  if(conditions.titleKeyword){where.push('instr(lower(e.title),lower(?))>0');args.push(conditions.titleKeyword);}
  if(conditions.bodyKeyword){where.push("instr(lower(COALESCE(NULLIF(e.full_content,''),NULLIF(e.content,''),e.description,'')),lower(?))>0");args.push(conditions.bodyKeyword);}
  if(conditions.after){where.push('substr(COALESCE(e.published_at,e.fetched_at),1,10)>=?');args.push(conditions.after);}
  if(conditions.before){where.push('substr(COALESCE(e.published_at,e.fetched_at),1,10)<=?');args.push(conditions.before);}
  if(conditions.type){where.push('f.type=?');args.push(conditions.type);}
  if(conditions.tagId){where.push("(EXISTS (SELECT 1 FROM entry_tags et WHERE et.entry_id=e.id AND et.tag_id=?) OR EXISTS (SELECT 1 FROM rule_matches m JOIN rules r ON r.id=m.rule_id WHERE m.entry_id=e.id AND r.enabled=1 AND r.action_type='tag' AND r.tag_id=?))");args.push(conditions.tagId,conditions.tagId);}
  return {where:where.length?where.join(' AND '):'1=1',args};
}
