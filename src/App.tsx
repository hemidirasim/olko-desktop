import { useState, useEffect } from 'react'
import olkoLogo from './assets/olko-logo.png'
import UpdateGate, { UPDATE_ERR_KEY } from './UpdateGate'
import './index.css'
import {
  addWorkspace, loadWorkspaces, newId, normalizeSite, saveWorkspaces,
  resolveSiteHost, workspaceUrl, type Workspace, type WorkspaceKind,
} from './workspaces'
import { isMac, isolationFailureReason, isolationSupported, openWorkspaceWindow } from './openWorkspace'

/**
 * 🔴 Faza 1.0 (2026-08-14) — İŞ SAHƏSİ (workspace) modeli.
 *
 * İSTİFADƏÇİ: «proqramı açanda soruşulsun müştəri yoxsa istifadəçi… workspace
 * məntiqi ilə açılsın, hansına keçid etmək istəyirsə ona keçid etsin… həm
 * istifadəçi həm portal üçün müxtəlif pəncərələr açmaq olsun».
 *
 * ƏVVƏL: app tək sayt saxlayırdı (`olko_last_site`) və açılışda BİRBAŞA ora
 * keçirdi. İNDİ: açılışda LAUNCHER görünür, hər iş sahəsi öz pəncərəsində açılır.
 *
 * 🔴 Avtomatik keçid QƏSDƏN SİLİNDİ — istifadəçi məhz «açanda soruşulsun»
 * dedi. Köhnə tək-sayt yaddaşı isə itmir: `loadWorkspaces()` onu ilk açılışda
 * iş sahəsinə çevirir (miqrasiya).
 */
type Screen = 'launcher' | 'add'

// ✅ 2026-07-17 Android dəstəyi: mobil-də pəncərə API-ləri (resize/hide/drag) yoxdur —
// tam-ekran rejim, bubble/collapse yalnız desktop-da
const IS_MOBILE = /android|iphone|ipad/i.test(navigator.userAgent)

/**
 * 🔴 KARTIN «ÜZÜ» — AnyDesk-də hər sessiyanın ekran şəkli olur və istifadəçi
 * onları rəngə görə tanıyır. Bizdə ekran şəkli yoxdur, ona görə eyni funksiyanı
 * BİZNES ADINDAN TÖRƏYƏN determinist rəng verir: eyni biznes həmişə eyni
 * görünür, fərqli bizneslər fərqlənir. Təsadüfi rəng OLMAZ — hər açılışda
 * dəyişsəydi «tanıma» faydası itərdi.
 */
function hashHue(sRaw: string): number {
  let h = 0
  for (let i = 0; i < sRaw.length; i++) h = (h * 31 + sRaw.charCodeAt(i)) % 360
  return h
}

/**
 * Rəng açarı: eyni biznesin İŞÇİ və MÜŞTƏRİ kartları EYNİ rəngdə olmalıdır —
 * onları «bir biznes» kimi görmək lazımdır. Ona görə açar portal hostundan
 * yox, biznesin qeydiyyat adından götürülür.
 */
function brandKey(site: string): string {
  const parts = (site || '').toLowerCase().split('.').filter(Boolean)
  if (site.endsWith('.olkoerp.com')) return parts[0] || site
  return parts.length >= 2 ? parts[parts.length - 2] : site
}

function coverGradient(host: string): string {
  const h = hashHue(host)
  const h2 = (h + 38) % 360
  return `linear-gradient(135deg, hsl(${h} 52% 46%), hsl(${h2} 58% 34%))`
}

/**
 * 🔴 MƏNALI HİSSƏNİ SEÇ — sadəcə «ilk iki hərf» YETƏRLİ DEYİL.
 * Brauzerdə göründü: `control.admedia.az` → «CO» və `cofmof.olkoerp.com` → «CO»
 * — iki fərqli biznes eyni monoqramla çıxırdı, tanıma faydası itirdi.
 * Qayda: olkoerp.com altdomeni isə TENANT adı (qurman→QU), custom domendirsə
 * qeydiyyat adı (control.admedia.az → admedia → AD).
 */
