/**
 * The one inline script in index.html. It runs before the first paint, so the
 * prerendered boot shell (docs/frontend/boot-shell.md) shows in the right
 * mode and theme, or not at all. Inline rather than /app-theme-bootstrap.js:
 * an external script in <head> holds the first paint for a round trip.
 *
 * Every Web host's CSP allows exactly this script by its hash
 * (bootInlineScriptCspSource); tests/bootShell.test.ts fails when the script
 * and a host disagree.
 */

import { COLUMN_BOUNDS } from "../lib/panelBounds";
import { BOOT_FETCHES_GLOBAL } from "./bootPrefetch";
import { LOCALE_CATALOGS_ELEMENT_ID } from "../i18n/messages/catalogParts";

/** serverTheme.ts's SERVER_THEME_STORAGE_PREFIX; kept literal so the Vite config can load this file (tests compare them). */
export const BOOT_SERVER_THEME_STORAGE_PREFIX = "raft:server-theme:v1:";

/**
 * After the theme bootstrap. The shell is a signed-in server's frame: without
 * a stored session, off a server page, or in a host-shell embed (the App's
 * WebView: BOOT_HOST_SHELL_EMBED), it stays hidden (`boot-off`). A
 * canonical Artifact link (`/artifacts/<id>`, `/v/<n>`), signed in or not,
 * shows its own frame instead, "Loading Artifact" in the reader's language
 * (`boot-artifact`, `data-boot-locale`), without the page's header row in a
 * host-shell embed (`boot-embedded`: the App draws its own, or a row of
 * another shape). A
 * thread link shows its column (`boot-thread`); a server's root opens on a
 * phone's Home (`boot-home`). The sidebar and thread
 * columns take the widths the person dragged them to (`--boot-sidebar-width`,
 * `--boot-thread-width`, read and clamped as columnWidthStore does), so the
 * frame does not jump when React takes over. The server in the URL wears its
 * cached theme, as applyBootServerTheme does later, and a conversation link
 * sends the first screen's reads (BOOT_PREFETCH_STATEMENT).
 */
/** One column's remembered width onto <html> as `name`: its own key, else an earlier build's, clamped; nothing when none is stored. */
function bootWidthStatement(column: "sidebar" | "thread", name: string): string {
  const { storageKey, legacyStorageKeys, min, max } = COLUMN_BOUNDS[column];
  return `try{for(var w=${JSON.stringify([storageKey, ...legacyStorageKeys])},j=0;j<w.length;j++){var r=s.getItem(w[j]);`
    + `if(r===null||r.trim()===""||!isFinite(r))continue;`
    + `d.style.setProperty(${JSON.stringify(name)},Math.round(Math.max(${min},Math.min(${max},+r)))+"px");break}}catch(e){}`;
}

/**
 * `displayLocaleMatchRules()` of @botiverse/raft-shared ([language, script,
 * locale]), literal for the same reason as the prefix above; a test compares.
 */
export const BOOT_LOCALE_RULES: ReadonlyArray<readonly [string, string | null, string]> = [
  ["en", null, "en"],
  ["es", null, "es"],
  ["pt", null, "pt-br"],
  ["ru", null, "ru"],
  ["ko", null, "ko"],
  ["ja", null, "ja"],
  ["zh", "hans", "zh-cn"],
  ["zh", "hant", "zh-tw"],
];

/** locale.ts's DISPLAY_LOCALE_STORAGE_KEY, literal as above (tests compare them). */
export const BOOT_LOCALE_STORAGE_KEY = "slock.displayLanguage";

/**
 * The display locale the app will start in (locale.ts resolveInitialLocale:
 * `?lang=`, then the stored choice, then the browser's languages, else en),
 * onto <html data-boot-locale>, for the prerendered words that depend on it.
 * `mt` is raft-shared's matchDisplayLocale over BOOT_LOCALE_RULES. Uses `d`,
 * `s` (localStorage or null) from the script around it; tests check parity.
 */
