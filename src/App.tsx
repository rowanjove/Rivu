import {AboutSettings} from './AboutSettings';
import {AIBlock} from './AIBlock';
import {AISettings} from './AISettings';
import {trackReadingPosition} from './reading-position';
import {FeedSettingsList} from './FeedSettingsList';
import {loadPaneLayout,savePaneLayout} from './pane-layout';
import {openExternalLink} from './external-link';
import {formatShortDate as formatDate,formatFullDate} from './date-display';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  Archive,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  Folder,
  Inbox,
  Image,
  List,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronsLeft,
  ChevronsRight,
  Maximize2,
  Minimize2,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldX,
  Headphones,
  Star,
  Tag as TagIcon,
  Upload,
  Video,
  X,
} from "lucide-react";
import { api, type Category, type Entry, type Feed, type SmartFolder, type Tag } from "./api";
import { AddFeedDialog } from "./AddFeedDialog";
import { EntryTimelineRow } from "./EntryTimelineRow";
import { FeedNavigation } from './FeedNavigation';
import { createCoalescedRefresh } from './coalesced-refresh';
import { SettingsNavigation } from "./SettingsNavigation";
import { RsshubSettings } from "./RsshubSettings";
import { RichArticle } from "./RichArticle";
import { EntryMedia } from "./EntryMedia";
import { TagPicker } from "./TagPicker";
import { ImageCacheSettings } from "./ImageCacheSettings";
import { ProxySettings } from "./ProxySettings";
import { OpmlImportDialog } from "./OpmlImportDialog";
import { RulesSettings } from "./RulesSettings";
import { AIRulesSettings } from "./AIRulesSettings";
import { SmartFoldersSettings } from "./SmartFoldersSettings";
import { AIChatPanel } from "./AIChatPanel";
import { ArchiveManager } from "./ArchiveManager";
import { defaultReadingPreferences, loadReadingPreferences, type ReadingPreferences } from "./reading";

const isRecoveredSource=(feed:Feed)=>{try{return new URL(feed.url).hostname.replace(/\.$/,'')==='recovered.invalid';}catch{return false;}};

