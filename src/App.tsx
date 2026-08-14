import { useState, useEffect } from 'react'
import olkoLogo from './assets/olko-logo.png'
import UpdateGate, { UPDATE_ERR_KEY } from './UpdateGate'
import './index.css'
import {
  addWorkspace, loadWorkspaces, newId, normalizeSite, saveWorkspaces,
  resolveSiteHost, workspaceUrl, type Workspace, type WorkspaceKind,
} from './workspaces'
import { isolationFailureReason, isolationSupported, openWorkspaceWindow } from './openWorkspace'

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

  useEffect(() => {
    // 🔴 Faza 1.0: AVTOMATİK KEÇİD YOXDUR. Əvvəl saxlanmış sayt varsa app
    // birbaşa ora keçirdi; istifadəçi isə açılışda seçim istədi. Köhnə yaddaş
    // `loadWorkspaces()` içində iş sahəsinə çevrilir — heç nə itmir.
    const loaded = loadWorkspaces()
    setWorkspaces(loaded)
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
  const openWorkspace = async (w: Workspace, list?: Workspace[]) => {
    setError('')
    setBusyId(w.id)
    // Son açılış vaxtı — launcher-də sıralama üçün
    const base = list ?? workspaces
    const updated = base.map(x => x.id === w.id ? { ...x, lastOpenedAt: Date.now() } : x)
    setWorkspaces(updated)
    saveWorkspaces(updated)

    if (IS_MOBILE) {
      window.location.replace(workspaceUrl(w))
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

  // ══════════ LAUNCHER — açılış ekranı ══════════
  if (screen === 'launcher') {
    const sorted = [...workspaces].sort(
      (a, b) => (b.lastOpenedAt || b.createdAt) - (a.lastOpenedAt || a.createdAt))
    return (
      <div style={{ ...styles.bubbleOuter, ...(IS_MOBILE ? mobileOuter : {}) }}>
        <div style={{ ...styles.bubble, ...(IS_MOBILE ? mobileBubble : {}), maxWidth: 560 }}>
          <div style={styles.loginContent}>
            <div style={styles.logoSection}>
              <img src={olkoLogo} alt="Olko ERP" style={styles.logoIcon} />
              <h1 style={styles.logoText}>Olko ERP</h1>
              <p style={styles.subtitle}>
                {sorted.length ? 'İş sahəsi seçin' : 'İlk iş sahənizi əlavə edin'}
              </p>
            </div>

            <div style={styles.form}>
              {sorted.map(w => (
                <div key={w.id} style={styles.wsRow}>
                  <button
                    style={{ ...styles.wsCard, opacity: busyId === w.id ? 0.6 : 1 }}
                    onClick={() => void openWorkspace(w)}
                    disabled={busyId === w.id}
                  >
                    <span style={{
                      ...styles.wsBadge,
                      background: w.kind === 'portal' ? '#0f766e' : '#4f46e5',
                    }}>
                      {w.kind === 'portal' ? 'Müştəri' : 'İstifadəçi'}
                    </span>
                    <span style={styles.wsSite}>{w.label || w.site}</span>
                    {busyId === w.id && <span style={styles.wsHint}>açılır…</span>}
                  </button>
                  <button
                    style={styles.wsRemove}
                    title="Siyahıdan sil"
                    onClick={() => removeWorkspace(w.id)}
                  >×</button>
                </div>
              ))}

              {error && <div style={styles.error}>{error}</div>}

              <button style={styles.button} onClick={() => { setError(''); setScreen('add') }}>
                + Yeni iş sahəsi
              </button>

              {/* 🔴 2026-08-14: yeniləmə yoxlanışı uğursuz olubsa SƏBƏBİ göstər.
                  İstifadəçi «Windows-da yenilənmə getmədi» dedi və heç bir iz
                  yox idi — `UpdateGate` xətanı səssizcə udurdu. İndi son xəta
                  burada görünür ki, növbəti dəfə təxmin yox, FAKT olsun. */}
              {updateError && (
                <p style={{ ...styles.note, color: '#b45309' }}>
                  Yeniləmə yoxlanışı alınmadı: {updateError}
                </p>
              )}

              {/* 🔴 Xəbərdarlıq TƏXMİNƏ görə yox, SINAQ NƏTİCƏSİNƏ görə çıxır:
                  `openWorkspace.ts` izolyasiyalı açmağı bir dəfə sınayır və
                  platforma dəstəkləmirsə bunu yadda saxlayır. Əvvəlki
                  versiyada macOS versiyasını user-agent-dən oxuyurdum — brauzer
                  onu `10_15_7` kimi dondurduğu üçün xəbərdarlıq HƏMİŞƏ
                  görünürdü və izolyasiya lazımsız yerə söndürülürdü. */}
              {/* 🔴 45.46: xəbərdarlıq yalnız EYNİ hostu paylaşan işçi+müştəri
                  cütü varsa göstərilir. Portal ayrı hostdadırsa (portal.admedia.az)
                  sessiyalar onsuz da brauzer qaydası ilə ayrıdır — köhnə ümumi
                  xəbərdarlıq istifadəçini «hələ də qarışır» deyə çaşdırırdı. */}
              {!IS_MOBILE && !isolationSupported() && (() => {
                const hosts = (w: Workspace) => w.kind === 'portal' ? (w.portalSite || w.site) : w.site
                const users = workspaces.filter(w => w.kind === 'user').map(hosts)
                const portals = workspaces.filter(w => w.kind === 'portal').map(hosts)
                return portals.some(p => users.includes(p))
              })() && (
                <p style={styles.note}>
                  Bu sistemdə iş sahələri eyni sessiyanı paylaşır — eyni
                  biznesdə ikinci tərəfə keçəndə birincidən çıxış olur.
                  {isolationFailureReason() && (
                    <><br /><span style={{ opacity: 0.75 }}>Səbəb: {isolationFailureReason()}</span></>
                  )}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ══════════ YENİ İŞ SAHƏSİ — əvvəl TƏRƏF, sonra biznes ══════════
  if (screen === 'add') {
    return (
      <div style={{ ...styles.bubbleOuter, ...(IS_MOBILE ? mobileOuter : {}) }}>
        <div style={{ ...styles.bubble, ...(IS_MOBILE ? mobileBubble : {}) }}>
          <div style={styles.loginContent}>
            <div style={styles.logoSection}>
              <img src={olkoLogo} alt="Olko ERP" style={styles.logoIcon} />
              <h1 style={styles.logoText}>Yeni iş sahəsi</h1>
              <p style={styles.subtitle}>
                {newKind ? 'Biznes adını daxil edin' : 'Hansı tərəfdən daxil olursunuz?'}
              </p>
            </div>

            <div style={styles.form}>
              {/* Addım 1 — tərəf */}
              <div style={styles.kindRow}>
                {(['user', 'portal'] as WorkspaceKind[]).map(k => (
                  <button
                    key={k}
                    style={{
                      ...styles.kindBtn,
                      ...(newKind === k ? styles.kindBtnActive : {}),
                    }}
                    onClick={() => { setError(''); setNewKind(k) }}
                  >
                    <span style={styles.kindTitle}>
                      {k === 'user' ? 'İstifadəçi' : 'Müştəri'}
                    </span>
                    <span style={styles.kindSub}>
                      {k === 'user' ? 'Şirkət işçisi — ERP' : 'Portal — sifariş və hesablar'}
                    </span>
                  </button>
                ))}
              </div>

              {/* Addım 2 — biznes adı (yalnız tərəf seçiləndən sonra) */}
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
                style={{ ...styles.button, opacity: newKind ? 1 : 0.5,
                         cursor: newKind ? 'pointer' : 'not-allowed' }}
                onClick={() => void handleAdd()}
                disabled={!newKind || resolving}
              >
                {resolving ? 'Yoxlanılır…' : 'Əlavə et və aç'}
              </button>
              <button
                style={styles.linkBtn}
                onClick={() => { setError(''); setNewKind(null); setSiteUrl(''); setScreen('launcher') }}
              >
                Geri
              </button>
            </div>
          </div>
        </div>
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
const mobileBubble: React.CSSProperties = { borderRadius: 0, border: 'none', boxShadow: 'none' }

const styles: Record<string, React.CSSProperties> = {
  // ✅ 2026-07-27: ERP ekranı TAM PƏNCƏRƏNİ doldurur.
  // Əvvəl giriş kartı ilə eyni `bubble` stilini işlədirdi (maxWidth 420) →
  // 1440px pəncərədə ERP ortada kiçik kartda görünürdü ("proqram içində proqram").
  appOuter: {
    height: '100%',
    display: 'flex',
    background: '#ffffff',
  },
  appShell: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    background: '#ffffff',
  },
  bubbleOuter: {
    // ✅ Normal pəncərədə giriş kartı ortada dayanır (əvvəl 424px bubble-ı doldururdu)
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: '#f1f5f9',
  },
  bubble: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '92%',
    display: 'flex',
    flexDirection: 'column',
    background: '#ffffff',
    borderRadius: 20,
    overflow: 'hidden',
    boxShadow: '0 12px 48px rgba(0,0,0,0.25), 0 4px 16px rgba(0,0,0,0.1)',
    border: '1px solid rgba(0,0,0,0.08)',
  },
  // Drag bar
  dragBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 10px',
    background: '#f8fafc',
    borderBottom: '1px solid #f1f5f9',
    flexShrink: 0,
    cursor: 'grab',
    userSelect: 'none',
  },
  dragDots: {
    display: 'flex',
    gap: 5,
    padding: '4px 2px',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#cbd5e1',
  },
  dragActions: {
    display: 'flex',
    gap: 4,
  },
  controlBtn: {
    width: 26,
    height: 26,
    borderRadius: 8,
    border: 'none',
    background: 'transparent',
    color: '#94a3b8',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
  },
  headerInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
  },
  headerLogoBadge: {
    width: 22,
    height: 22,
    objectFit: 'contain' as const,
  },
  headerLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: '#64748b',
  },
  // Login
  loginContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: '24px 28px 32px',
    overflow: 'auto',
  },
  logoSection: {
    textAlign: 'center' as const,
    marginBottom: 28,
  },
  logoIcon: {
    width: 60,
    height: 60,
    objectFit: 'contain' as const,
    marginBottom: 10,
  },
  logoText: {
    fontSize: 20,
    fontWeight: 700,
    color: '#1e293b',
    margin: '0 0 4px',
  },
  subtitle: {
    fontSize: 13,
    color: '#94a3b8',
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 14,
  },
  field: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 5,
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    color: '#64748b',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  input: {
    padding: '9px 12px',
    border: '1.5px solid #e2e8f0',
    borderRadius: 10,
    fontSize: 14,
    outline: 'none',
    transition: 'border-color 0.2s',
    background: '#f8fafc',
  },
  // ── Faza 1.0: iş sahəsi kartları ──
  wsRow: { display: 'flex', alignItems: 'stretch', gap: 8 },
  wsCard: {
    flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0,
    padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(0,0,0,0.10)',
    background: '#ffffff', cursor: 'pointer', textAlign: 'left', font: 'inherit',
  },
  wsBadge: {
    flexShrink: 0, color: '#fff', fontSize: 11, fontWeight: 700,
    padding: '3px 8px', borderRadius: 999, letterSpacing: 0.2,
  },
  wsSite: {
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', fontSize: 14, color: '#0f172a', fontWeight: 600,
  },
  wsHint: { flexShrink: 0, fontSize: 12, color: '#64748b' },
  wsRemove: {
    flexShrink: 0, width: 36, borderRadius: 12, border: '1px solid rgba(0,0,0,0.10)',
    background: '#ffffff', color: '#94a3b8', fontSize: 18, cursor: 'pointer',
  },
  kindRow: { display: 'flex', gap: 10 },
  kindBtn: {
    flex: 1, display: 'flex', flexDirection: 'column', gap: 4, padding: '14px 12px',
    borderRadius: 12, border: '1px solid rgba(0,0,0,0.10)', background: '#ffffff',
    cursor: 'pointer', textAlign: 'left', font: 'inherit',
  },
  kindBtnActive: { borderColor: '#4f46e5', boxShadow: '0 0 0 3px rgba(79,70,229,0.12)' },
  kindTitle: { fontSize: 14, fontWeight: 700, color: '#0f172a' },
  kindSub: { fontSize: 11.5, color: '#64748b', lineHeight: 1.35 },
  note: { fontSize: 11.5, color: '#64748b', margin: '6px 0 0', lineHeight: 1.4 },
  linkBtn: {
    background: 'none', border: 'none', color: '#64748b', fontSize: 13,
    cursor: 'pointer', padding: 6, font: 'inherit',
  },
  error: {
    background: '#fef2f2',
    color: '#dc2626',
    padding: '8px 12px',
    borderRadius: 8,
    fontSize: 12,
    textAlign: 'center' as const,
  },
  button: {
    padding: '11px',
    border: 'none',
    borderRadius: 10,
    background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 2,
    boxShadow: '0 2px 10px rgba(79, 70, 229, 0.3)',
  },
  // Nav bar
  navBar: {
    display: 'flex',
    gap: 0,
    background: '#fff',
    borderBottom: '1px solid #f1f5f9',
    flexShrink: 0,
  },
  navBtn: {
    flex: 1,
    padding: '8px 4px',
    border: 'none',
    background: '#fff',
    fontSize: 16,
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
  // iframe
  iframe: {
    flex: 1,
    border: 'none',
    width: '100%',
    // Kart yuvarlaqlığı GÖTÜRÜLDÜ — ERP artıq tam pəncərəni doldurur
    borderRadius: 0,
  },
}

export default App