export const BOOT_LOCALE_STATEMENT = String.raw`var R=${JSON.stringify(BOOT_LOCALE_RULES)},lc=null,lg=[],q=null,x=null,j,en=0;
function mt(t){var a=String(t==null?"":t).trim().toLowerCase().split("-"),g=a[0],sc=null,f=null,i,r;
if(!/^[a-z]{2,3}$/.test(g))return null;for(i=1;i<a.length;i++)if(!/^[a-z0-9]{1,8}$/.test(a[i]))return null;
if(g==="zh"){for(i=1;i<a.length;i++)if(/^[a-z]{4}$/.test(a[i])){sc=a[i];break}
if(!sc){sc="hans";for(i=1;i<a.length;i++)if(/^([a-z]{2}|\d{3})$/.test(a[i])){if(/^(tw|hk|mo)$/.test(a[i]))sc="hant";break}}}
for(i=0;i<R.length;i++){r=R[i];if(r[0]!==g)continue;if(r[1]===null||r[1]===sc)return r[2];if(!f)f=r[2]}return f}
try{lg=navigator.languages||[]}catch(e){}
try{q=new URLSearchParams(location.search).get("lang")}catch(e){}q=q&&q.trim();
if(q==="system"){for(j=0;j<lg.length;j++){x=mt(lg[j]);if(!x)continue;if(x==="en"){en=1;continue}if(!en||x.indexOf("zh")===0){lc=x;break}}lc=lc||"en"}
else if(q)lc=mt(q)||"en";
if(!lc){try{x=s&&s.getItem(${JSON.stringify(BOOT_LOCALE_STORAGE_KEY)})}catch(e){x=null}for(j=0;j<R.length;j++)if(R[j][2]===x)lc=x}
if(!lc)for(j=0;j<lg.length;j++){x=mt(String(lg[j]).replace(/_/g,"-"));if(x){lc=x;break}}
d.setAttribute("data-boot-locale",lc||"en");`;

/**
 * embed.ts's supported `embed` value, literal as above (tests compare them). A
 * host-shell embed (`?embed=raft-settings-v1`, any `shell` but `web`) shows one
 * surface inside the App's own chrome, so the app's frame never paints there
 * (`boot-off`).
 */
export const BOOT_HOST_SHELL_EMBED = "raft-settings-v1";

/** The `<script type="application/json">` the build writes with each locale's catalog parts (scripts/bootShellPlugin.ts, i18n/messages/catalogParts.ts). */
export const BOOT_LOCALE_CATALOGS_ID = LOCALE_CATALOGS_ELEMENT_ID;

/** Display locales whose catalog is complete (i18n/messages/index.ts COMPLETE_LOCALES; a test compares): the others load en too. */
export const BOOT_COMPLETE_LOCALES = ["en", "zh-cn"] as const;

/**
 * The boot locale's catalog chunks (the first part of each: the ids the first
 * download names, i18n/messages/catalogParts.ts; the rest is under another key
 * of the map, which this ignores), asked for with modulepreload as soon as
 * the page is parsed, in parallel with the app's own files: its own, and en
 * under a partial locale. The chunk URLs change with every build, so they are
 * not in this script (its text is fixed: the CSP allows it by hash) but in the
 * build's JSON map, which no browser runs. Runs on every page: the app holds
 * its first render until these are in (i18n/preloadLocaleMessages.ts).
 */
export const BOOT_CATALOG_PRELOAD_STATEMENT = String.raw`try{var C=JSON.parse(document.getElementById(${JSON.stringify(BOOT_LOCALE_CATALOGS_ID)}).textContent||"{}"),L=lc||"en",W=[C[L]];
if(${JSON.stringify(BOOT_COMPLETE_LOCALES)}.indexOf(L)<0)W.push(C.en);
for(j=0;j<W.length;j++){if(typeof W[j]!=="string"||!/^\/assets\/[^"<>]+\.js$/.test(W[j]))continue;x=document.createElement("link");x.rel="modulepreload";x.crossOrigin="";x.href=W[j];document.head.appendChild(x)}}catch(e){}`;

/** The `<script type="application/json">` the build writes with what the boot prefetch needs (scripts/bootShellPlugin.ts: the API base and this build's version). */
export const BOOT_PREFETCH_CONFIG_ID = "raft-boot-prefetch";


