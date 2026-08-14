/**
 * İş sahəsini ÖZ pəncərəsində açır (istifadəçi qərarı: «hər iş sahəsi öz
 * pəncərəsində»).
 *
 * 🔴 SESSİYA İZOLYASİYASI PLATFORMAYA GÖRƏ AYRILIR — Tauri 2.11-in
 * `webview.d.ts` tiplərində yoxlanıldı:
 *     macOS   → `dataStoreIdentifier` (16 bayt), macOS ≥14
 *     Windows → `dataDirectory` (appDataDir/{label} altında nisbi yol)
 * Hər iki API DAVAMLIDIR (pəncərə bağlananda sessiya itmir). `incognito`
 * QƏSDƏN işlədilmir: o, hər iki platformada işləsə də sessiyanı SAXLAMIR və
 * istifadəçi hər dəfə şifrə yazmalı olardı.
 *
 * ⚠️ macOS < 14: `dataStoreIdentifier` mövcud deyil. Belə halda pəncərə yenə
 * açılır, sadəcə sessiya ümumi qabı işlədir — yəni eyni biznesdə ikinci tərəfə
 * keçəndə birinci sessiya əvəzlənir. Bu, funksiyanı bloklamır; səbəbi
 * `isolationSupported()` ilə istifadəçiyə YAZILIR (səssiz davranış yox).
 */

import type { Workspace } from './workspaces'
import { sessionBytes, windowLabel, workspaceTitle, workspaceUrl } from './workspaces'

/** Brauzer sətrindən platforma — Tauri OS plugin-i quraşdırılmayıb, əlavə asılılıq yaratmırıq. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const s = `${navigator.userAgent} ${(navigator as any).platform || ''}`
  return /Mac|iPhone|iPad/i.test(s)
}

/**
 * 🔴 macOS VERSİYASINI USER-AGENT-DƏN OXUMAQ OLMAZ (brauzerdə sınandı).
 *
 * Gizlilik üçün Safari/WKWebView macOS versiyasını `10_15_7` kimi DONDURUR —
 * yəni macOS 15-də də UA «10» deyir. İlk yazılışımda `macMajor() >= 14`
 * şərti qoymuşdum və nəticədə: (a) xəbərdarlıq HƏMİŞƏ görünürdü,
 * (b) izolyasiya dəstəklənən maşında da SÖNDÜRÜLÜRDÜ.
 *
 * Doğru yol — TƏXMİN ETMƏ, SINA: pəncərəni `dataStoreIdentifier` ilə açmağa
 * çalış; platforma dəstəkləmirsə xəta qaytarır və biz onsuz təkrar açırıq.
 * Nəticə faktdır, ehtimal deyil.
 */
const ISO_KEY = 'olko_isolation_unsupported'

/** Sınaqdan sonra məlum olan həqiqət (əvvəlcə: bilinmir → dəstəklənir sayılır). */
export function isolationSupported(): boolean {
  try {
    return localStorage.getItem(ISO_KEY) !== '1'
  } catch {
    return true
  }
}

const ISO_REASON_KEY = 'olko_isolation_reason'

function markIsolationUnsupported(reason?: string): void {
  try {
    localStorage.setItem(ISO_KEY, '1')
    if (reason) localStorage.setItem(ISO_REASON_KEY, String(reason).slice(0, 200))
  } catch { /* kvota */ }
}

/** İzolyasiyanın niyə alınmadığı — launcher-də göstərilir (təxmin yox, fakt). */
export function isolationFailureReason(): string {
  try { return localStorage.getItem(ISO_REASON_KEY) || '' } catch { return '' }
}

/**
 * 🔴 UĞURDA BAYRAQ TƏMİZLƏNMƏLİDİR — öz qüsurum, canlı yaddaşda tutuldu.
 *
 * `olko_isolation_unsupported` bir dəfə qoyulub HEÇ VAXT silinmirdi. Nəticə:
 * izolyasiya sonradan işləməyə başlasa belə (məs. v0.5.2-dəki UUID düzəlişi ilə)
 * launcher əbədi olaraq «bu sistemdə sessiya paylaşılır» yazacaqdı və mən də
 * ona baxıb «hələ də sınıqdır» deyəcəkdim. Vəziyyət ÖZÜNÜ DÜZƏLTMƏLİDİR:
 * hər uğurlu izolyasiyalı açılışda bayraq və səbəb silinir.
 */
function markIsolationWorking(): void {
  try {
    localStorage.removeItem(ISO_KEY)
    localStorage.removeItem(ISO_REASON_KEY)
  } catch { /* kvota */ }
}

/**
 * 🔴 «PƏNCƏRƏ AÇILDI» ≠ «İZOLYASİYA TƏTBİQ OLUNDU».
 *
 * wry mənbəyində oxudum (`wkwebview/mod.rs`): identifikator dəstəklənmirsə və
 * ya konfiqurasiya təkrar işlədilirsə, kod SƏSSİZCƏ `defaultDataStore()`-a
 * düşür — pəncərə yenə uğurla yaranır və `tauri://created` gəlir. Yəni
 * hadisəyə baxıb «izolyasiya işlədi» demək TƏXMİNDİR.
 *
 * Tauri `fetchDataStoreIdentifiers()` verir — ƏSL siyahı. Ölçürük:
 *   true  → bizim identifikator var, izolyasiya HƏQİQƏTƏN tətbiq olunub
 *   false → pəncərə açılıb, amma ayrıca sessiya qabı YARANMAYIB
 *   null  → ölçə bilmədik (API/icazə yoxdur) — heç nə iddia etmirik
 */
