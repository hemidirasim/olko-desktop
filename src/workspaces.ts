/**
 * İŞ SAHƏLƏRİ (workspaces) — Faza 1.0 (2026-08-14)
 * ==================================================
 *
 * İSTİFADƏÇİ: «proqramı açanda soruşulsun müştəri yoxsa istifadəçi… həm
 * istifadəçi həm portal üçün müxtəlif pəncərələr açmaq olsun… workspace
 * məntiqi ilə açılsın, hansına keçid etmək istəyirsə ona keçid etsin».
 *
 * ═══ MODEL ═══
 * App NAZİK SAYT SEÇİCİSİDİR: autentifikasiyanı ERP-nin öz first-party login-i
 * idarə edir (2026-07-27 qərarı — iframe cross-site cookie problemi). Ona görə
 * iş sahəsi cəmi iki şeydən ibarətdir:
 *
 *     iş sahəsi = (biznes sayt) + (tərəf: istifadəçi | müştəri)  →  bir URL
 *
 *     istifadəçi → https://{site}
 *     müştəri    → https://{site}/portal
 *
 * ═══ SESSİYA İZOLYASİYASI (istifadəçi qərarı: «davamlı ayrı sessiya») ═══
 * Fərqli bizneslər onsuz da fərqli origin-dir → cookie-ləri ayrıdır.
 * İzolyasiya YALNIZ bir hal üçün lazımdır: EYNİ biznesdə eyni anda həm işçi,
 * həm müştəri kimi qalmaq.
 *
 * Tauri 2.11-in quraşdırılmış tiplərində yoxlanıldı (`webview.d.ts`):
 *     dataStoreIdentifier → macOS ≥14 / iOS   (Windows·Linux: DƏSTƏKLƏNMİR)
 *     dataDirectory       → Windows·Linux     (macOS·iOS: DƏSTƏKLƏNMİR)
 *     incognito           → hər ikisi, amma DAVAMSIZ (pəncərə bağlananda itir)
 * Yəni davamlı izolyasiya hər iki platformada mümkündür — sadəcə API adı
 * fərqlidir. Ona görə platformaya görə ayrılırıq.
 */

export type WorkspaceKind = 'user' | 'portal'

export interface Workspace {
  /** Sabit açar — pəncərə etiketi və sessiya qabı bundan törəyir. */
  id: string
  kind: WorkspaceKind
  /** Tam host: «qurman.olkoerp.com» və ya custom domen «erp.admedia.az». */
  site: string
  /**
   * 🔴 Portal üçün AYRI host (Faza 45.44). İşçi paneli və müştəri portalı
   * eyni ünvanda olanda sessiya cookie-si də eynidir → eyni anda ikisində
   * qalmaq mümkün deyil. Master reyestri ayrı host verirsə onu işlədirik.
   * Boşdursa köhnə davranış: `site` üzərində `/portal`.
   */
  portalSite?: string
  /** İstifadəçinin verdiyi ad (boşdursa sayt adı göstərilir). */
  label?: string
  createdAt: number
  lastOpenedAt?: number
}

const KEY = 'olko_workspaces'
/** Köhnə tək-sayt açarı — miqrasiya üçün oxunur. */
const LEGACY_KEY = 'olko_last_site'

/**
 * Biznes adını tam hosta çevirir.
 * 🔴 Qayda MÖVCUD `App.tsx` davranışının eynisidir: nöqtəsiz dəyər
 * `{ad}.olkoerp.com`-a çevrilir, nöqtəli dəyər (custom domen) toxunulmur.
 * İki yerdə fərqli qayda olsa iş sahəsi bir ünvana, giriş başqasına gedərdi —
 * ERP tərəfində 45.37-də məhz bu buq yaşandı.
 */
export function normalizeSite(raw: string): string {
  let s = (raw || '').trim().toLowerCase()
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!s) return ''
  if (!s.includes('.')) s = `${s}.olkoerp.com`
  return s
}

/**
 * 🔴 TƏXMİN ETMƏ — SORUŞ (Faza 45.40).
 *
 * `normalizeSite` «admedia» → `admedia.olkoerp.com` təxmini qurur. Canlıda
 * ölçüldü ki, bu təxmin İSTİFADƏÇİNİ SƏHV BAZAYA aparır:
 *     admedia.olkoerp.com → köhnə server (159), tenantın tərk edilmiş
 *                           nüsxəsi — 29 müştəri
 *     control.admedia.az  → əsl baza (167) — 76 müştəri
 * Hər iki ünvan HTTP 200 verir, yəni səhv sükutla baş verir.
 *
 * Master reyestri (`ME Tenant.custom_domain`) doğru cavabı bilir — ondan
 * soruşuruq. Şəbəkə yoxdursa təxminə düşürük (proqram oflayn da açılmalıdır).
 */
const HOST_RESOLVER =
  'https://olkoerp.com/api/method/mini_erp.mini_erp.tenant_api.resolve_tenant_host'

export interface ResolvedHost {
  host: string
  /** Müştəri portalının hostu (ayrı verilməyibsə `host` ilə eyni). */
  portalHost: string
  /** `true` — cavab master reyestrindən gəldi; `false` — yerli təxmin. */
  canonical: boolean
}

