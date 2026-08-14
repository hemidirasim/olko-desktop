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

/** İş sahəsinin açacağı tam ünvan. */
export function workspaceUrl(w: Workspace): string {
  return w.kind === 'portal' ? `https://${w.site}/portal` : `https://${w.site}`
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