function monogram(name: string): string {
  const clean = (name || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase()
  const parts = clean.split('.').filter(Boolean)
  let word = parts[0] || clean
  if (clean.endsWith('.olkoerp.com')) {
    word = parts[0] || clean            // tenant adı
  } else if (parts.length >= 2) {
    word = parts[parts.length - 2]      // qeydiyyat adı (admedia.az → admedia)
  }
  return word.slice(0, 3).toUpperCase()
}

/** «Son açılış» — nisbi, qısa. Heç açılmayıbsa boş qalır (uydurma tarix yox). */
function lastSeen(ts?: number): string {
  if (!ts) return 'açılmayıb'
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'indicə'
  if (m < 60) return `${m} dəq əvvəl`
  const hr = Math.floor(m / 60)
  if (hr < 24) return `${hr} saat əvvəl`
  return `${Math.floor(hr / 24)} gün əvvəl`
}

function App() {
  // ✅ 2026-07-27: proqram açılanda ƏVVƏL yeniləmə yoxlanır (uzaq domenə keçəndən sonra
  // Tauri plagin API-ləri əlçatan olmur → yoxlama məhz burada aparılmalıdır).
  const [updateChecked, setUpdateChecked] = useState(false)
  const [screen, setScreen] = useState<Screen>('launcher')
  const [siteUrl, setSiteUrl] = useState('')
  const [error, setError] = useState('')
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  /** «Yeni iş sahəsi» axını: əvvəl TƏRƏF, sonra biznes adı. */
  const [newKind, setNewKind] = useState<WorkspaceKind | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState('')
  const [resolving, setResolving] = useState(false)
  /** «Açılacaq: …» sətri üçün HƏQİQİ ünvan (təxmin yox). */
  const [previewHost, setPreviewHost] = useState('')
  /**
   * Hazırda AÇIQ olan iş sahəsi pəncərələri (`ws-<id>` etiketləri).
   * AnyDesk-dəki yaşıl «qoşulu» göstəricisinin qarşılığı — istifadəçi hansının
   * artıq açıq olduğunu görsün, təkrar açmağa çalışmasın.
   */
  const [openLabels, setOpenLabels] = useState<string[]>([])

  useEffect(() => {
    if (IS_MOBILE) return
    let stop = false
    const scan = async () => {
      try {
        const api: any = await import('@tauri-apps/api/webviewWindow')
        const all = await api.getAllWebviewWindows?.()
        if (!stop && Array.isArray(all)) {
          setOpenLabels(all.map((w: any) => String(w?.label || '')).filter(Boolean))
        }
      } catch { /* brauzer dev və ya icazə — göstərici sadəcə görünmür */ }
    }
    void scan()
    const t = window.setInterval(scan, 4000)
    return () => { stop = true; window.clearInterval(t) }
  }, [])

  useEffect(() => {
    // 🔴 Faza 1.0: AVTOMATİK KEÇİD YOXDUR. Əvvəl saxlanmış sayt varsa app
    // birbaşa ora keçirdi; istifadəçi isə açılışda seçim istədi. Köhnə yaddaş
    // `loadWorkspaces()` içində iş sahəsinə çevrilir — heç nə itmir.
    const loaded = loadWorkspaces()
    setWorkspaces(loaded)
    // 🔴 Faza 45.47: localStorage boşdursa FAYLDAN bərpa et (Rust ws_list).
    // localStorage iki dəfə itki verdi (45.41, 45.46) — fayl bərpa mənbəyidir.
    if (!loaded.length) {
      void (async () => {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const fromFile = (await invoke('ws_list')) as Workspace[]
          if (Array.isArray(fromFile) && fromFile.length && !loadWorkspaces().length) {
            setWorkspaces(fromFile)
            saveWorkspaces(fromFile)
          }
        } catch { /* Tauri yoxdur (dev) */ }
      })()
    }
    // 🔴 0.5.0-da əlavə edilmiş iş sahələri TƏXMİNLƏ qurulmuşdu və köhnə
    //    serverə düşə bilər. Açılışda səssizcə kanonik ünvana uyğunlaşdırırıq.
    //    Yalnız reyestr TƏSDİQ edəndə (`canonical`) dəyişirik — şəbəkə
    //    problemində istifadəçinin öz yazdığı ünvan əzilməsin.
    void (async () => {
      let changed = false
      const next = await Promise.all(loaded.map(async (w) => {
        const r = await resolveSiteHost(w.site)
        if (!r.canonical) return w
        const nextSite = r.host || w.site
        const nextPortal = r.portalHost || nextSite
        if (nextSite !== w.site || nextPortal !== (w.portalSite || '')) {
          changed = true
          return { ...w, site: nextSite, portalSite: nextPortal }
        }
        return w
      }))
      if (changed) {
        // 🔴 ÜSTÜNƏ YAZMA — BİRLƏŞDİR (yarış vəziyyəti, canlıda İKİNCİ dəfə
        // itki verdi). Bu async iş açılışda tutulan `loaded` üzərində gedir
        // və resolver sorğuları bir neçə saniyə çəkir. Həmin pəncərədə
        // istifadəçi YENİ iş sahəsi əlavə etsə, `saveWorkspaces(next)`
        // onu SİLİRDİ (next köhnə siyahıdan törəyib). İndi yaddaşın CARİ
        // vəziyyəti əsasdır: yalnız tanıdığımız id-lər yenilənir, bu arada
        // əlavə olunanlar toxunulmur, silinənlər geri qayıtmır.
        const byId = new Map(next.map((w) => [w.id, w]))
        const merged = loadWorkspaces().map((w) => byId.get(w.id) ?? w)
        setWorkspaces(merged)
        saveWorkspaces(merged)
      }
    })()
    // Son uğursuz yeniləmə yoxlanışının səbəbi (varsa) — launcher-də göstərilir
    try {
      const raw = localStorage.getItem(UPDATE_ERR_KEY)
      if (raw) setUpdateError(String(JSON.parse(raw).msg || '').slice(0, 160))
    } catch { /* pozulmuş qeyd — əhəmiyyətsiz */ }
  }, [])

  // ✅ 2026-07-27: pəncərə ölçüsünü ZORLA təyin edən effekt SİLİNDİ.
  // Əvvəl hər renderdə 424×644-ə (bubble) salınırdı — istifadəçi böyüdə bilmirdi.
  // İndi ölçü/mövqe OS-in və istifadəçinin nəzarətindədir (adi masaüstü proqramı kimi).

  /**
   * İş sahəsini aç.
   * 🔴 Mobil: çoxpəncərəlilik yoxdur → eyni ekranda keçid (mövcud davranış).
   *    Masaüstü: öz pəncərəsində (istifadəçi qərarı), sessiyası izolə.
   */
  /**
   * 🔴 `list` PARAMETRİ MƏCBURİDİR — köhnəlmiş closure buqu (brauzerdə tutuldu).
   *
   * Əvvəl bu funksiya birbaşa `workspaces` state-ini oxuyurdu. `handleAdd`
   * yeni siyahını yadda saxlayıb DƏRHAL `openWorkspace(w)` çağırırdı, amma
   * həmin render-də `workspaces` HƏLƏ KÖHNƏ (boş) idi → `updated = []` →
   * `saveWorkspaces([])` yenicə yazılanı SİLİRDİ. Nəticə: istifadəçi ilk iş
   * sahəsini əlavə edir, o dərhal yox olur. (v0.5.0-a bu halda çıxıb.)
   */
  /**
   * İş sahəsini aç.
   *
   * ✅ 45.93 (istifadəçi): «əlavə bir pəncərə açılır target_blank tərzi.
   * olmazı ki birbaşa davam etsin?»
   *
   * İndi ADİ KLİK elə bu pəncərədə davam edir. Ayrı pəncərə yalnız ⌘/Ctrl ilə
   * klikləyəndə açılır.
   *
   * 🔴 NİYƏ HƏR İKİSİ SAXLANILIR — ayrı pəncərə şıltaqlıq deyil, SESSİYA
   * İZOLYASİYASIDIR: hər pəncərə öz davamlı login qabını alır
   * (`dataStoreIdentifier`/`dataDirectory`). Eyni pəncərədə davam edəndə
   * hamısı BİR sessiya qabını bölüşür, yəni işçi paneli ilə müştəri portalında
   * EYNİ ANDA qalmaq mümkün olmur (Frappe cookie-si origin başınadır — bu,
   * `workspaces.ts`-də 45.44 şərhində də yazılıb). Kimlik dəyişmirsə eyni
   * pəncərə heç nə itirmir; iki kimlik lazımdırsa ⌘ ilə aç.
   *
   * ⚠️ Bu pəncərə uzaq ERP ünvanına keçəndə launcher React app-ı sökülür.
   * Geri qayıdış YOLU MÖVCUDDUR: menyu çubuğundakı Olko ikonu → «İş sahələri»
   * (Rust tərəfdə `tray.on_menu_event` webview-i `?setup=1` ilə app səhifəsinə
   * qaytarır). Uzaq domendə Tauri IPC olmadığı üçün səhifə daxilindən düymə
   * qoymaq mümkün deyil — qayıdış native tərəfdən idarə olunur.
   */
  const openWorkspace = async (w: Workspace, list?: Workspace[], newWindow = false) => {
    setError('')
    setBusyId(w.id)
    // Son açılış vaxtı — launcher-də sıralama üçün
    const base = list ?? workspaces
    const updated = base.map(x => x.id === w.id ? { ...x, lastOpenedAt: Date.now() } : x)
    setWorkspaces(updated)
    saveWorkspaces(updated)

    if (IS_MOBILE || !newWindow) {
      // `assign` (`replace` yox): launcher tarixçədə qalır, yəni geri
      // naviqasiyası mümkün olan platformalarda əlavə bir çıxış yolu var.
      window.location.assign(workspaceUrl(w))
      return
    }
    const r = await openWorkspaceWindow(w)
    setBusyId(null)
    if (!r.ok) setError(r.error || 'Pəncərə açılmadı')
  }

  const handleAdd = async () => {
    setError('')
    if (!normalizeSite(siteUrl)) {
      setError('Biznes adını daxil edin')
      return
    }
    if (!newKind) {
      setError('Əvvəlcə tərəfi seçin')
      return
    }
    // 🔴 Ünvanı TƏXMİN ETMİRİK — master reyestrindən soruşuruq (bax
    //    workspaces.resolveSiteHost). Şəbəkə yoxdursa təxminə düşür.
    setResolving(true)
    const { host, portalHost } = await resolveSiteHost(siteUrl)
    setResolving(false)
    const site = host || normalizeSite(siteUrl)
    const w: Workspace = {
      id: newId(), kind: newKind, site,
      portalSite: portalHost || site,
      createdAt: Date.now(),
    }
    const next = addWorkspace(workspaces, w)
    if (next === workspaces) {
      // Eyni (sayt + tərəf) artıq var — yenisini yaratmaq əvəzinə onu aç
      const dup = workspaces.find(x => x.site === w.site && x.kind === w.kind)!
      setScreen('launcher'); setSiteUrl(''); setNewKind(null)
      void openWorkspace(dup)
      return
    }
    setWorkspaces(next)
    saveWorkspaces(next)
    setSiteUrl(''); setNewKind(null); setScreen('launcher')
    // 🔴 Yeni siyahı AÇIQ ötürülür — state hələ köhnədir (yuxarıdakı izaha bax)
    void openWorkspace(w, next)
  }

  // 🔴 «Açılacaq» sətri TƏXMİN göstərməməlidir: brauzer testində «admedia»
  //    yazanda ekranda `admedia.olkoerp.com` yazılırdı, proqram isə
  //    `control.admedia.az` açırdı — istifadəçiyə yalan məlumat.
  useEffect(() => {
    if (screen !== 'add' || !newKind || !siteUrl.trim()) {
      setPreviewHost('')
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const r = await resolveSiteHost(siteUrl)
      if (!cancelled) setPreviewHost(r.host)
    }, 450)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [siteUrl, newKind, screen])

  const removeWorkspace = (id: string) => {
    const next = workspaces.filter(x => x.id !== id)
    setWorkspaces(next)
    saveWorkspaces(next)
  }

  const handleLogout = () => {
    // Tray «Saytı dəyiş / Çıxış» → launcher-ə qayıt (iş sahələri SİLİNMİR —
    // onlar istifadəçinin qurduğu siyahıdır, sessiya deyil).
    setScreen('launcher')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void handleAdd()
  }

  // ✅ Tray menyusundan "Saytı dəyiş / Çıxış" → sessiyanı təmizlə, giriş ekranına qayıt
  useEffect(() => {
    if (IS_MOBILE) return
    let un: (() => void) | undefined
    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        un = await listen('olko://reset-session', () => { handleLogout() })
      } catch { /* brauzerdə işləyirsə tray yoxdur */ }
    })()
    return () => { if (un) un() }
  }, [])

  // Yeniləmə qapısı — yoxlama bitənə (və ya istifadəçi "Sonra" seçənə) qədər
  if (!updateChecked) return <UpdateGate onDone={() => setUpdateChecked(true)} />

  // ══════════ LAUNCHER — açılış ekranı (Faza 45.48) ══════════
  //
  // İSTİFADƏÇİ: «buranın da dizaynın mükəmməl et. anydesk tərzi nəsə».
  //
  // AnyDesk-dən götürülən İDEYA: iş sahəsi SƏTİR deyil, ÜZ-ü olan KARTdır —
  // hər biri öz görünüşü ilə tanınır (AnyDesk-də ekran şəkli, bizdə bizneslə
  // determinist rəng + monoqram), altda ünvan zolağı, üstündə vəziyyət nöqtəsi.
  // Kopyalamadığımız: AnyDesk-in qırmızı vurğusu və «Your Address» blokunun
  // ağırlığı — Olko-nun palitrası (indiqo=işçi, firuzəyi=müştəri) saxlanılır.
  if (screen === 'launcher') {
    const sorted = [...workspaces].sort(
      (a, b) => (b.lastOpenedAt || b.createdAt) - (a.lastOpenedAt || a.createdAt))

    return (
      <div style={{ ...styles.shell, ...(IS_MOBILE ? mobileOuter : {}) }}>
        {/* ─── Başlıq zolağı ─── */}
        <header style={styles.topBar}>
          <div style={styles.brand}>
            <img src={olkoLogo} alt="" style={styles.brandLogo} />
            <div>
              <div style={styles.brandName}>Olko ERP</div>
              <div style={styles.brandSub}>
                {sorted.length
                  ? `${sorted.length} iş sahəsi`
                  : 'İlk iş sahənizi əlavə edin'}
              </div>
            </div>
          </div>
          <button style={styles.topAdd} onClick={() => { setError(''); setScreen('add') }}>
            <span style={styles.topAddPlus}>+</span> Yeni iş sahəsi
          </button>
        </header>

        {/* ─── Kart şəbəkəsi ─── */}
        <main style={styles.board}>
          {sorted.length === 0 && (
            <div style={styles.emptyBox}>
              <div style={styles.emptyIcon}>◳</div>
              <p style={styles.emptyTitle}>Hələ iş sahəsi yoxdur</p>
              <p style={styles.emptyText}>
                Biznesinizi əlavə edin — işçi paneli və müştəri portalı ayrı-ayrı
                pəncərələrdə açılacaq.
              </p>
              <button style={styles.emptyBtn} onClick={() => { setError(''); setScreen('add') }}>
                Başlayaq
              </button>
            </div>
          )}

          {sorted.length > 0 && (
            /* ─── İKİ SÜTUN ───────────────────────────────────────────────
               İstifadəçi: «bu şeyi 2 sütuna ayır… sağ sütunda portallar olsun».

               Niyə vacibdir: kart üzündə cəmi kiçik bir etiket («İstifadəçi» /
               «Müştəri») fərqi daşıyırdı, ünvan isə eyni brendin iki hostu
               olduğu üçün ekranda ADM · ADM görünürdü. Yəni fərqi oxumaq üçün
               kartı diqqətlə süzmək lazım idi. İndi fərq YERdən oxunur —
               sütun başlığı sualı əvvəlcədən cavablandırır.

               Hər sütunun öz «+» kartı var və o, tərəfi ƏVVƏLCƏDƏN seçir:
               portal sütunundan əlavə edəndə yenidən «müştəri?» soruşmaq
               istifadəçinin onsuz da verdiyi cavabı təkrar istəmək olardı. */
            <div style={styles.columns}>
              {([
                { kind: 'user' as WorkspaceKind, title: 'İstifadəçi',
                  hint: 'Şirkət işçisi — ERP paneli', accent: '#4f46e5',
                  surface: 'rgba(79,70,229,0.045)', edge: 'rgba(79,70,229,0.16)' },
                { kind: 'portal' as WorkspaceKind, title: 'Müştəri portalı',
                  hint: 'Sifariş və hesablar', accent: '#0d9488',
                  surface: 'rgba(13,148,136,0.05)', edge: 'rgba(13,148,136,0.18)' },
              ]).map(col => {
                const items = sorted.filter(w => w.kind === col.kind)
                return (
                  <section
                    key={col.kind}
                    style={{
                      ...styles.column,
                      background: col.surface,
                      border: `1px solid ${col.edge}`,
                    }}
                  >
                    <div style={{ ...styles.colHead, borderBottomColor: col.edge }}>
                      <span style={{ ...styles.colDot, background: col.accent }} />
                      <span style={styles.colTitle}>{col.title}</span>
                      <span style={styles.colCount}>{items.length}</span>
                      <span style={styles.colHint}>{col.hint}</span>
                    </div>

                    <div style={styles.grid}>
                      {items.map(w => {
                        const host = w.kind === 'portal' ? (w.portalSite || w.site) : w.site
                        const isOpen = openLabels.includes(`ws-${w.id}`)
                        const busy = busyId === w.id
                        return (
                          <div key={w.id} style={styles.card}>
                            <button
                              style={{ ...styles.cardMain, opacity: busy ? 0.55 : 1 }}
                              onClick={(e) => void openWorkspace(w, undefined, e.metaKey || e.ctrlKey)}
                              disabled={busy}
                              title={`${host}\n${isMac() ? '⌘' : 'Ctrl'} + klik — ayrı pəncərədə (iki kimlikdə eyni anda qalmaq üçün)`}
                            >
                              {/* Üz — determinist rəng + monoqram */}
                              <div style={{ ...styles.cover, background: coverGradient(brandKey(w.site)) }}>
                                <span style={styles.monogram}>{monogram(w.label || w.site)}</span>
                                <span style={{
                                  ...styles.dot,
                                  background: isOpen ? '#22c55e' : 'rgba(255,255,255,0.55)',
                                  boxShadow: isOpen ? '0 0 0 3px rgba(34,197,94,0.25)' : 'none',
                                }} />
                                {/* 🔴 Kartdakı tərəf etiketi SİLİNDİ — sütun başlığı
                                    onsuz da deyir. İki yerdə eyni sözü yazmaq
                                    kartın üzündəki yeri boş yerə tuturdu. */}
                              </div>

                              {/* Ünvan zolağı */}
                              <div style={styles.cardFoot}>
                                <span style={styles.cardHost}>{w.label || host}</span>
                                <span style={styles.cardMeta}>
                                  {busy ? 'açılır…' : isOpen ? 'açıqdır' : lastSeen(w.lastOpenedAt)}
                                </span>
                              </div>
                            </button>

                            <button
                              style={styles.cardRemove}
                              title="Siyahıdan sil"
                              onClick={() => removeWorkspace(w.id)}
                            >×</button>
                          </div>
                        )
                      })}

                      {/* Sütunun öz əlavəetmə kartı — tərəf əvvəlcədən seçilir */}
                      <button
                        style={styles.addCard}
                        onClick={() => { setError(''); setNewKind(col.kind); setScreen('add') }}
                      >
                        <span style={styles.addCardPlus}>+</span>
                        <span style={styles.addCardText}>
                          {col.kind === 'portal' ? 'Portal əlavə et' : 'İş sahəsi əlavə et'}
                        </span>
                      </button>
                    </div>
                  </section>
                )
              })}
            </div>
          )}

          {!IS_MOBILE && workspaces.length > 0 && (
            /* ✅ 45.93 — iki şey kəşf edilə bilən olmalıdır:
               ① adi klik artıq elə bu pəncərədə davam edir, ayrı pəncərə ⌘ ilədir;
               ② pəncərə uzaq ERP-yə keçəndən sonra launcher React app-ı sökülür və
                  geri qayıdış YALNIZ native tray menyusundadır — uzaq domendə Tauri
                  IPC olmadığı üçün səhifə daxilində düymə qoymaq mümkün deyil. */
            <div style={styles.tips}>
              {/* 🔴 Platformaya görə AYRI mətn. Funksionallıq hər ikisində eynidir
                  (tray menyusu `#[cfg(desktop)]` blokundadır və Rust Windows üçün
                  ayrıca `http://tauri.localhost/?setup=1` ünvanı işlədir), LAKİN
                  istifadəçiyə verilən təlimat fərqlidir:
                    macOS   → yuxarıdakı menyu çubuğu, adi klik
                    Windows → saat yanındakı bildiriş sahəsi, SAĞ klik
                  «menyu çubuğu» Windows-da ümumiyyətlə yoxdur — ilk yazılışımda
                  yalnız Mac variantını yazmışdım. */}
              <span><b>{isMac() ? '⌘' : 'Ctrl'} + klik</b> — ayrı pəncərədə açır (işçi paneli və portalda eyni anda qalmaq üçün).</span>
              <span>
                Geri qayıtmaq: {isMac()
                  ? <>menyu çubuğundakı <b>Olko</b> ikonu → <b>«İş sahələri»</b></>
                  : <>saat yanındakı <b>Olko</b> ikonuna <b>sağ klik</b> → <b>«İş sahələri»</b></>}.
              </span>
            </div>
          )}

          {error && <div style={styles.error}>{error}</div>}

          {updateError && (
            <p style={{ ...styles.note, color: '#b45309', textAlign: 'center' }}>
              Yeniləmə yoxlanışı alınmadı: {updateError}
            </p>
          )}

          {/* 🔴 45.46: yalnız EYNİ hostu paylaşan işçi+müştəri cütü varsa */}
          {!IS_MOBILE && !isolationSupported() && (() => {
            const hostOf = (w: Workspace) => w.kind === 'portal' ? (w.portalSite || w.site) : w.site
            const users = workspaces.filter(w => w.kind === 'user').map(hostOf)
            return workspaces.filter(w => w.kind === 'portal').map(hostOf).some(p => users.includes(p))
          })() && (
            <p style={{ ...styles.note, textAlign: 'center' }}>
              Bu sistemdə iş sahələri eyni sessiyanı paylaşır — eyni biznesdə
              ikinci tərəfə keçəndə birincidən çıxış olur.
              {isolationFailureReason() && (
                <><br /><span style={{ opacity: 0.75 }}>Səbəb: {isolationFailureReason()}</span></>
              )}
            </p>
          )}
        </main>
      </div>
    )
  }

  // ══════════ YENİ İŞ SAHƏSİ — əvvəl TƏRƏF, sonra biznes ══════════
  if (screen === 'add') {
    return (
      <div style={{ ...styles.shell, ...(IS_MOBILE ? mobileOuter : {}) }}>
        <header style={styles.topBar}>
          <div style={styles.brand}>
            <img src={olkoLogo} alt="" style={styles.brandLogo} />
            <div>
              <div style={styles.brandName}>Yeni iş sahəsi</div>
              <div style={styles.brandSub}>
                {newKind ? 'Biznes adını daxil edin' : 'Hansı tərəfdən daxil olursunuz?'}
              </div>
            </div>
          </div>
          <button
            style={styles.topGhost}
            onClick={() => { setError(''); setNewKind(null); setSiteUrl(''); setScreen('launcher') }}
          >
            ← Geri
          </button>
        </header>

        <main style={{ ...styles.board, alignItems: 'center' }}>
          <div style={styles.addPanel}>
            {/* Addım 1 — tərəf */}
            <div style={styles.kindRow}>
              {(['user', 'portal'] as WorkspaceKind[]).map(k => (
                <button
                  key={k}
                  style={{
                    ...styles.kindBtn,
                    ...(newKind === k
                      ? (k === 'portal' ? styles.kindBtnActivePortal : styles.kindBtnActiveUser)
                      : {}),
                  }}
                  onClick={() => { setError(''); setNewKind(k) }}
                >
                  <span style={{
                    ...styles.kindDot,
                    background: k === 'portal' ? '#0d9488' : '#4f46e5',
                  }} />
                  <span style={styles.kindTitle}>{k === 'user' ? 'İstifadəçi' : 'Müştəri'}</span>
                  <span style={styles.kindSub}>
                    {k === 'user' ? 'Şirkət işçisi — ERP paneli' : 'Portal — sifariş və hesablar'}
                  </span>
                </button>
              ))}
            </div>

            {/* Addım 2 — biznes adı */}
            {newKind && (
              <div style={styles.field}>
                <label style={styles.label}>Biznes adı</label>
                <input
                  style={styles.input}
                  type="text"
                  placeholder="biznesiniz"
                  value={siteUrl}
                  onChange={e => setSiteUrl(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoFocus
                />
                {siteUrl.trim() && (
                  <p style={styles.note}>
                    Açılacaq: {workspaceUrl({
                      id: '', kind: newKind, site: previewHost || normalizeSite(siteUrl), createdAt: 0,
                    })}
                  </p>
                )}
              </div>
            )}

            {error && <div style={styles.error}>{error}</div>}

            <button
              style={{
                ...styles.primaryBtn,
                opacity: newKind && !resolving ? 1 : 0.5,
                cursor: newKind && !resolving ? 'pointer' : 'not-allowed',
              }}
              onClick={() => void handleAdd()}
              disabled={!newKind || resolving}
            >
              {resolving ? 'Yoxlanılır…' : 'Əlavə et və aç'}
            </button>
          </div>
        </main>
      </div>
    )
  }


  // ✅ 2026-07-27: iframe-li "app ekranı" SİLİNDİ — `location.replace` ilə ERP-yə
  // keçdikdən sonra bu React tətbiqi ümumiyyətlə yüklü qalmır. Ona görə iframe,
  // session state və sürətli naviqasiya kodu ölü idi.
  return null
}

// Mobil-də üzən kart yerinə tam-ekran görünüş
const mobileOuter: React.CSSProperties = { padding: 0 }

const styles: Record<string, React.CSSProperties> = {
  // ═══ Faza 45.48 — AnyDesk tərzi konsol görünüşü ═══
  // Palitra QƏSDƏN Olko-nundur: indiqo (işçi) + firuzəyi (müştəri).
  // AnyDesk-in qırmızısı götürülməyib — bu, bizim məhsulun kimliyidir.
  shell: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%)',
    color: '#0f172a',
  },
  topBar: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '14px 20px',
    background: 'rgba(255,255,255,0.72)',
    borderBottom: '1px solid rgba(15,23,42,0.07)',
    backdropFilter: 'blur(8px)',
  },
  brand: { display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 },
  brandLogo: { width: 34, height: 34, objectFit: 'contain' as const, flexShrink: 0 },
  brandName: { fontSize: 15, fontWeight: 700, letterSpacing: -0.2, color: '#0f172a' },
  brandSub: { fontSize: 11.5, color: '#64748b', marginTop: 1 },
  topAdd: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '8px 14px',
    borderRadius: 10,
    border: 'none',
    background: '#4f46e5',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    font: 'inherit',
    boxShadow: '0 1px 2px rgba(79,70,229,0.35)',
  },
  topAddPlus: { fontSize: 15, lineHeight: 1, marginTop: -1 },
  topGhost: {
    flexShrink: 0,
    padding: '8px 14px',
    borderRadius: 10,
    border: '1px solid rgba(15,23,42,0.10)',
    background: '#fff',
    color: '#475569',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    font: 'inherit',
  },
  board: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: '22px 20px 28px',
  },

  // ─── İki sütun (45.66) ───
  columns: {
    display: 'grid',
    // Dar pəncərədə (və mobil) alt-alta düşür — sıxılmış iki sütun
    // 190px-lik kartları oxunmaz edərdi.
    gridTemplateColumns: IS_MOBILE ? '1fr' : 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: 22,
    alignItems: 'start',
  },
  /* 🔴 45.67 — İstifadəçi: «araya sərhəd qoyardın da və ya iki tərəfin arxa fon
     rəngini fərqli edərdin». İkisi birlikdə: hər sütun öz çalarında PANELdir.
     Niyə şaquli xətt yox: dar pəncərədə sütunlar alt-alta düşür və oradakı
     şaquli sərhəd mənasız olardı — panel isə hər iki düzülüşdə işləyir.
     Çalar çox zəifdir (≈5%): kartlar öz rənglərini saxlamalıdır, panel yalnız
     sahəni müəyyən edir. */
  column: {
    display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0,
    padding: 14, borderRadius: 16,
  },
  colHead: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '0 2px 10px',
    borderBottom: '1px solid rgba(15,23,42,0.08)',
  },
  colDot: { width: 8, height: 8, borderRadius: 999, flexShrink: 0 },
  colTitle: { fontSize: 13, fontWeight: 700, color: '#0f172a', letterSpacing: -0.1 },
  colCount: {
    fontSize: 11, fontWeight: 700, color: '#475569',
    background: 'rgba(15,23,42,0.06)', borderRadius: 999, padding: '1px 7px',
    fontVariantNumeric: 'tabular-nums',
  },
  colHint: { fontSize: 11, color: '#94a3b8', marginLeft: 'auto', whiteSpace: 'nowrap' },
  tips: {
    display: 'flex', flexDirection: 'column', gap: 4, marginTop: 18,
    padding: '10px 12px', borderRadius: 10, background: 'rgba(148,163,184,0.10)',
    border: '1px solid rgba(148,163,184,0.22)', fontSize: 11.5, color: '#64748b',
  } as React.CSSProperties,

  // ─── Kart şəbəkəsi ───
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
    gap: 16,
    alignContent: 'start',
  },
  card: { position: 'relative', minWidth: 0 },
  cardMain: {
    width: '100%',
    display: 'block',
    padding: 0,
    borderRadius: 14,
    overflow: 'hidden',
    border: '1px solid rgba(15,23,42,0.09)',
    background: '#fff',
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
    boxShadow: '0 1px 2px rgba(15,23,42,0.06), 0 8px 20px -12px rgba(15,23,42,0.25)',
    transition: 'transform 0.14s ease, box-shadow 0.14s ease',
  },
  cover: {
    position: 'relative',
    height: 104,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  monogram: {
    fontSize: 26,
    fontWeight: 800,
    letterSpacing: 1,
    color: 'rgba(255,255,255,0.94)',
    textShadow: '0 1px 10px rgba(0,0,0,0.28)',
    userSelect: 'none',
  },
  dot: {
    position: 'absolute',
    top: 9,
    left: 9,
    width: 8,
    height: 8,
    borderRadius: '50%',
  },
  cardFoot: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '9px 11px 11px',
    minWidth: 0,
  },
  cardHost: {
    fontSize: 12.5,
    fontWeight: 650,
    color: '#0f172a',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardMeta: { fontSize: 10.5, color: '#94a3b8' },
  cardRemove: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 7,
    border: 'none',
    background: 'rgba(15,23,42,0.35)',
    color: '#fff',
    fontSize: 14,
    lineHeight: '20px',
    cursor: 'pointer',
    font: 'inherit',
  },
  addCard: {
    minHeight: 160,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 14,
    border: '1.5px dashed rgba(15,23,42,0.18)',
    background: 'rgba(255,255,255,0.5)',
    color: '#64748b',
    cursor: 'pointer',
    font: 'inherit',
  },
  addCardPlus: { fontSize: 24, lineHeight: 1, color: '#94a3b8' },
  addCardText: { fontSize: 12, fontWeight: 600 },

  // ─── Boş vəziyyət ───
  emptyBox: {
    margin: 'auto',
    maxWidth: 380,
    textAlign: 'center' as const,
    padding: '28px 24px',
    borderRadius: 16,
    background: '#fff',
    border: '1px solid rgba(15,23,42,0.08)',
    boxShadow: '0 10px 30px -18px rgba(15,23,42,0.35)',
  },
  emptyIcon: { fontSize: 26, color: '#cbd5e1', marginBottom: 6 },
  emptyTitle: { fontSize: 15, fontWeight: 700, margin: '0 0 6px' },
  emptyText: { fontSize: 12.5, color: '#64748b', lineHeight: 1.5, margin: '0 0 16px' },
  emptyBtn: {
    padding: '9px 20px',
    borderRadius: 10,
    border: 'none',
    background: '#4f46e5',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    font: 'inherit',
  },

  // ─── Əlavəetmə paneli ───
  addPanel: {
    width: '100%',
    maxWidth: 460,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: 20,
    borderRadius: 16,
    background: '#fff',
    border: '1px solid rgba(15,23,42,0.08)',
    boxShadow: '0 10px 30px -18px rgba(15,23,42,0.35)',
  },
  kindRow: { display: 'flex', gap: 10 },
  kindBtn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '13px 12px',
    borderRadius: 12,
    border: '1.5px solid rgba(15,23,42,0.10)',
    background: '#fff',
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
  },
  kindBtnActiveUser: {
    borderColor: '#4f46e5',
    boxShadow: '0 0 0 3px rgba(79,70,229,0.12)',
    background: '#f5f4ff',
  },
  kindBtnActivePortal: {
    borderColor: '#0d9488',
    boxShadow: '0 0 0 3px rgba(13,148,136,0.12)',
    background: '#f0fdfa',
  },
  kindDot: { width: 7, height: 7, borderRadius: '50%', marginBottom: 2 },
  kindTitle: { fontSize: 13.5, fontWeight: 700, color: '#0f172a' },
  kindSub: { fontSize: 11, color: '#64748b', lineHeight: 1.35 },
  field: { display: 'flex', flexDirection: 'column' as const, gap: 5 },
  label: {
    fontSize: 10.5,
    fontWeight: 700,
    color: '#64748b',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.6,
  },
  input: {
    padding: '10px 12px',
    border: '1.5px solid #e2e8f0',
    borderRadius: 10,
    fontSize: 14,
    outline: 'none',
    background: '#f8fafc',
    font: 'inherit',
  },
  primaryBtn: {
    padding: '11px',
    border: 'none',
    borderRadius: 10,
    background: '#4f46e5',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    font: 'inherit',
    boxShadow: '0 1px 2px rgba(79,70,229,0.35)',
  },

  note: { fontSize: 11.5, color: '#64748b', margin: '4px 0 0', lineHeight: 1.45 },
  error: {
    background: '#fef2f2',
    color: '#dc2626',
    padding: '9px 12px',
    borderRadius: 10,
    fontSize: 12,
    textAlign: 'center' as const,
    border: '1px solid #fecaca',
  },
}

export default App