const nav = [
  { id: "unread", label: "收件箱", icon: Inbox },
  { id: "today", label: "今日", icon: Clock3 },
  { id: "all", label: "全部", icon: List },
  { id: "starred", label: "收藏", icon: Star },
  { id: "saved", label: "稍后阅读", icon: BookOpen },
  { id: "blocked", label: "已屏蔽", icon: ShieldX },
  { id: "summary", label: "AI 摘要", icon: FileText },
  { id: "images", label: "图片", icon: Image },
  { id: "video", label: "视频", icon: Video },
  { id: "audio", label: "音频", icon: Headphones },
];
type View = { id: string; label: string; feedId?: string; categoryId?: string; tagId?:string; smartFolderId?:string };
export function App() {
  const [paneLayout,setPaneLayout]=useState(loadPaneLayout),[focusReading,setFocusReading]=useState(false),[heldListWidth,setHeldListWidth]=useState(440);
  const shellRef=useRef<HTMLDivElement>(null);
  useEffect(()=>savePaneLayout(paneLayout),[paneLayout]);
  const [feeds, setFeeds] = useState<Feed[]>([]),
    [categories, setCategories] = useState<Category[]>([]),
    [tags,setTags] = useState<Tag[]>([]),
    [smartFolders,setSmartFolders] = useState<SmartFolder[]>([]),
    [entries, setEntries] = useState<Entry[]>([]),
    [selected, setSelected] = useState<Entry | null>(null),
    [selectedLoading,setSelectedLoading] = useState(false);
  const [updatingEntryStates,setUpdatingEntryStates]=useState<Set<string>>(new Set());
  const [restoringBackup,setRestoringBackup]=useState(false);
  const entryStateInFlight=useRef(new Set<string>());
  const automaticReadInFlight=useRef(new Map<string,Promise<void>>());
  const [view, setView] = useState<View>({ id: "unread", label: "收件箱" }),
    [query, setQuery] = useState(""),
    [searchQuery, setSearchQuery] = useState(""),
    [showAdd, setShowAdd] = useState(false),
    [editingJsonFeed,setEditingJsonFeed] = useState<Feed|null>(null),
    [showSettings, setShowSettings] = useState(false),
    [showImport,setShowImport] = useState(false),
    [showTags,setShowTags] = useState(false),
    [showArchives,setShowArchives] = useState(false),
    [smartDraftQuery,setSmartDraftQuery] = useState(''),
    [updatingFeedTrust,setUpdatingFeedTrust] = useState<string|null>(null),
    [updatingFeedIcon,setUpdatingFeedIcon] = useState<string|null>(null),
    [updatingFeedSettings,setUpdatingFeedSettings] = useState<Set<string>>(new Set()),
    [feedSettingNotices,setFeedSettingNotices] = useState<Record<string,{text:string;error:boolean}>>({}),
    [iconNotice,setIconNotice] = useState<{id:string;text:string}|null>(null),
    [error, setError] = useState(""),
    [refreshNotice,setRefreshNotice] = useState(""),
    [systemOnline,setSystemOnline] = useState(() => navigator.onLine),
    [loading, setLoading] = useState(false),
    [hasMore, setHasMore] = useState(false),
    [backupSecrets, setBackupSecrets] = useState(false),
    [backupMessage,setBackupMessage] = useState(''),
    [storageStats,setStorageStats] = useState<{estimatedBackupBytes:number;lastRestore:null|{completedAt:string;durationMs:number;backupBytes:number}}|null>(null),
    [automaticBackup,setAutomaticBackup] = useState<{frequency:'off'|'daily'|'weekly';keep:number;lastSuccessAt:string|null;lastError:string|null;nextDueAt:string|null;running:boolean;backups:{name:string;bytes:number}[]}|null>(null),
    [maintenance,setMaintenance] = useState<{running:boolean;phase:'draining'|'backup'|'cache'|'fts'|'vacuum'|'integrity'|null;snapshotPercent:number|null;lastError:string|null;lastResult:null|{completedAt:string;durationMs:number;beforeBytes:number;afterBytes:number;removedCacheRows:number;backupPath:string}}|null>(null),
    [reading, setReading] = useState<ReadingPreferences>(loadReadingPreferences),
    [readingLoaded,setReadingLoaded] = useState(false),
    [readingBusy,setReadingBusy] = useState(false),
    [readingError,setReadingError] = useState(''),
    [readingNotice,setReadingNotice] = useState('');
  useEffect(()=>window.rivu.onExternalError(setError),[]);
  const density=reading.density;
  const feedIcons=useMemo(()=>new Map(feeds.map(feed=>[feed.id,feed])),[feeds]);
  const requestVersion = useRef(0);
  const pageRequest=useRef<{version:number}|null>(null);
  const nextPage=useRef<{version:number;path:string}|null>(null);
  const selectedVersion = useRef(0);
  const listRef=useRef<VirtuosoHandle>(null);
  const readingOperation=useRef(false),readingGeneration=useRef(0);
  const feedSettingsInFlight=useRef(new Set<string>());
  const visibleAnchor=useRef<string|null>(null);
  const restoreAnchor=useRef<string|null>(null);
  const currentVisibleAnchor=()=>{
    const viewport=document.querySelector('.entry-scroll')?.getBoundingClientRect();
    if(!viewport)return visibleAnchor.current;
    const rows=[...document.querySelectorAll<HTMLElement>('.entry-row[data-entry-id]')];
    return rows.filter(row=>{const box=row.getBoundingClientRect();return box.bottom>viewport.top&&box.top<viewport.bottom;})
      .sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0]?.dataset.entryId??visibleAnchor.current;
  };
  const [bulkMode,setBulkMode]=useState(false);
  const [bulkSelected,setBulkSelected]=useState<Set<string>>(new Set());
  const [selectedFeeds,setSelectedFeeds]=useState<Set<string>>(new Set());
  const [bulkFeedCategory,setBulkFeedCategory]=useState('');
  const [bulkFeedInterval,setBulkFeedInterval]=useState(30);
  const [bulkFeedBusy,setBulkFeedBusy]=useState(false);
  const [undoRead,setUndoRead]=useState<{token:string;count:number}|null>(null);
  const bulkReadInFlight=useRef(false);
  const [bulkReadBusy,setBulkReadBusy]=useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [settingsTarget,setSettingsTarget]=useState<string>('general');
  const [chatScopeIds,setChatScopeIds]=useState<string[]|null>(null);
  const closeSettings=()=>{const returnToChat=settingsTarget==='ai'&&!!chatScopeIds;setShowSettings(false);setSettingsTarget('general');if(returnToChat)requestAnimationFrame(()=>document.querySelector<HTMLTextAreaElement>('.ai-chat-compose textarea')?.focus());};
  const [refreshMeta] = useState(()=>createCoalescedRefresh(async () => {
    const [f, c,t,s] = await Promise.all([
      api.get<Feed[]>("/api/feeds?icons=metadata"),
      api.get<Category[]>("/api/categories"),
      api.get<Tag[]>("/api/tags"),
      api.get<SmartFolder[]>("/api/smart-folders"),
    ]);
    setFeeds(f);
    setSelectedFeeds(previous=>new Set([...previous].filter(id=>f.some(feed=>feed.id===id))));
    setCategories(c);
    setTags(t);
    setSmartFolders(s);
  }));
  const clearQuery=useCallback(()=>{setQuery("");setSearchQuery("");},[]);
  const entryPath = (offset = 0,limit=100,cursor?:Entry) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if(cursor){qs.set('beforeTime',cursor.published_at||cursor.fetched_at);qs.set('beforeId',cursor.id);}
    else qs.set('offset',String(offset));
    if (searchQuery.trim()) qs.set("q", searchQuery.trim());
    else if (view.smartFolderId) return `/api/smart-folders/${view.smartFolderId}/entries?${qs}`;
    else if (view.feedId) qs.set("feedId", view.feedId);
    else if (view.categoryId) qs.set("categoryId", view.categoryId);
    else if (view.tagId) qs.set("tagId",view.tagId);
    else qs.set("view", view.id);
    return `/api/entries?${qs}`;
  };
  const refreshEntries = async (preservePosition=false) => {
    const version = ++requestVersion.current;
    nextPage.current=null;
    restoreAnchor.current=preservePosition?currentVisibleAnchor():null;
    const anchorIndex=entries.findIndex(entry=>entry.id===restoreAnchor.current);
    setLoading(true);
    try {
      const rows:Entry[]=[];
      const targetCount=preservePosition?Math.max(100,entries.length):100;
      const anchor=restoreAnchor.current;
      let hasMoreRows=false;
      while(rows.length<targetCount||(anchor&&!rows.some(row=>row.id===anchor)&&rows.length<targetCount+500)){
        const limit=Math.min(500,Math.max(targetCount-rows.length,100));
        const page=await api.get<Entry[]>(entryPath(rows.length,limit,rows.at(-1)));
        if(version!==requestVersion.current)return;
        rows.push(...page);
        hasMoreRows=page.length===limit;
        if(!hasMoreRows)break;
      }
      const selectedBefore=selected?.id;
      const selectedFromRows=selectedBefore?rows.find(row=>row.id===selectedBefore):undefined;
      const selectedFromDatabase=selectedBefore?await api.get<Entry>(`/api/entries/${selectedBefore}`).catch(()=>null):null;
      if(version!==requestVersion.current)return;
      if(anchor&&!rows.some(row=>row.id===anchor)){
        const available=new Set(rows.map(row=>row.id));
        let neighbor:string|null=null;
        for(let index=anchorIndex+1;index<entries.length&&!neighbor;index++)if(available.has(entries[index].id))neighbor=entries[index].id;
        for(let index=anchorIndex-1;index>=0&&!neighbor;index--)if(available.has(entries[index].id))neighbor=entries[index].id;
        restoreAnchor.current=neighbor;
      }
      nextPage.current={version,path:entryPath(rows.length,100,rows.at(-1))};
      setEntries(rows);
      setHasMore(hasMoreRows);
      setSelected((old) =>
        old ? old.id!==selectedBefore?old:selectedFromDatabase||selectedFromRows||null : null,
      );
    } catch (e) {
      if (version === requestVersion.current) setError(String(e));
    } finally {
      if (version === requestVersion.current)setLoading(false);
    }
  };
  const loadMore = async () => {
    const version = requestVersion.current;
    if (!hasMore || loading || pageRequest.current?.version===version) return;
    const path=entryPath(entries.length,100,entries.at(-1));
    // Only the accepted cursor may advance, including before React commits.
    if(nextPage.current?.version!==version||nextPage.current.path!==path)return;
    const request={version};pageRequest.current=request;
    try {
      const rows = await api.get<Entry[]>(path);
      if (version !== requestVersion.current) return;
      setEntries((old) => [...old, ...rows]);
      setHasMore(rows.length === 100);
      nextPage.current={version,path:entryPath(entries.length+rows.length,100,rows.at(-1)||entries.at(-1))};
    } catch (e) {
      if(version===requestVersion.current)setError(String(e));
    } finally {
      if(pageRequest.current===request)pageRequest.current=null;
    }
  };
  useEffect(() => {
    refreshMeta().catch((e) => setError(String(e)));
  }, []);
  useEffect(()=>{const update=()=>setSystemOnline(navigator.onLine);window.addEventListener('online',update);window.addEventListener('offline',update);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
  useEffect(()=>{const timer=setTimeout(()=>setSearchQuery(query),250);return()=>clearTimeout(timer);},[query]);
  useEffect(()=>{
    if(!showSettings||restoringBackup)return;
    let active=true;
    const report=(error:unknown)=>{if(active)setError(String(error));};
    void api.get<{estimatedBackupBytes:number;lastRestore:null|{completedAt:string;durationMs:number;backupBytes:number}}>('/api/storage/stats').then(value=>{if(active)setStorageStats(value);}).catch(report);
    const refresh=()=>{
      void api.get<typeof automaticBackup>('/api/backups/automatic').then(value=>{if(active)setAutomaticBackup(value);}).catch(report);
      void api.get<typeof maintenance>('/api/storage/maintenance').then(value=>{if(active)setMaintenance(value);}).catch(report);
    };
    refresh();const timer=setInterval(refresh,5000);
    return()=>{active=false;clearInterval(timer);};
  },[showSettings,restoringBackup]);
  useEffect(() => {
    refreshEntries();
  }, [view.id, view.feedId, view.categoryId, view.tagId, view.smartFolderId, searchQuery]);
  useEffect(()=>{setBulkSelected(new Set());setBulkMode(false);},[view.id,view.feedId,view.categoryId,view.tagId,view.smartFolderId,query]);
  useEffect(()=>{const anchor=restoreAnchor.current;if(!anchor)return;restoreAnchor.current=null;const index=entries.findIndex(entry=>entry.id===anchor);if(index>=0)requestAnimationFrame(()=>listRef.current?.scrollToIndex({index,align:'start',behavior:'auto'}));},[entries]);
  useEffect(() => {
    localStorage.setItem('rivu-reading-preferences', JSON.stringify(reading));
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updateTheme = () => { const theme=reading.theme === 'system' ? media.matches ? 'dark' : 'light' : reading.theme;document.documentElement.dataset.theme=theme;if(window.rivu.setWindowTheme){document.documentElement.dataset.windowChrome='integrated';void window.rivu.setWindowTheme(theme).catch(()=>{});} };
    document.documentElement.dataset.uiFontSize=reading.uiFontSize;
    updateTheme();
    media.addEventListener('change', updateTheme);
    return () => media.removeEventListener('change', updateTheme);
  }, [reading]);
  const loadReading=async()=>{
    if(readingOperation.current)return;
    readingOperation.current=true;const version=++readingGeneration.current;setReadingBusy(true);setReadingLoaded(false);setReadingError('');setReadingNotice('');
    try{
      const result=await api.get<{preferences:ReadingPreferences;configured:boolean;densityConfigured:boolean}>('/api/reading/settings');
      if(version!==readingGeneration.current)return;
      setReading(current=>({...result.preferences,density:result.densityConfigured?result.preferences.density:current.density}));
      setReadingLoaded(true);
    }catch(cause){if(version===readingGeneration.current)setReadingError(`阅读偏好读取失败，请重新加载：${String(cause)}`);}
    finally{if(version===readingGeneration.current){readingOperation.current=false;setReadingBusy(false);}}
  };
  useEffect(()=>{void loadReading();return()=>{readingGeneration.current++;readingOperation.current=false;};},[]);
  const saveReading=async(patch:Partial<ReadingPreferences>)=>{
    if(!readingLoaded||readingOperation.current)return;
    readingOperation.current=true;const version=readingGeneration.current;setReadingBusy(true);setReadingError('');setReadingNotice('');
    try{
      const result=await api.patch<{preferences:ReadingPreferences;densityConfigured:boolean}>('/api/reading/settings',patch);
      if(version===readingGeneration.current){setReading(current=>({...result.preferences,density:result.densityConfigured?result.preferences.density:current.density}));setReadingNotice('阅读偏好已保存。');}
    }catch(cause){if(version===readingGeneration.current){setReadingLoaded(false);setReadingError(`保存结果未确认，请重新加载阅读偏好：${String(cause)}`);}}
    finally{if(version===readingGeneration.current){readingOperation.current=false;setReadingBusy(false);}}
  };
  const updateReading = <K extends keyof ReadingPreferences>(key: K, value: ReadingPreferences[K]) => {void saveReading({[key]:value});};
  const readingFeedback=()=> <div className="reading-settings-feedback">
    {readingBusy&&<p role="status">{readingLoaded?'正在保存阅读偏好…':'正在读取阅读偏好…'}</p>}
    {!readingLoaded&&<p className="muted">阅读偏好尚未加载，当前显示临时外观。</p>}
    {!readingLoaded&&!readingBusy&&<button className="secondary" onClick={()=>void loadReading()}>重新加载阅读偏好</button>}
    {readingError&&<p className="dialog-error" role="alert">{readingError}</p>}{readingNotice&&<p role="status">{readingNotice}</p>}
  </div>;
  const clearSelected=useCallback(()=>{selectedVersion.current++;setSelected(null);setSelectedLoading(false);},[]);
  const selectFeed=useCallback((id:string,title:string)=>{clearQuery();setView({id:'feed',label:title,feedId:id});clearSelected();},[clearQuery,clearSelected]);
  const selectEntry = async (entry: Entry) => {
    const version=++selectedVersion.current,needsDetail=!Object.hasOwn(entry,'full_content');
    setSelected(entry);setSelectedLoading(needsDetail);
    if(!entry.read&&!automaticReadInFlight.current.has(entry.id)&&!entryStateInFlight.current.has(entry.id)){
      const pending=api.patch(`/api/entries/${entry.id}`, {read:true}).then(()=>{
        setEntries(rows=>rows.map(row=>row.id===entry.id?{...row,read:1}:row));
        setSelected(current=>current?.id===entry.id?{...current,read:1}:current);
        void refreshMeta().catch(()=>setError('订阅统计暂时无法更新，请稍后重试。'));
        if(view.smartFolderId)void refreshEntries(true);
      }).catch(cause=>setError(String(cause))).finally(()=>automaticReadInFlight.current.delete(entry.id));
      automaticReadInFlight.current.set(entry.id,pending);
    }
    try{
      const detail=needsDetail?await api.get<Entry>(`/api/entries/${entry.id}`):entry;
      if(version===selectedVersion.current)setSelected(current=>current?.id===entry.id?{...detail,read:current.read,starred:current.starred,saved:current.saved}:current);
    }catch(cause){if(version===selectedVersion.current)setError(String(cause));}
    finally{if(version===selectedVersion.current)setSelectedLoading(false);}
  };
  const updateEntry = async (patch: Partial<Entry>) => {
    if (!selected) return;
    const selectedId=selected.id;
    if(entryStateInFlight.current.has(selectedId))return;
    entryStateInFlight.current.add(selectedId);
    setUpdatingEntryStates(new Set(entryStateInFlight.current));
    try {
      // A manual state change must commit after any automatic read already started.
      await automaticReadInFlight.current.get(selectedId);
      const next = await api.patch<Entry>(`/api/entries/${selectedId}`, patch);
      setSelected(current=>current?.id===selectedId?{...current,read:next.read,starred:next.starred,saved:next.saved}:current);
      setEntries((rows) => rows.map((x) => (x.id === next.id ? {...x,read:next.read,starred:next.starred,saved:next.saved} : x)));
      try{await refreshMeta();}catch{setError('阅读状态已保存，但订阅统计暂时无法更新，请稍后重试。');}
      if(view.smartFolderId)void refreshEntries(true);
    } catch (e) {
      setError(String(e));
    } finally {
      entryStateInFlight.current.delete(selectedId);
      setUpdatingEntryStates(new Set(entryStateInFlight.current));
    }
  };
  const jumpToChatSource=async(source:{entryId:string;excerpt:string})=>{
    try{const entry=await api.get<Entry>(`/api/entries/${source.entryId}`);await selectEntry(entry);const locate=(attempt:number)=>{const root=document.querySelector('.article-body');const normalize=(value:string|null)=>value?.replace(/\s+/g,' ').trim()||'';const needle=normalize(source.excerpt).slice(0,25);const matches=root&&[...root.querySelectorAll('*')].filter(node=>normalize(node.textContent).includes(needle));const target=matches?.sort((a,b)=>normalize(a.textContent).length-normalize(b.textContent).length)[0]||(root&&normalize(root.textContent).includes(needle)?root:null);if(target){target.scrollIntoView({block:'center'});setChatScopeIds(null);}else if(attempt<10)setTimeout(()=>locate(attempt+1),100);else setError('未能在当前文章中定位该引用段落。');};setTimeout(()=>locate(0),100);}catch(cause){setError(String(cause));}
  };
  const createCategory = async () => {
    if (!categoryName.trim()) return;
    try {
      await api.post("/api/categories", { name: categoryName });
      setCategoryName("");
      await refreshMeta();
    } catch (e) {
      setError(String(e));
    }
  };
  const markRead=async(scope:{view?:string;feedId?:string;categoryId?:string;tagId?:string;smartFolderId?:string;ids?:string[]},label:string)=>{
    if(bulkReadInFlight.current)return;
    if(!confirm(`将${label}中的未读文章标为已读？可在 10 分钟内撤销。`))return;
    bulkReadInFlight.current=true;setBulkReadBusy(true);
    let resultReceived=false;
    try{const result=await api.post<{changed:number;undoToken:string|null}>('/api/entries/mark-read',scope);resultReceived=true;if(result.undoToken)setUndoRead({token:result.undoToken,count:result.changed});else setUndoRead(null);setBulkSelected(new Set());await refreshEntries(true);await refreshMeta();}
    catch(cause){if(!resultReceived)setUndoRead(null);setError(String(cause));}
    finally{bulkReadInFlight.current=false;setBulkReadBusy(false);}
  };
  const markCurrentView=()=>{if(query.trim())return;if(view.smartFolderId)return markRead({smartFolderId:view.smartFolderId},view.label);if(view.feedId)return markRead({feedId:view.feedId},view.label);if(view.categoryId)return markRead({categoryId:view.categoryId},view.label);if(view.tagId)return markRead({tagId:view.tagId},view.label);return markRead({view:view.id},view.label);};
  const undoMarkRead=async()=>{if(!undoRead||bulkReadInFlight.current)return;bulkReadInFlight.current=true;setBulkReadBusy(true);try{await api.post('/api/entries/mark-read/undo',{token:undoRead.token});setUndoRead(null);await refreshEntries(true);await refreshMeta();}catch(cause){setError(String(cause));setUndoRead(null);}finally{bulkReadInFlight.current=false;setBulkReadBusy(false);}};
  const changeSelectedFeeds=async(action:'category'|'interval'|'pause'|'delete',enabled?:boolean)=>{
    if(feedSettingsInFlight.current.size)return;
    const ids=[...selectedFeeds].filter(id=>feeds.some(feed=>feed.id===id));if(!ids.length)return;
    setBulkFeedBusy(true);
    try{
      let payload:Record<string,unknown>={ids,action};
      if(action==='category')payload.categoryId=bulkFeedCategory||null;
      if(action==='interval')payload.fetchInterval=bulkFeedInterval;
      if(action==='pause')payload.enabled=enabled;
      if(action==='delete'){
        const impact=await api.post<{feedsToDelete:number;entriesToDelete:number;archivesPreserved:number}>('/api/feeds/bulk-delete-preview',{ids});
        if(!confirm(`删除 ${impact.feedsToDelete} 个订阅及其中 ${impact.entriesToDelete} 篇文章？\n${impact.archivesPreserved} 篇永久归档会保留，可独立导出。\n建议先备份数据库。`))return;
        payload={...payload,expected:{entriesToDelete:impact.entriesToDelete,archivesPreserved:impact.archivesPreserved}};
      }
      await api.post('/api/feeds/bulk',payload);
      setSelectedFeeds(new Set());
      await refreshMeta();await refreshEntries(true);
    }catch(cause){setError(String(cause));}finally{setBulkFeedBusy(false);}
  };
  const changeFeedSettings=async(id:string,patch:{categoryId?:string|null;fetchInterval?:number})=>{
    if(feedSettingsInFlight.current.has(id)||bulkFeedBusy)return;
    feedSettingsInFlight.current.add(id);
    setUpdatingFeedSettings(new Set(feedSettingsInFlight.current));
    setFeedSettingNotices(previous=>({...previous,[id]:{text:'正在保存订阅设置…',error:false}}));
    try{
      const saved=await api.patch<{category_id:string|null;fetch_interval:number}>(`/api/feeds/${id}`,patch);
      // Reflect the committed fields even if the subsequent metadata refresh fails.
      setFeeds(previous=>previous.map(feed=>feed.id===id?{...feed,category_id:saved.category_id,fetch_interval:saved.fetch_interval}:feed));
      try{
        await refreshMeta();
        setFeedSettingNotices(previous=>({...previous,[id]:{text:'订阅设置已保存',error:false}}));
      }catch(cause){
        setFeedSettingNotices(previous=>({...previous,[id]:{text:`设置已保存，但订阅列表更新失败，请稍后重试：${String(cause)}`,error:true}}));
      }
    }catch(cause){
      setFeedSettingNotices(previous=>({...previous,[id]:{text:`订阅设置保存失败：${String(cause)}`,error:true}}));
    }finally{
      feedSettingsInFlight.current.delete(id);
      setUpdatingFeedSettings(new Set(feedSettingsInFlight.current));
    }
  };
  const currentIndex = selected
    ? entries.findIndex((e) => e.id === selected.id)
    : -1;
  const immersive=focusReading&&!!selected;
  useEffect(()=>{if(!selected)setFocusReading(false);},[selected]);
  const toggleImmersive=()=>{
    if(!immersive)setHeldListWidth(shellRef.current?.querySelector('.entry-panel')?.getBoundingClientRect().width||440);
    setFocusReading(value=>!value);
  };
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target=ev.target instanceof HTMLElement?ev.target:null;
      if(ev.key==='Escape'&&immersive&&!ev.defaultPrevented&&!ev.isComposing&&!target?.closest('.ai-chat-panel')&&!document.querySelector('[role="dialog"]')){ev.preventDefault();setFocusReading(false);return;}
      if (
        ev.defaultPrevented || ev.isComposing || ev.ctrlKey || ev.metaKey || ev.altKey ||
        target?.isContentEditable || target?.closest('.ai-chat-panel') ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(
          target?.tagName || '',
        ) ||
        showAdd || showSettings || showImport || showTags || showArchives || editingJsonFeed
      )
        return;
      if (ev.key.toLowerCase() === "j" && currentIndex < entries.length - 1)
        selectEntry(entries[currentIndex + 1]);
      if (ev.key.toLowerCase() === "k" && currentIndex > 0)
        selectEntry(entries[currentIndex - 1]);
      if (ev.key.toLowerCase() === "s" && selected)
        updateEntry({ starred: !selected.starred ? 1 : 0 });
      if (ev.key.toLowerCase() === "m" && selected)
        updateEntry({ read: !selected.read ? 1 : 0 });
      if (ev.key.toLowerCase() === "o" && selected?.url)
        void openExternalLink(selected.url,setError);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, entries, currentIndex, showAdd, showSettings, showImport, showTags, showArchives, editingJsonFeed,immersive]);
  const rendered = useMemo(() => entries, [entries]);
  const timelineTimeZone=new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const selectedRenderVersion=selectedVersion.current;
  return (
    <div ref={shellRef} className={`app-shell ${paneLayout.navigationCollapsed?'navigation-collapsed':''} ${paneLayout.listCompact?'list-compact':''} ${immersive?'is-immersive':''}`} style={{'--held-list-width':`${heldListWidth}px`} as CSSProperties}>
      <div className="window-titlebar" aria-hidden="true"/>
      <aside className="sidebar" aria-label="主导航" inert={immersive} aria-hidden={immersive||undefined}>
        <div className="brand">
          <img className="brand-mark" src={new URL('../assets/rivu.ico', import.meta.url).href} alt="" />
          <span className="brand-name">Rivu</span>
          <button className="icon-button sidebar-collapse-toggle" title={paneLayout.navigationCollapsed?'展开导航栏':'收起导航栏'} aria-label={paneLayout.navigationCollapsed?'展开导航栏':'收起导航栏'} aria-expanded={!paneLayout.navigationCollapsed} onClick={()=>setPaneLayout(value=>({...value,navigationCollapsed:!value.navigationCollapsed}))}>{paneLayout.navigationCollapsed?<PanelLeftOpen size={18}/>:<PanelLeftClose size={18}/>}</button>
        </div>
        <div className="nav-scroll">
          <div className="nav-group">阅读</div>
          {nav.slice(0, 6).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-label={label}
              title={label}
              className={`nav-item ${view.id === id && !view.feedId && !view.categoryId ? "active" : ""}`}
              onClick={() => {
                clearQuery();
                setView({ id, label });
                clearSelected();
              }}
            >
              <Icon size={17} />
              <span>{label}</span>
              {id === "unread" &&
                feeds.reduce((n, f) => n + f.unread_count, 0) > 0 && (
                  <small>{feeds.reduce((n, f) => n + f.unread_count, 0)}</small>
                )}
            </button>
          ))}
          <div className="nav-divider" aria-hidden="true" />
          {nav.slice(6).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-label={label}
              title={label}
              className={`nav-item ${view.id === id && !view.feedId && !view.categoryId ? "active" : ""}`}
              onClick={() => {
                clearQuery();
                setView({ id, label });
                clearSelected();
              }}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
          <button className="nav-item" aria-label="永久归档" title="永久归档" onClick={()=>setShowArchives(true)}><Archive size={17}/><span>永久归档</span></button>
          <div className="nav-group with-action">
            订阅{" "}
            <button title="添加订阅" onClick={() => setShowAdd(true)}>
              <Plus size={16} />
            </button>
          </div>
          <FeedNavigation feeds={feeds} activeId={view.feedId} onSelect={selectFeed}/>
          {categories.length>0&&<div className="nav-group">分类</div>}
          {categories.map((category) => (
            <button
              key={category.id}
              aria-label={category.name}
              title={category.name}
              className={`nav-item ${view.categoryId === category.id ? "active" : ""}`}
              onClick={() => {
                clearQuery();
                setView({
                  id: "category",
                  label: category.name,
                  categoryId: category.id,
                });
                clearSelected();
              }}
            >
              <Folder size={16} />
              <span>{category.name}</span>
            </button>
          ))}
          {tags.length>0&&<div className="nav-group">标签</div>}
          {tags.map(tag=><button key={tag.id} aria-label={tag.name} title={tag.name} className={`nav-item ${view.tagId===tag.id?'active':''}`} onClick={()=>{clearQuery();setView({id:'tag',label:tag.name,tagId:tag.id});clearSelected();}}><TagIcon size={16}/><span>{tag.name}</span></button>)}
          <div className="nav-group with-action">智能分类 <button title="管理智能分类" onClick={()=>{setSmartDraftQuery('');setShowSettings(true);requestAnimationFrame(()=>document.getElementById('smart-folders-settings')?.scrollIntoView());}}><Plus size={16}/></button></div>
          {smartFolders.map(folder=><button key={folder.id} aria-label={folder.name} className={`nav-item ${view.smartFolderId===folder.id?'active':''}`} title={`${folder.name} · ${folder.query}`} onClick={()=>{clearQuery();setView({id:'smart',label:folder.name,smartFolderId:folder.id});clearSelected();}}><Search size={16}/><span>{folder.name}</span></button>)}
        </div>
        <div className="sidebar-bottom">
          <button className="nav-item" aria-label="添加订阅" title="添加订阅" onClick={() => setShowAdd(true)}>
            <Plus size={18} />
            <span>添加订阅</span>
          </button>
          <button className="nav-item" aria-label="设置" title="设置" onClick={() => {setSmartDraftQuery('');setShowSettings(true);}}>
            <Settings size={18} />
            <span>设置</span>
          </button>
        </div>
      </aside>
      <main className={`entry-panel ${selected ? "has-selected" : ""}`} aria-label="文章列表" inert={immersive} aria-hidden={immersive||undefined}>
        <div className="panel-header">
          <div>
            <h1 title={query ? undefined : view.label}>{query ? "搜索结果" : view.label}</h1>
            <p>{loading ? "正在载入…" : `${entries.length} 篇文章`}{!systemOnline?' · 设备离线，可阅读已保存内容':''}</p>
          </div>
          <div className="panel-actions">
          <button className="icon-button list-collapse-toggle" title={paneLayout.listCompact?'展开文章列表':'收起文章列表'} aria-label={paneLayout.listCompact?'展开文章列表':'收起文章列表'} aria-expanded={!paneLayout.listCompact} onClick={()=>setPaneLayout(value=>({...value,listCompact:!value.listCompact}))}>{paneLayout.listCompact?<ChevronsRight size={18}/>:<ChevronsLeft size={18}/>}</button>
          <button className="secondary" onClick={()=>setBulkMode(value=>!value)}>{bulkMode?'完成选择':'批量操作'}</button>
          <button
            className="icon-button"
            title={view.feedId&&feeds.some(feed=>feed.id===view.feedId&&isRecoveredSource(feed))?'原订阅地址缺失，无法刷新':'刷新'}
            disabled={!!view.feedId&&feeds.some(feed=>feed.id===view.feedId&&isRecoveredSource(feed))}
            onClick={async () => {
              setRefreshNotice('');
              setLoading(true);
              try {
                if (view.feedId){
                  const result=await api.post<{added:number}>(`/api/feeds/${view.feedId}/refresh`);
                  setRefreshNotice(`刷新完成，新增 ${result.added} 篇文章`);
                }else{
                  const result=await api.post<{failed:number;total:number;results:{added?:number}[]}>("/api/feeds/refresh");
                  const added=result.results.reduce((sum,item)=>sum+(item.added||0),0);
                  setRefreshNotice(`刷新完成，新增 ${added} 篇文章${result.failed?`，${result.failed}/${result.total} 个订阅失败`:''}`);
                  if(result.failed)setError(`${result.total} 个订阅中有 ${result.failed} 个刷新失败；请在设置中查看原因。`);
                }
                await refreshEntries(true);
                await refreshMeta();
              } catch (e) {
                setError(String(e));
              } finally {
                setLoading(false);
              }
            }}
          >
            <RefreshCw size={18} />
          </button>
          </div>
        </div>
        {bulkMode&&<div className="bulk-toolbar"><span>已选 {bulkSelected.size} 篇</span><button className="secondary" disabled={bulkReadBusy||!bulkSelected.size} onClick={()=>markRead({ids:[...bulkSelected]},`所选 ${bulkSelected.size} 篇文章`)}>标记所选已读</button><button className="secondary" disabled={bulkReadBusy||!!query.trim()} title={query.trim()?'搜索时请先选中文章':''} onClick={markCurrentView}>当前视图全部已读</button><button className="secondary" disabled={!bulkSelected.size||bulkSelected.size>10} title={bulkSelected.size>10?'每次最多选择 10 篇':''} onClick={()=>setChatScopeIds([...bulkSelected])}>询问所选文章</button></div>}
        {refreshNotice&&<div className="refresh-notice" role="status">{refreshNotice}<button aria-label="关闭刷新结果" onClick={()=>setRefreshNotice('')}>×</button></div>}
        <div className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、正文、作者…"
            aria-label="搜索文章"
          />
          {query && (
            <>
              <button title="保存搜索为智能分类" onClick={()=>{setSmartDraftQuery(query);setShowSettings(true);requestAnimationFrame(()=>document.getElementById('smart-folders-settings')?.scrollIntoView());}}><Folder size={15}/></button>
              <button title="清除搜索" onClick={clearQuery}><X size={15} /></button>
            </>
          )}
        </div>
        {entries.length ? (
          <Virtuoso
            ref={listRef}
            className="entry-scroll"
            data={rendered}
            endReached={loadMore}
            rangeChanged={range=>{visibleAnchor.current=entries[range.startIndex]?.id??null;}}
            itemContent={(_i, entry) => (
              <EntryTimelineRow entry={entry} icon={feedIcons.get(entry.feed_id)?.icon} iconKey={feedIcons.get(entry.feed_id)?.iconKey} density={density} timeZone={timelineTimeZone} selected={selected?.id===entry.id} bulkMode={bulkMode} checked={bulkSelected.has(entry.id)} onClick={()=>{if(bulkMode)setBulkSelected(current=>{const next=new Set(current);if(next.has(entry.id))next.delete(entry.id);else next.add(entry.id);return next;});else void selectEntry(entry);}}/>
            )}
          />
        ) : (
          <div className="empty-state">
            <div className="empty-lines">
              <span />
              <span />
              <span />
            </div>
            <h2>{feeds.length ? "这里暂时没有文章" : "开始建立本地资料库"}</h2>
            <p>
              {feeds.length
                ? "试试其他分类，或刷新订阅。"
                : "添加 RSS 或网站，也可以导入已有的 OPML 订阅。"}
            </p>
            {!feeds.length && (
              <>
                <div className="first-run-actions">
                  <button className="primary" onClick={() => setShowAdd(true)}>添加订阅</button>
                  <button className="secondary" onClick={() => setShowImport(true)}>导入 OPML</button>
                </div>
                <p className="first-run-note">无需账户。文章和阅读状态保存在本机；需要迁移时可在设置中导出备份。</p>
              </>
            )}
          </div>
        )}
      </main>
      <section className={`reader-panel ${selected ? "open" : ""}`}>
        {selected ? (
          <>
            <div className="reader-toolbar">
              <button className="icon-button immersion-toggle" title={immersive?'退出沉浸阅读（Esc）':'沉浸阅读'} aria-label={immersive?'退出沉浸阅读':'沉浸阅读'} aria-pressed={immersive} onClick={toggleImmersive}>{immersive?<Minimize2 size={18}/>:<Maximize2 size={18}/>}<span>{immersive?'退出沉浸':'沉浸阅读'}</span></button>
              <button
                className="icon-button back-button"
                onClick={clearSelected}
                title="返回列表"
              >
                <ArrowLeft size={18} />
              </button>
              <span className="toolbar-spacer" />
              <button className="icon-button" title="向当前文章提问" onClick={()=>setChatScopeIds([selected.id])}><MessageCircle size={17}/></button>
              <span className="toolbar-divider" aria-hidden="true" />
              <button
                className={`icon-button ${selected.starred ? "is-starred" : ""}`}
                title={selected.starred ? "取消收藏" : "收藏"}
                disabled={updatingEntryStates.has(selected.id)}
                onClick={() =>
                  updateEntry({ starred: selected.starred ? 0 : 1 })
                }
              >
                <Star
                  size={17}
                  fill={selected.starred ? "currentColor" : "none"}
                />
              </button>
              <button
                className="icon-button"
                title={selected.read ? "标为未读" : "标为已读"}
                disabled={updatingEntryStates.has(selected.id)}
                onClick={() => updateEntry({ read: selected.read ? 0 : 1 })}
              >
                <Check size={17} />
              </button>
              <button
                className={`icon-button ${selected.saved || selected.rule_saved ? "is-saved" : ""}`}
                title={selected.rule_saved?(selected.saved?"移除手动保存；规则仍会保留稍后阅读":"同时手动加入稍后阅读，撤销规则后仍保留"):"稍后阅读"}
                disabled={updatingEntryStates.has(selected.id)}
                onClick={() => updateEntry({ saved: selected.saved ? 0 : 1 })}
              >
                <BookOpen
                  size={17}
                  fill={selected.saved||selected.rule_saved ? "currentColor" : "none"}
                />
              </button>
              <button className="icon-button" title="标签" onClick={()=>setShowTags(true)}><TagIcon size={17}/></button>
              <span className="toolbar-divider" aria-hidden="true" />
              <button
                className="icon-button"
                title="在浏览器打开"
                onClick={() =>
                  selected.url && void openExternalLink(selected.url,setError)
                }
              >
                <ExternalLink size={17} />
              </button>
            </div>
            <Reader onOpenError={setError} onTagsChanged={async()=>{await refreshMeta();await refreshEntries(true);}} entry={selected} loading={selectedLoading} reading={reading} mediaExpanded={['images','audio','video'].includes(view.id)} onUpdated={(next,savedByOffline) => {setSelected(current=>selectedRenderVersion===selectedVersion.current&&current?.id===next.id?{...current,...next,read:current.read,starred:current.starred,saved:savedByOffline?next.saved:current.saved}:current);if(savedByOffline)setEntries(rows=>rows.map(row=>row.id===next.id?{...row,saved:next.saved}:row));}} />
          </>
        ) : (
          <div className="reader-placeholder">
            <div className="empty-lines">
              <span />
              <span />
              <span />
            </div>
            <p>选择一篇文章开始阅读</p>
          </div>
        )}
      </section>
      {chatScopeIds&&<AIChatPanel key={chatScopeIds.join(',')} onConfigure={()=>{setSettingsTarget('ai');setShowSettings(true);}} scopeIds={chatScopeIds} onClose={()=>setChatScopeIds(null)} onNavigate={jumpToChatSource}/>}
      {error && (
        <div className="toast" role="alert">
          {error}
          <button onClick={() => setError("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {bulkReadBusy?<div className="undo-toast" role="status">正在更新阅读状态…</div>:undoRead&&<div className="undo-toast" role="status">已标记 {undoRead.count} 篇为已读 <button onClick={undoMarkRead}>撤销</button><button title="关闭" onClick={()=>setUndoRead(null)}>×</button></div>}
      {showAdd && <AddFeedDialog categories={categories} onClose={() => setShowAdd(false)} onSubscribed={async () => { await refreshMeta(); await refreshEntries(); }} />}
      {editingJsonFeed && <AddFeedDialog categories={categories} editingFeed={editingJsonFeed} onClose={() => setEditingJsonFeed(null)} onSubscribed={async () => { await refreshMeta(); await refreshEntries(); }} />}
      {showImport&&<OpmlImportDialog categories={categories} onClose={()=>setShowImport(false)} onImported={async()=>{await refreshMeta();await refreshEntries();}}/>}
      {showTags && selected && <TagPicker entryId={selected.id} onClose={()=>setShowTags(false)} onChanged={refreshMeta}/>}
      {showSettings && (
        <div
          className="overlay"
          onMouseDown={(e) =>
            e.target === e.currentTarget && closeSettings()
          }
        >
          <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="dialog-heading">
              <h2 id="settings-title">设置</h2>
              <button
                className="icon-button"
                aria-label="关闭设置"
                onClick={closeSettings}
              >
                <X size={18} />
              </button>
            </div>
            <div className="settings-layout">
            <SettingsNavigation initialGroup={settingsTarget} />
            <div className="settings-scroll">
              <section id="settings-general" tabIndex={-1}>
                <h3>常规</h3>
                <p className="muted">订阅、文章与阅读状态保存在本机。刷新频率可在“订阅”中逐项设置；迁移资料可使用“备份”。</p>
                <p className="muted">AI 为可选阅读工具，发送前可检查内容范围。</p>
              </section>
              <section id="settings-appearance" tabIndex={-1}>
                <h3>外观</h3>
                {readingFeedback()}
                <label>主题<select disabled={!readingLoaded||readingBusy} value={reading.theme} onChange={e=>updateReading('theme',e.target.value as ReadingPreferences['theme'])}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
                <p className="muted">强调色：天空蓝</p>
                <label>
                  列表密度{" "}
                  <select
                    disabled={!readingLoaded||readingBusy} value={density}
                    onChange={(e) =>
                      updateReading('density',e.target.value as ReadingPreferences['density'])
                    }
                  >
                    <option value="comfortable">舒适</option>
                    <option value="standard">标准</option>
                    <option value="compact">紧凑</option>
                  </select>
                </label>
                <label>界面字号<select disabled={!readingLoaded||readingBusy} value={reading.uiFontSize} onChange={e=>updateReading('uiFontSize',e.target.value as ReadingPreferences['uiFontSize'])}><option value="small">小</option><option value="standard">标准</option><option value="large">大</option></select></label>
              </section>
              <section id="settings-reading" tabIndex={-1}>
                <h3>阅读</h3>
                {readingFeedback()}
                <div className="reading-settings">
                  <label>正文字体<select disabled={!readingLoaded||readingBusy} value={reading.font} onChange={e=>updateReading('font',e.target.value as ReadingPreferences['font'])}><option value="sans">无衬线</option><option value="serif">衬线</option></select></label>
                  <label>字号<select disabled={!readingLoaded||readingBusy} value={reading.fontSize} onChange={e=>updateReading('fontSize',Number(e.target.value) as ReadingPreferences['fontSize'])}>{[14,16,18,20].map(size=><option key={size} value={size}>{size} px</option>)}</select></label>
                  <label>行距<select disabled={!readingLoaded||readingBusy} value={reading.lineHeight} onChange={e=>updateReading('lineHeight',Number(e.target.value) as ReadingPreferences['lineHeight'])}>{[1.6,1.8,2].map(height=><option key={height} value={height}>{height}</option>)}</select></label>
                  <label>文章宽度<select disabled={!readingLoaded||readingBusy} value={reading.width} onChange={e=>updateReading('width',Number(e.target.value) as ReadingPreferences['width'])}>{[680,760,840].map(width=><option key={width} value={width}>{width} px</option>)}</select></label>
                  <label>图片宽度<select disabled={!readingLoaded||readingBusy} value={reading.imageWidth} onChange={e=>updateReading('imageWidth',e.target.value as ReadingPreferences['imageWidth'])}><option value="column">正文内</option><option value="wide">尽量放宽</option></select></label>
                  <label>正文链接<select disabled={!readingLoaded||readingBusy} value={reading.linkTarget} onChange={e=>updateReading('linkTarget',e.target.value as ReadingPreferences['linkTarget'])}><option value="external">直接在浏览器打开</option><option value="ask">打开前确认</option></select></label>
                  <button className="secondary" disabled={!readingLoaded||readingBusy} onClick={()=>void saveReading({...defaultReadingPreferences})}>恢复阅读默认值</button>
                </div>
              </section>
              <section>
                <h3 id="settings-feeds" tabIndex={-1}>订阅与分类</h3>
                <div className="input-row">
                  <input
                    value={categoryName}
                    onChange={(e) => setCategoryName(e.target.value)}
                    placeholder="新分类名称"
                  />
                  <button className="secondary" onClick={createCategory}>
                    创建
                  </button>
                </div>
              </section>
              <section>
                <h3>订阅管理</h3>
                {feeds.length>0&&<div className="feed-bulk-toolbar">
                  <label><input type="checkbox" aria-label="选择全部订阅" checked={feeds.every(feed=>selectedFeeds.has(feed.id))} onChange={event=>setSelectedFeeds(event.target.checked?new Set(feeds.map(feed=>feed.id)):new Set())}/>全选 · 已选 {selectedFeeds.size}</label>
                  <div className="feed-bulk-controls">
                    <select aria-label="批量目标分类" value={bulkFeedCategory} onChange={event=>setBulkFeedCategory(event.target.value)}><option value="">未分类</option>{categories.map(category=><option key={category.id} value={category.id}>{category.name}</option>)}</select>
                    <button className="secondary" disabled={!selectedFeeds.size||bulkFeedBusy||updatingFeedSettings.size>0} onClick={()=>void changeSelectedFeeds('category')}>移动分类</button>
                    <select aria-label="批量刷新频率" value={bulkFeedInterval} onChange={event=>setBulkFeedInterval(Number(event.target.value))}>{[0,15,30,60,180,360,720].map(minutes=><option key={minutes} value={minutes}>{minutes?`${minutes} 分钟`:'手动'}</option>)}</select>
                    <button className="secondary" disabled={!selectedFeeds.size||bulkFeedBusy||updatingFeedSettings.size>0} onClick={()=>void changeSelectedFeeds('interval')}>修改频率</button>
                    <button className="secondary" disabled={!selectedFeeds.size||bulkFeedBusy||updatingFeedSettings.size>0} onClick={()=>void changeSelectedFeeds('pause',false)}>暂停</button>
                    <button className="secondary" disabled={!selectedFeeds.size||bulkFeedBusy||updatingFeedSettings.size>0} onClick={()=>void changeSelectedFeeds('pause',true)}>启用</button>
                    <button className="secondary danger" disabled={!selectedFeeds.size||bulkFeedBusy||updatingFeedSettings.size>0} onClick={()=>void changeSelectedFeeds('delete')}>删除所选</button>
                  </div>
                </div>}
                <FeedSettingsList feeds={feeds}>{feed => (
                  <div className="feed-setting" key={feed.id}>
                    <input type="checkbox" aria-label={`选择订阅 ${feed.title}`} checked={selectedFeeds.has(feed.id)} onChange={event=>setSelectedFeeds(previous=>{const next=new Set(previous);if(event.target.checked)next.add(feed.id);else next.delete(feed.id);return next;})}/>
                    <div>
                      <strong>{feed.title}</strong>
                      {feedSettingNotices[feed.id]&&<small className="feed-setting-notice" role={feedSettingNotices[feed.id].error?'alert':'status'}>{feedSettingNotices[feed.id].text}</small>}
                      {['rss','rsshub'].includes(feed.type)&&!isRecoveredSource(feed)&&<>
                        <button className="secondary" disabled={updatingFeedIcon!==null} onClick={async()=>{
                          setUpdatingFeedIcon(feed.id);setIconNotice(null);
                          try{await api.post(`/api/feeds/${feed.id}/icon`);await refreshMeta();setIconNotice({id:feed.id,text:'图标已保存到本地'});}
                          catch(cause){setIconNotice({id:feed.id,text:String(cause)});}
                          finally{setUpdatingFeedIcon(null);}
                        }}>{updatingFeedIcon===feed.id?'更新图标中…':'更新图标'}</button>
                        {iconNotice?.id===feed.id&&<small role="status">{iconNotice.text}</small>}
                      </>}
                      <small className={`feed-health ${feed.health}`}>
                        {feed.health === "error" ? "异常" : feed.health === "retrying" ? "重试中" : feed.health === "paused" ? "已暂停" : "正常"}
                        {feed.last_fetched_at ? ` · 上次尝试 ${formatDate(feed.last_fetched_at)}` : " · 尚未尝试"}
                        {` · 未读 ${feed.unread_count}`}
                      </small>
                      <small>{feed.last_success_at?`最近成功 ${formatDate(feed.last_success_at)}`:'尚无成功更新记录'}</small>
                      {feed.next_fetch_at&&feed.enabled!==0&&<small>下次尝试 {formatDate(feed.next_fetch_at)} · 连续失败 {feed.failure_count} 次</small>}
                      <small>
                        {feed.last_error
                          ? `${feed.health==='healthy'?'更新提示':'更新失败'}：${feed.last_error}`
                          : feed.url}
                      </small>
                      {feed.type==='custom_json'&&<button className="secondary" onClick={()=>setEditingJsonFeed(feed)}>编辑 JSON 字段映射</button>}
                      {feed.type==='newsletter'&&<button className="secondary" onClick={async()=>{try{const rebound=await window.rivu.reconnectNewsletter(feed.id);if(!rebound)return;await api.post(`/api/feeds/${feed.id}/refresh`).catch(()=>{});await refreshMeta();await refreshEntries();}catch(cause){setError(String(cause));}}}>重新选择邮件文件夹</button>}
                      {feed.type==='newsletter'&&!feed.folder_authorized&&<small>恢复备份后需重新选择邮件文件夹</small>}
                      {feed.type!=='newsletter'&&<label className="feed-local-option" title="只对可信的本机或内网订阅开启；允许该订阅访问其原始地址所在的内网来源">
                        <input type="checkbox" checked={!!feed.allow_private} disabled={updatingFeedTrust===feed.id} onChange={async (e) => {
                          const allowPrivate=e.target.checked;
                          setUpdatingFeedTrust(feed.id);
                          setFeeds(previous=>previous.map(item=>item.id===feed.id?{...item,allow_private:Number(allowPrivate)}:item));
                          try { await api.patch(`/api/feeds/${feed.id}`, {allowPrivate}); }
                          catch (cause) { setError(String(cause)); }
                          finally { try { await refreshMeta(); } catch (cause) { setError(String(cause)); } setUpdatingFeedTrust(null); }
                        }} />
                        允许此订阅访问本机或内网地址
                      </label>}
                    </div>
                    <select
                      aria-label={`订阅分类 ${feed.title}`}
                      disabled={updatingFeedSettings.has(feed.id)||bulkFeedBusy}
                      value={feed.category_id || ""}
                      onChange={e=>void changeFeedSettings(feed.id,{categoryId:e.target.value||null})}
                    >
                      <option value="">未分类</option>
                      {categories.map((c) => (
                        <option value={c.id} key={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`刷新频率 ${feed.title}`}
                      disabled={updatingFeedSettings.has(feed.id)||bulkFeedBusy}
                      value={feed.fetch_interval}
                      onChange={e=>void changeFeedSettings(feed.id,{fetchInterval:Number(e.target.value)})}
                    >
                      {[0, 15, 30, 60, 180, 360, 720].map((n) => (
                        <option key={n} value={n}>
                          {n ? `${n} 分钟` : "手动"}
                        </option>
                      ))}
                    </select>
                    <button className="icon-button" title={isRecoveredSource(feed)&&!feed.enabled?'来源地址缺失，请重新添加原订阅':feed.enabled ? "暂停订阅" : "启用订阅"} disabled={isRecoveredSource(feed)&&!feed.enabled} onClick={async () => { try { await api.patch(`/api/feeds/${feed.id}`, {enabled: !feed.enabled}); await refreshMeta(); } catch(e) { setError(String(e)); } }}>
                      {feed.enabled ? <PauseCircle size={16}/> : <PlayCircle size={16}/>}
                    </button>
                    <button
                      className="icon-button"
                      title="立即重试"
                      disabled={isRecoveredSource(feed)}
                      onClick={async () => {
                        try {
                          await api.post(`/api/feeds/${feed.id}/refresh`);
                          await refreshMeta();
                          await refreshEntries();
                        } catch (e) {
                          setError(String(e));
                        }
                      }}
                    >
                      <RefreshCw size={16} />
                    </button>
                    <button
                      className="icon-button danger"
                      title="删除订阅"
                      onClick={async () => {
                        try {
                          const impact=await api.get<{entriesToDelete:number;archivesPreserved:number}>(`/api/feeds/${feed.id}/delete-preview`);
                          if (!confirm(`删除订阅《${feed.title}》及其中 ${impact.entriesToDelete} 篇文章？\n${impact.archivesPreserved} 篇永久归档会保留，可在“永久归档”中独立导出。\n建议先备份数据库。`))return;
                          await api.post('/api/feeds/bulk',{ids:[feed.id],action:'delete',expected:{entriesToDelete:impact.entriesToDelete,archivesPreserved:impact.archivesPreserved}});
                          await refreshMeta();await refreshEntries();
                        } catch(e) {setError(String(e));}
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                )}</FeedSettingsList>
              </section>
              <RulesSettings feeds={feeds} tags={tags} onChanged={async()=>{const selectedId=selected?.id,version=selectedVersion.current;await refreshMeta();await refreshEntries(true);if(selectedId){const next=await api.get<Entry>(`/api/entries/${selectedId}`);setSelected(current=>version===selectedVersion.current&&current?.id===selectedId?next:current);}}} />
              <SmartFoldersSettings folders={smartFolders} initialQuery={smartDraftQuery} onChanged={async(next)=>{setSmartFolders(next);if(view.smartFolderId){const current=next.find(folder=>folder.id===view.smartFolderId);if(!current){setView({id:'unread',label:'收件箱'});clearSelected();}else{setView(old=>({...old,label:current.name}));await refreshEntries(true);}}}} />
              <RsshubSettings />
              <div id="settings-ai" tabIndex={-1}>
              <AISettings />
              <AIRulesSettings feeds={feeds} tags={tags} />
              </div>
              <section id="settings-data" tabIndex={-1}>
                <h3>数据</h3>
                <ImageCacheSettings />
                <p className="muted">当前数据库约 {storageStats?(storageStats.estimatedBackupBytes/1024/1024).toFixed(1):'…'} MiB。永久归档可从侧栏独立管理和导出。</p>
                <div className="setting-actions">
                  <button className="secondary" onClick={()=>{setShowSettings(false);setShowImport(true);}}>导入 OPML</button>
                  <button className="secondary" onClick={async()=>{try{await window.rivu.saveFile('opml');}catch(e){setError(String(e));}}}>导出 OPML</button>
                </div>
              </section>
              <section>
                <h3 id="settings-backup" tabIndex={-1}>备份</h3>
                <label className="backup-secrets-option">
                  <input type="checkbox" checked={backupSecrets} onChange={(event) => setBackupSecrets(event.target.checked)} />
                  <span>在备份中包含 AI 密钥</span>
                </label>
                <p className="muted">默认备份订阅、文章和设置，但不包含 AI 密钥与图片缓存。包含密钥的备份请妥善保存。</p>
                <p className="muted">OPML 只包含网络订阅；本地 Newsletter 文章随 ZIP 备份保留。恢复后需重新选择邮件文件夹，才会继续扫描新邮件。</p>
                <p className="muted">当前数据库约 {storageStats?(storageStats.estimatedBackupBytes/1024/1024).toFixed(1):'…'} MiB（导出 ZIP 体积会因压缩而变化）。{storageStats?.lastRestore&&`上次恢复：${formatFullDate(storageStats.lastRestore.completedAt)}，耗时 ${(storageStats.lastRestore.durationMs/1000).toFixed(1)} 秒，备份文件 ${(storageStats.lastRestore.backupBytes/1024/1024).toFixed(1)} MiB。`}</p>
                <label>自动备份<select value={automaticBackup?.frequency||'off'} onChange={async event=>{try{const next=await api.patch<NonNullable<typeof automaticBackup>>('/api/backups/automatic',{frequency:event.target.value});setAutomaticBackup(next);}catch(e){setError(String(e));}}}><option value="off">关闭</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
                <p className="muted">自动备份默认不含 AI 密钥，保留最近 {automaticBackup?.keep||7} 份。{automaticBackup?.running?'正在备份。 ':''}{automaticBackup?.lastSuccessAt?`最近成功：${formatFullDate(automaticBackup.lastSuccessAt)}。`:''}{automaticBackup?.nextDueAt?`预计下次：${formatFullDate(automaticBackup.nextDueAt)}。`:''}当前有 {automaticBackup?.backups.length||0} 份自动备份。</p>
                {automaticBackup?.lastError&&<p className="article-error" role="alert">自动备份失败：{automaticBackup.lastError}</p>}
                {backupMessage&&<p className="muted" role="status">{backupMessage}</p>}
                <div className="setting-actions">
                  <button className="secondary" onClick={async()=>{try{await window.rivu.openBackupDirectory();}catch(e){setError(String(e));}}}>打开自动备份目录</button>
                  <button
                    className="secondary"
                    onClick={async () => {
                      try {
                        const result=await window.rivu.saveFile("backup", {includeSecrets:backupSecrets}) as {path:string;bytes:number}|null;
                        if(result)setBackupMessage(`备份已保存：${result.path}（${(result.bytes/1024/1024).toFixed(1)} MiB）`);
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    <Archive size={16} />
                    备份数据库
                  </button>
                  <button
                    className="secondary"
                    disabled={restoringBackup}
                    onClick={async () => {
                      setRestoringBackup(true);
                      try {
                        await window.rivu.chooseFile("backup");
                      } catch (e) {
                        setError(String(e));
                      } finally {
                        setRestoringBackup(false);
                      }
                    }}
                  >
                    <Upload size={16} />
                    {restoringBackup ? "正在检查或恢复…" : "恢复备份"}
                  </button>
                  {restoringBackup && <p role="status">正在检查或恢复备份，完成恢复后将自动重启。</p>}
                </div>
              </section>
              <div id="settings-advanced" tabIndex={-1}><ProxySettings /><section><h3>数据库维护</h3>                <p className="muted">数据库优化会先生成本地保护备份，再清理失效图片缓存记录、重建全文索引并整理数据库。保护备份保留最近 3 份；大库可能需要较长时间，完成前请保持应用打开。</p>
                <button className="secondary" disabled={maintenance?.running} onClick={async()=>{try{setMaintenance(await api.post<NonNullable<typeof maintenance>>('/api/storage/maintenance',{}));}catch(e){setError(String(e));}}}>{maintenance?.running?'正在优化数据库…':'优化数据库'}</button>
                {maintenance?.running&&<p className="muted" role="status">当前步骤：{{draining:'等待当前任务完成',backup:'创建保护备份',cache:'清理失效缓存',fts:'重建全文索引',vacuum:'整理数据库',integrity:'检查数据库完整性'}[maintenance.phase||'draining']}{maintenance.phase==='backup'&&maintenance.snapshotPercent!==null?`（快照复制 ${maintenance.snapshotPercent}%${maintenance.snapshotPercent===100?'，正在写入备份包':''}）`:''}。</p>}
                {maintenance?.lastError&&<p className="article-error" role="alert">数据库优化失败：{maintenance.lastError}。如已生成保护备份，它会保留在自动备份目录。</p>}
                {maintenance?.lastResult&&<p className="muted" role="status">上次优化：{formatFullDate(maintenance.lastResult.completedAt)}，清理 {maintenance.lastResult.removedCacheRows} 条失效缓存记录，数据库从 {(maintenance.lastResult.beforeBytes/1024/1024).toFixed(1)} MiB 变为 {(maintenance.lastResult.afterBytes/1024/1024).toFixed(1)} MiB，耗时 {(maintenance.lastResult.durationMs/1000).toFixed(1)} 秒。保护备份：{maintenance.lastResult.backupPath}</p>}
</section></div>
              <section className="about-settings" id="settings-about" tabIndex={-1}>
                <AboutSettings />
              </section>
            </div>
            </div>
          </div>
        </div>
      )}
      {showArchives&&<ArchiveManager onClose={()=>setShowArchives(false)}/>}
    </div>
  );
}
function Reader({ entry,loading,onUpdated,reading,mediaExpanded,onTagsChanged,onOpenError }: { entry: Entry;loading:boolean;onUpdated:(entry:Entry,savedByOffline?:boolean)=>void;reading:ReadingPreferences;mediaExpanded:boolean;onTagsChanged:()=>Promise<void>;onOpenError:(message:string)=>void }) {
  const scrollRef=useRef<HTMLElement>(null);
  const [translatedArticleId,setTranslatedArticleId]=useState<string|null>(null);
  const positionSource=entry.full_content||entry.content||entry.description||'';
  useEffect(()=>{
    if(loading)return;
    const element=scrollRef.current;if(!element)return;
    return trackReadingPosition(element,entry.id,positionSource,{
      read:()=>api.get(`/api/entries/${entry.id}/reading-position`),
      write:position=>api.put(`/api/entries/${entry.id}/reading-position`,position),
    });
  },[entry.id,loading,positionSource]);
  return (
    <article ref={scrollRef} className={`reader-content reader-font-${reading.font} reader-images-${reading.imageWidth}`} style={{maxWidth:reading.width+104,'--reading-size':`${reading.fontSize}px`,'--reading-line-height':reading.lineHeight} as CSSProperties}>
      <div className="reader-kicker">{entry.feed_title}</div>
      <h1>{entry.title}</h1>
      <div className="reader-meta">
        {entry.author && <span>{entry.author} · </span>}
        {entry.feed_title} ·{" "}
        {formatDate(entry.published_at || entry.fetched_at)}
      </div>
      {loading?<p className="muted" role="status">正在读取本地文章…</p>:<><AIBlock onTagsChanged={onTagsChanged} key={entry.id} entry={entry} onTranslationVisible={setTranslatedArticleId}/><EntryMedia key={entry.id} entry={entry} expanded={mediaExpanded} /><div className="reader-original-body" hidden={translatedArticleId===entry.id}><RichArticle entry={entry} onUpdated={onUpdated} linkTarget={reading.linkTarget}/></div></>}
      {entry.url && (
        <button
          className="original-link"
          onClick={() => void openExternalLink(entry.url,onOpenError)}
        >
          阅读原文 ↗
        </button>
      )}
    </article>
  );
}