/** rootConversation.ts's ROOT_CONVERSATION_STORAGE_PREFIX and ROOT_REDIRECT_MEDIA_QUERY, literal as above (tests compare them). */
export const BOOT_ROOT_CONVERSATION_PREFIX = "raft:root-conversation:v1:";
export const BOOT_ROOT_REDIRECT_MEDIA_QUERY = "(min-width: 768px)";

/** messageTimelineShared.ts's scroll memory key for a conversation, literal as above (tests compare them). */
export const BOOT_SCROLL_MEMORY_PREFIX = "slock.scroll-memory.v1.channel:";

/**
 * The first screen's reads, sent while the page is still downloading the
 * app's code (docs/frontend/boot-requests.md, "From the HTML"): on a
 * conversation link (`/s/<slug>/channel|dm/<id>`) with a stored token that
 * hasn't expired, the signed-in check and the server list, and, for the
 * server the URL names, the conversation, its latest page of messages, the
 * channel and DM lists, the sidebar order and the members. The server's id
 * comes from the device (the theme cache keeps it beside the slug); without
 * it, from the server list this script just asked for. Each request goes out
 * with the headers the API client would send (client.ts), so the client can
 * take its answer instead of asking again (boot/bootPrefetch.ts compares them;
 * any difference, an error or a 401 and it asks itself). Nothing here reads
 * an answer but the server list, and only for the id; nothing is stored.
 *
 * Not on a thread or message link, nor where the conversation remembers a
 * scroll position, for the messages: the app opens another window there
 * (preloadServerRoute). Not in Raft Desktop, which loads its own page.
 *
 * The server's root (`/s/<slug>`) counts as a link to the conversation it last
 * landed on (store/rootConversation.ts, kept per person and server), where the
 * root redirects (the width DefaultRoute redirects at) and only when the theme
 * cache names the server: otherwise nothing is sent, as before. A guess: the
 * app takes these answers only if the channel list lands it there.
 *
 * Uses `d`, `s`, `p`, `slug` and `sid` (the server id from the theme cache, or
 * null) from the script around it.
 */
export const BOOT_PREFETCH_STATEMENT = String.raw`try{var P=JSON.parse(document.getElementById(${JSON.stringify(BOOT_PREFETCH_CONFIG_ID)}).textContent||"null"),
c=/^\/s\/[^/]+(?:\/(?:channel|dm)\/([0-9A-Za-z_-]+))?\/?$/.exec(p),t=s.getItem("slock_access_token"),y=null,o=null,H,Q,A,F,S,G;
G=function(q){try{return matchMedia(q).matches}catch(e){return false}};
try{y=JSON.parse(atob(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")))}catch(e){}
if(c)o=c[1]||(sid&&y&&typeof y.sub==="string"&&G(${JSON.stringify(BOOT_ROOT_REDIRECT_MEDIA_QUERY)})?s.getItem(${JSON.stringify(BOOT_ROOT_CONVERSATION_PREFIX)}+y.sub+":"+sid):null);
if(P&&o&&/^[0-9A-Za-z_-]+$/.test(o)&&t&&typeof P.api==="string"&&/^(https?:\/\/[^/?#]+)?\/api$/.test(P.api)&&typeof P.version==="string"&&typeof fetch==="function"
&&!window.raftDesktop&&!/[?&]auth_callback(=|&|$)/.test(location.search)){
if(!(y&&typeof y.exp==="number"&&isFinite(y.exp)&&y.exp*1000-30000<=Date.now())){
A=P.api.charAt(0)==="/"?location.origin+P.api:P.api;Q=window[${JSON.stringify(BOOT_FETCHES_GLOBAL)}]=[];
H={"Accept":"application/json, text/plain, */*","Authorization":"Bearer "+t,
"X-Raft-Client-Platform":navigator.standalone===true||G("(display-mode: standalone)")||G("(display-mode: window-controls-overlay)")?"pwa":"browser",
"X-Raft-Client-Version":P.version};
F=function(u,i,x){var h={},k,n=new Uint8Array(24),r="",e;for(k in H)h[k]=H[k];if(i)h["X-Server-Id"]=i;for(k in x)h[k]=x[k];
crypto.getRandomValues(n);for(k=0;k<24;k++)r+=(n[k]<16?"0":"")+n[k].toString(16);h.traceparent="00-"+r.slice(0,32)+"-"+r.slice(32)+"-00";
e={u:A+u,h:h,t:Date.now(),p:fetch(A+u,{headers:h})};e.p.then(function(){e.d=Date.now()},function(){e.d=Date.now()});Q.push(e);return e.p};
S=function(i){var v=null;if(typeof i!=="string"||!/^[0-9a-f-]{36}$/i.test(i))return;
F("/channels/"+o,i,{"X-Raft-Fetch-Reason":"preload"});
try{v=sessionStorage.getItem(${JSON.stringify(BOOT_SCROLL_MEMORY_PREFIX)}+o)}catch(e){}
if(v===null&&!/[?&](thread|msg)(=|&|$)/.test(location.search))F("/messages/channel/"+o+"?limit=50",i);
F("/channels?archived=include",i);F("/channels/dm",i);F("/servers/"+i+"/sidebar-order",i);F("/servers/"+i+"/members",i)};
F("/auth/me");
x=F("/servers");
if(sid)S(sid);else x.then(function(r){return r.ok?r.clone().json():null}).then(function(l){for(j=0;l&&j<l.length;j++)if(l[j]&&l[j].slug===slug){S(l[j].id);break}}).catch(function(){})}}}catch(e){}`;

