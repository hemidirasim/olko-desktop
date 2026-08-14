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

function markIsolationUnsupported(): void {
  try { localStorage.setItem(ISO_KEY, '1') } catch { /* kvota */ }
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

  try {
    // Artıq açıqdırsa YENİSİNİ yaratma — önə gətir (istifadəçi qərarı).
    const existing = await api.WebviewWindow.getByLabel(label)
    if (existing) {
      await existing.show()
      await existing.unminimize().catch(() => {})
      await existing.setFocus()
      return { ok: true }
    }
  } catch {
    /* getByLabel dəstəklənmirsə yaratmağa keç */
  }

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

  // ① İzolyasiya ilə sına
  const first = await attempt(isolated)
  if (first.ok) return first

  // ② Platforma dəstəkləmirsə — izolyasiyasız aç və bunu YADDA SAXLA ki,
  //    launcher istifadəçiyə dürüst xəbərdarlıq göstərsin (səssiz deqradasiya yox).
  markIsolationUnsupported()
  const second = await attempt(base)
  return second.ok ? second : first
}