async function isolationReallyApplied(id: number[]): Promise<boolean | null> {
  try {
    const appApi: any = await import('@tauri-apps/api/app')
    if (typeof appApi.fetchDataStoreIdentifiers !== 'function') return null
    const ids: number[][] = await appApi.fetchDataStoreIdentifiers()
    if (!Array.isArray(ids)) return null
    return ids.some((x) => Array.isArray(x) && x.length === id.length && x.every((b, i) => b === id[i]))
  } catch {
    return null
  }
}

export interface OpenResult {
  ok: boolean
  /** Tauri yoxdursa (brauzerdə dev) — sadəcə eyni tabda açılıb. */
  fallback?: boolean
  error?: string
}

export async function openWorkspaceWindow(w: Workspace): Promise<OpenResult> {
  const url = workspaceUrl(w)
  const label = windowLabel(w)

  let api: typeof import('@tauri-apps/api/webviewWindow')
  try {
    api = await import('@tauri-apps/api/webviewWindow')
  } catch {
    // Brauzerdə (dev) Tauri yoxdur — davranış pozulmasın deyə eyni tabda aç
    window.location.assign(url)
    return { ok: true, fallback: true }
  }

  /**
   * 🔴 ÖNƏ GƏTİRMƏ HƏR ADDIMI AYRICA QORUNUR (canlıda tutuldu).
   *
   * Əvvəl bütün blok TƏK try/catch içində idi: `existing.show()` icazə
   * çatışmazlığından partlayanda (capability-də `core:window:allow-show`
   * yox idi) kod «pəncərə tapılmadı» kimi davranıb YENİSİNİ yaratmağa
   * keçirdi və istifadəçi bu xətanı görürdü:
   *     «a webview with label `ws-…` already exists»
   * İndi hər çağırış ayrıca udulur — biri alınmasa da qalanları işləyir və
   * pəncərə TAPILIBSA yenisi YARADILMIR.
   */
  const focusExisting = async (): Promise<boolean> => {
    let win: any = null
    try {
      win = await api.WebviewWindow.getByLabel(label)
    } catch { /* icazə/dəstək yoxdur */ }
    if (!win) {
      try {
        const all = await (api as any).getAllWebviewWindows?.()
        win = all?.find((w: any) => w?.label === label) ?? null
      } catch { /* siyahı alınmadı */ }
    }
    if (!win) return false
    try { await win.show() } catch { /* icazə yoxdursa da davam et */ }
    try { await win.unminimize() } catch { /* minimizə deyil */ }
    try { await win.setFocus() } catch { /* fokus alınmadı */ }
    return true
  }

  if (await focusExisting()) return { ok: true }

  const base: Record<string, unknown> = {
    url,
    title: workspaceTitle(w),
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    center: true,
    resizable: true,
  }

  // 🔴 Yalnız DƏSTƏKLƏNƏN açar göndərilir (tiplərdə yoxlandı):
  //    macOS → `dataStoreIdentifier`, Windows/Linux → `dataDirectory`.
  const isolated: Record<string, unknown> = isMac()
    ? { ...base, dataStoreIdentifier: sessionBytes(w.id) }
    : { ...base, dataDirectory: label }

  const attempt = (opts: Record<string, unknown>) =>
    new Promise<OpenResult>((resolve) => {
      let done = false
      const finish = (r: OpenResult) => { if (!done) { done = true; resolve(r) } }
      try {
        const win = new api.WebviewWindow(label, opts as any)
        win.once('tauri://created', () => finish({ ok: true }))
        win.once('tauri://error', (e: any) =>
          finish({ ok: false, error: String(e?.payload || 'pəncərə açılmadı') }))
        // Hadisə gəlməsə də ilişib qalmasın
        setTimeout(() => finish({ ok: true }), 4000)
      } catch (e) {
        finish({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })

  /** Pəncərə ARTIQ VAR xətası — yaratmaq yox, önə gətirmək lazımdır. */
  const isAlreadyExists = (msg?: string) => /already exists/i.test(msg || '')

  // ① İzolyasiya ilə sına
  const first = await attempt(isolated)
  if (first.ok) {
    // 🔴 Hadisəyə güvənmirik — ÖLÇÜRÜK (yuxarıdakı izaha bax)
    if (isMac()) {
      const applied = await isolationReallyApplied(sessionBytes(w.id))
      if (applied === true) markIsolationWorking()
      else if (applied === false) {
        markIsolationUnsupported('pəncərə açıldı, amma ayrıca sessiya qabı yaranmadı')
      }
      // null → ölçə bilmədik, mövcud vəziyyətə toxunmuruq
    } else {
      markIsolationWorking()
    }
    return first
  }
  if (isAlreadyExists(first.error) && (await focusExisting())) return { ok: true }

  // ② Alınmadısa — izolyasiyasız aç və bunu YADDA SAXLA ki, launcher
  //    istifadəçiyə dürüst xəbərdarlıq göstərsin (səssiz deqradasiya yox).
  //    🔴 SƏBƏBİ də saxlayırıq: «işləmir» yox, «BU SƏBƏBDƏN işləmir».
  //    İlk yazılışda yalnız bayraq qoyurdum və nə baş verdiyini bilmək
  //    mümkün deyildi.
  markIsolationUnsupported(first.error)
  const second = await attempt(base)
  if (second.ok) return second
  if (isAlreadyExists(second.error) && (await focusExisting())) return { ok: true }
  return second.error ? second : first
}