export const BOOT_HINTS_SCRIPT = `(function(){var d=document.documentElement,s=null;try{s=localStorage}catch(e){}
var p=location.pathname,m=/^\\/s\\/([^/?#]+)/.exec(p);
${BOOT_LOCALE_STATEMENT}
${BOOT_CATALOG_PRELOAD_STATEMENT}
if(/^\\/artifacts\\/[^/]+(\\/v\\/[^/]+)?\\/?$/.test(p)){d.classList.add("boot-artifact");try{x=new URLSearchParams(location.search);if(x.get("embed")===${JSON.stringify(BOOT_HOST_SHELL_EMBED)}&&x.get("shell")!=="web")d.classList.add("boot-embedded")}catch(e){}return}
if(!s||!s.getItem("slock_access_token")||!(m||p==="/")){d.classList.add("boot-off");return}
try{x=new URLSearchParams(location.search);if(x.get("embed")===${JSON.stringify(BOOT_HOST_SHELL_EMBED)}&&x.get("shell")!=="web"){d.classList.add("boot-off");return}}catch(e){}
if(/[?&]thread=/.test(location.search))d.classList.add("boot-thread");
if(p==="/"||/^\\/s\\/[^/]+\\/?$/.test(p))d.classList.add("boot-home");
${bootWidthStatement("sidebar", "--boot-sidebar-width")}
${bootWidthStatement("thread", "--boot-thread-width")}
if(!m)return;
var slug=null,sid=null;try{slug=decodeURIComponent(m[1]);for(var i=0;i<s.length;i++){var k=s.key(i);if(!k||k.indexOf(${JSON.stringify(BOOT_SERVER_THEME_STORAGE_PREFIX)})!==0)continue;
var v=JSON.parse(s.getItem(k)||"null");if(!v||v.slug!==slug)continue;sid=sid||k.slice(${BOOT_SERVER_THEME_STORAGE_PREFIX.length});if(typeof v.theme!=="string"||!/^[a-z0-9-]+$/.test(v.theme))continue;
if(v.theme!=="raft")d.dataset.theme=v.theme;if(v.decor===false)d.dataset.themeDecor="off";break}}catch(e){}
${BOOT_PREFETCH_STATEMENT}})();`;

export function buildBootInlineScript(themeBootstrapSource: string): string {
  return `${themeBootstrapSource.trim()}\n${BOOT_HINTS_SCRIPT}`;
}

export async function bootInlineScriptCspSource(script: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return `'sha256-${base64}'`;
}
