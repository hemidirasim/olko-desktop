import { useState, useEffect } from 'react'
import olkoLogo from './assets/olko-logo.png'
import UpdateGate from './UpdateGate'
import './index.css'

type Screen = 'login' | 'app'

// ✅ 2026-07-17 Android dəstəyi: mobil-də pəncərə API-ləri (resize/hide/drag) yoxdur —
// tam-ekran rejim, bubble/collapse yalnız desktop-da
const IS_MOBILE = /android|iphone|ipad/i.test(navigator.userAgent)

function App() {
  // ✅ 2026-07-27: proqram açılanda ƏVVƏL yeniləmə yoxlanır (uzaq domenə keçəndən sonra
  // Tauri plagin API-ləri əlçatan olmur → yoxlama məhz burada aparılmalıdır).
  const [updateChecked, setUpdateChecked] = useState(false)
  const [screen, setScreen] = useState<Screen>('login')
  const [siteUrl, setSiteUrl] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // ✅ 2026-07-27: hər iki platformada EYNİ məntiq — app yalnız sayt seçicisidir.
    // Tray menyusundan "Saytı dəyiş" seçiləndə Rust bizi `?setup=1` ilə geri gətirir;
    // o halda avtomatik keçid ETMİRİK, seçim ekranını göstəririk.
    const wantsSetup = new URLSearchParams(window.location.search).has('setup')
    const lastSite = localStorage.getItem('olko_last_site')

    if (wantsSetup) {
      localStorage.removeItem('olko_last_site')
      if (lastSite) setSiteUrl(lastSite.replace(/^https?:\/\//, '').replace(/\.olkoerp\.com$/, ''))
      return
    }
    if (lastSite) {
      // Saxlanmış sayt var → birbaşa ERP-yə keç (ERP öz login-ini göstərəcək,
      // sessiya varsa heç nə soruşmayacaq — brauzerdəki kimi).
      setLoading(true)
      window.location.replace(lastSite)
      return
    }
  }, [])

  // ✅ 2026-07-27: pəncərə ölçüsünü ZORLA təyin edən effekt SİLİNDİ.
  // Əvvəl hər renderdə 424×644-ə (bubble) salınırdı — istifadəçi böyüdə bilmirdi.
  // İndi ölçü/mövqe OS-in və istifadəçinin nəzarətindədir (adi masaüstü proqramı kimi).

  const normalizeSiteUrl = (raw: string): string => {
    // ✅ 2026-07-18: istifadəçi biznes adını yazır (məs. "qurman") — nöqtəsiz gələn dəyər
    // avtomatik `{ad}.olkoerp.com`-a çevrilir. Nöqtəli (tam domen, məs. custom domain
    // "erp.admedia.az" və ya "qurman.olkoerp.com") olduğu kimi qəbul olunur.
    let s = raw.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    if (s && !s.includes('.')) s = `${s}.olkoerp.com`
    return `https://${s}`
  }

  const handleLogin = () => {
    setError('')
    // ✅ 2026-07-27: MASAÜSTÜ də mobil ilə EYNİ modelə keçdi — app yalnız SAYT SEÇİCİSİDİR.
    //
    // Əvvəl masaüstündə app `fetch` ilə login edib ERP-ni IFRAME-də açırdı. İframe
    // cross-site olduğu üçün brauzer üçüncü-tərəf cookie-ni bloklayır → ERP sessiyanı
    // tanımır və ÖZ login səhifəsini yenidən göstərirdi (istifadəçi iki dəfə şifrə yazırdı).
    // Mobil bu problemi 2026-07-18-də top-level naviqasiya ilə həll etmişdi; indi masaüstü
    // də eynidir: yalnız biznes adı soruşulur, autentifikasiyanı ERP-nin öz first-party
    // login-i idarə edir → TƏK giriş.
    if (!siteUrl.trim()) {
      setError('Biznes adını daxil edin')
      return
    }
    const base = normalizeSiteUrl(siteUrl)
    localStorage.setItem('olko_last_site', base)
    setLoading(true)
    // replace() — giriş ekranı tarixçədən çıxır (geri düyməsi ora qayıtmasın)
    window.location.replace(base)
  }

  const handleLogout = () => {
    // Tray "Saytı dəyiş / Çıxış" → saxlanmış saytı unut, seçim ekranına qayıt
    localStorage.removeItem('olko_last_site')
    setScreen('login')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleLogin()
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

  // Login screen
  if (screen === 'login') {
    return (
      <div style={{ ...styles.bubbleOuter, ...(IS_MOBILE ? mobileOuter : {}) }}>
        <div style={{ ...styles.bubble, ...(IS_MOBILE ? mobileBubble : {}) }}>
          <div style={styles.loginContent}>
            <div style={styles.logoSection}>
              <img src={olkoLogo} alt="Olko ERP" style={styles.logoIcon} />
              <h1 style={styles.logoText}>Olko ERP</h1>
              <p style={styles.subtitle}>
                Biznes adınızı daxil edin
              </p>
            </div>

            <div style={styles.form}>
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
                />
              </div>

              {/* ✅ E-poçt/şifrə sahələri SİLİNDİ — ERP-nin öz login səhifəsi
                  first-party işlədiyi üçün burada təkrar soruşmaq lazım deyil. */}

              {error && <div style={styles.error}>{error}</div>}

              <button
                style={{
                  ...styles.button,
                  opacity: loading ? 0.7 : 1,
                  cursor: loading ? 'not-allowed' : 'pointer',
                }}
                onClick={handleLogin}
                disabled={loading}
              >
                {loading ? 'Gözləyin...' : (IS_MOBILE ? 'Sistemə keç' : 'Daxil ol')}
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