export async function resolveSiteHost(raw: string): Promise<ResolvedHost> {
  const guess = normalizeSite(raw)
  if (!guess) return { host: '', portalHost: '', canonical: false }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 6000)
    const res = await fetch(`${HOST_RESOLVER}?name=${encodeURIComponent(raw.trim())}`, {
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return { host: guess, portalHost: guess, canonical: false }
    const body = await res.json()
    const host = String(body?.message?.host || '').trim().toLowerCase()
    const portalRaw = String(body?.message?.portal_host || '').trim().toLowerCase()
    // 🔴 Cavab BİZİ HANSISA ÜNVANA APARIR — formatı ciddi yoxlanır:
    //    yalnız host (sxem, yol, port, `javascript:` yox).
    const okHost = (h: string) =>
      !!h && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)
    if (!okHost(host)) return { host: guess, portalHost: guess, canonical: false }
    return {
      host,
      // Portal hostu da EYNİ ciddiliklə yoxlanır — o da bizi bir ünvana aparır
      portalHost: okHost(portalRaw) ? portalRaw : host,
      canonical: Boolean(body?.message?.canonical),
    }
  } catch {
    return { host: guess, portalHost: guess, canonical: false }
  }
}

/** İş sahəsinin açacağı tam ünvan. */
export function workspaceUrl(w: Workspace): string {
  // Yol həmişə `/portal` qalır — ayıran şey HOST-dur (cookie hosta bağlıdır).
  if (w.kind === 'portal') return `https://${w.portalSite || w.site}/portal`
  return `https://${w.site}`
}

export function workspaceTitle(w: Workspace): string {
  const side = w.kind === 'portal' ? 'Müştəri' : 'İstifadəçi'
  return `${w.label || w.site} — ${side}`
}

/** Pəncərə etiketi: Tauri yalnız hərf/rəqəm/`-`/`_`/`:`/`/` qəbul edir. */
export function windowLabel(w: Workspace): string {
  return `ws-${w.id.replace(/[^a-zA-Z0-9_-]/g, '')}`
}

/**
 * Determinist 16 baytlıq sessiya açarı (macOS `dataStoreIdentifier` üçün).
 * 🔴 DETERMİNİST olmalıdır: təsadüfi olsaydı hər açılışda YENİ boş sessiya
 * yaranar və istifadəçi hər dəfə şifrə yazardı — «davamlı» tələbi pozulardı.
 */
export function sessionBytes(id: string): number[] {
  const out: number[] = new Array<number>(16).fill(0)
  for (let i = 0; i < id.length; i++) {
    const k = i % 16
    out[k] = (out[k] * 31 + id.charCodeAt(i)) % 256
  }
  // Sıfır-dolu identifikator bəzi platformalarda etibarsız sayıla bilər.
  // 🔴 `every(b => b === 0)` YAZMAQ OLMAZ: TS 5.5 onu tip daraldıcısı kimi
  //    çıxarır və `out`-u `0[]`-ə daraldır → sonrakı mənimsətmə kompilyasiya
  //    xətası verir. `some(... !== 0)` bu tələdən keçir.
  if (!out.some((b) => b !== 0)) out[0] = 1

  // 🔴 RFC-4122 v4 formatı: Apple `WKWebsiteDataStore(forIdentifier:)`
  //    NSUUID gözləyir. Sırf təsadüfi baytlar formal olaraq etibarlı UUID
  //    sayılmaya bilər — versiya/variant bitlərini qoymaq ucuz sığortadır.
  //    (macOS-da izolyasiyanın nə üçün alınmadığı hələ təsdiqlənməyib;
  //    əsl səbəb artıq `olko_isolation_reason`-a yazılır.)
  out[6] = (out[6] & 0x0f) | 0x40   // versiya 4
  out[8] = (out[8] & 0x3f) | 0x80   // variant 10xx
  return out
}

export function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function loadWorkspaces(): Workspace[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list: Workspace[] = raw ? JSON.parse(raw) : []
    if (Array.isArray(list) && list.length) return list

    // ── Miqrasiya: köhnə tək-sayt yaddaşı iş sahəsinə çevrilir ──
    // 🔴 Bunsuz mövcud istifadəçi yeniləmədən sonra boş ekran görərdi və
    //    biznes adını yenidən yazmalı olardı.
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy) {
      const site = normalizeSite(legacy)
      if (site) {
        const w: Workspace = { id: newId(), kind: 'user', site, createdAt: Date.now() }
        saveWorkspaces([w])
        return [w]
      }
    }
    return []
  } catch {
    return []
  }
}

export function saveWorkspaces(list: Workspace[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* kvota dolubsa səssiz keç — iş sahəsi itsə də app işləməlidir */
  }
}

export function addWorkspace(list: Workspace[], w: Workspace): Workspace[] {
  // Eyni (sayt + tərəf) təkrarlanmasın — istifadəçi iki eyni kart görməsin
  const dup = list.find((x) => x.site === w.site && x.kind === w.kind)
  if (dup) return list
  return [...list, w]
}
