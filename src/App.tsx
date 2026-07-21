import { useState, useEffect, useRef } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize } from '@tauri-apps/api/dpi'
import olkoLogo from './assets/olko-logo.png'
import './index.css'

type Screen = 'login' | 'app'

// ✅ 2026-07-17 Android dəstəyi: mobil-də pəncərə API-ləri (resize/hide/drag) yoxdur —
// tam-ekran rejim, bubble/collapse yalnız desktop-da
const IS_MOBILE = /android|iphone|ipad/i.test(navigator.userAgent)

interface Session {
  siteUrl: string
  email: string
}

function App() {
  const [screen, setScreen] = useState<Screen>('login')
  const [siteUrl, setSiteUrl] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    // ✅ 2026-07-18: Mobil-də cross-site iframe cookie problemi (Android WebView üçüncü-tərəf
    // cookie-ni bloklayır) səbəbindən ERP-ni tam-ekran BİRBAŞA açırıq — app yalnız sayt
    // seçicisidir, autentifikasiyanı ERP-nin öz first-party login-i idarə edir. Ona görə
    // mobil-də köhnə (iframe) sessiyasını bərpa etmirik, sadəcə son saytı ön-doldururuq.
    if (IS_MOBILE) {
      const lastSite = localStorage.getItem('olko_last_site')
      // Ön-doldururken biznes adını göstər (https:// və .olkoerp.com soyulur)
      if (lastSite) {
        setSiteUrl(lastSite.replace(/^https?:\/\//, '').replace(/\.olkoerp\.com$/, ''))
      }
      return
    }
    const saved = localStorage.getItem('olko_session')
    if (saved) {
      try {
        const s = JSON.parse(saved) as Session
        if (s.siteUrl && s.email) {
          setSession(s)
          setSiteUrl(s.siteUrl)
          setEmail(s.email)
          setScreen('app')
        }
      } catch {}
    }
  }, [])

  useEffect(() => {
    if (IS_MOBILE) return
    const win = getCurrentWindow()
    if (collapsed) {
      win.setSize(new LogicalSize(64, 64))
    } else {
      win.setSize(new LogicalSize(424, 644))
    }
  }, [collapsed])

  const normalizeSiteUrl = (raw: string): string => {
    // ✅ 2026-07-18: istifadəçi biznes adını yazır (məs. "qurman") — nöqtəsiz gələn dəyər
    // avtomatik `{ad}.olkoerp.com`-a çevrilir. Nöqtəli (tam domen, məs. custom domain
    // "erp.admedia.az" və ya "qurman.olkoerp.com") olduğu kimi qəbul olunur.
    let s = raw.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    if (s && !s.includes('.')) s = `${s}.olkoerp.com`
    return `https://${s}`
  }

  const handleLogin = async () => {
    setError('')

    // ✅ 2026-07-18 MOBİL: ERP-ni tam-ekran birbaşa aç (top-level naviqasiya).
    // Səbəb: Android WebView cross-site iframe-də üçüncü-tərəf cookie bloklayır →
    // fetch-login sessiyası iframe-də tanınmır, ERP təkrar login göstərirdi. Top-level
    // naviqasiyada ERP first-party olur, öz login-i etibarlı işləyir (tək giriş).
    if (IS_MOBILE) {
      if (!siteUrl.trim()) {
        setError('Sayt ünvanını daxil edin')
        return
      }
      const base = normalizeSiteUrl(siteUrl)
      localStorage.setItem('olko_last_site', base)
      setLoading(true)
      // ✅ 2026-07-18: replace() — giriş ekranını tarixçədən çıxarır ki, telefonun geri
      // düyməsi ERP daxilində naviqasiya etsin, yoxsa geri giriş ekranına atırdı.
      window.location.replace(base)
      return
    }

    if (!siteUrl.trim() || !email.trim() || !password.trim()) {
      setError('Bütün sahələri doldurun')
      return
    }

    setLoading(true)
    const base = normalizeSiteUrl(siteUrl)

    try {
      const res = await fetch(`${base}/api/method/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usr: email.trim(), pwd: password }),
        credentials: 'include',
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.message || 'Login uğursuz oldu')
      }

      const s: Session = { siteUrl: base, email: email.trim() }
      localStorage.setItem('olko_session', JSON.stringify(s))
      setSession(s)
      setPassword('')
      setScreen('app')
    } catch (err: any) {
      setError(err.message || 'Bağlantı xətası')
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('olko_session')
    setSession(null)
    setScreen('login')
    setPassword('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleLogin()
  }

  const handleHide = () => {
    if (IS_MOBILE) return
    getCurrentWindow().hide()
  }

  // Collapsed bubble — small floating circle (yalnız desktop)
  if (collapsed && !IS_MOBILE) {
    return (
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          boxShadow: '0 4px 24px rgba(15, 118, 110, 0.28), 0 2px 8px rgba(0,0,0,0.15)',
          margin: 4,
          transition: 'transform 0.2s',
        }}
        data-tauri-drag-region
        onDoubleClick={() => setCollapsed(false)}
        title="İki dəfə kliklə — genişlət"
      >
        <img src={olkoLogo} alt="Olko" style={{ width: 34, height: 34, pointerEvents: 'none' }} />
      </div>
    )
  }

  // Login screen
  if (screen === 'login') {
    return (
      <div style={{ ...styles.bubbleOuter, ...(IS_MOBILE ? mobileOuter : {}) }}>
        <div style={{ ...styles.bubble, ...(IS_MOBILE ? mobileBubble : {}) }}>
          {/* Drag handle */}
          <div style={styles.dragBar} data-tauri-drag-region>
            <div style={styles.dragDots} data-tauri-drag-region>
              <span style={styles.dot} data-tauri-drag-region />
              <span style={styles.dot} data-tauri-drag-region />
              <span style={styles.dot} data-tauri-drag-region />
            </div>
            <div style={styles.dragActions}>
              {!IS_MOBILE && (<>
              <button style={styles.controlBtn} onClick={() => setCollapsed(true)} title="Kiçilt">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
              </button>
              <button style={styles.controlBtn} onClick={handleHide} title="Gizlət">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
              </>)}
            </div>
          </div>

          <div style={styles.loginContent}>
            <div style={styles.logoSection}>
              <img src={olkoLogo} alt="Olko ERP" style={styles.logoIcon} />
              <h1 style={styles.logoText}>Olko ERP</h1>
              <p style={styles.subtitle}>
                {IS_MOBILE ? 'Biznes adınızı daxil edin' : 'Hesabınıza daxil olun'}
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

              {/* Mobil-də e-poçt/şifrə ERP-nin öz login səhifəsində daxil edilir (first-party) */}
              {!IS_MOBILE && (
                <>
                  <div style={styles.field}>
                    <label style={styles.label}>E-poçt</label>
                    <input
                      style={styles.input}
                      type="email"
                      placeholder="admin@example.com"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      onKeyDown={handleKeyDown}
                    />
                  </div>

                  <div style={styles.field}>
                    <label style={styles.label}>Şifrə</label>
                    <input
                      style={styles.input}
                      type="password"
                      placeholder="********"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      onKeyDown={handleKeyDown}
                    />
                  </div>
                </>
              )}

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

  // App screen — iframe with ERP
  const base = session?.siteUrl || normalizeSiteUrl(siteUrl)

  return (
    <div style={{ ...styles.bubbleOuter, ...(IS_MOBILE ? mobileOuter : {}) }}>
      <div style={{ ...styles.bubble, ...(IS_MOBILE ? mobileBubble : {}) }}>
        {/* Drag handle + controls */}
        <div style={styles.dragBar} data-tauri-drag-region>
          <div style={styles.headerInfo} data-tauri-drag-region>
            <img src={olkoLogo} alt="Olko" style={styles.headerLogoBadge} />
            <span style={styles.headerLabel} data-tauri-drag-region>{session?.email?.split('@')[0] || 'Olko'}</span>
          </div>
          <div style={styles.dragActions}>
            <button style={styles.controlBtn} onClick={handleLogout} title="Çıxış">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
            {!IS_MOBILE && (<>
            <button style={styles.controlBtn} onClick={() => setCollapsed(true)} title="Kiçilt">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
            </button>
            <button style={styles.controlBtn} onClick={handleHide} title="Gizlət">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
            </>)}
          </div>
        </div>

        {/* Quick nav */}
        <div style={styles.navBar}>
          {[
            { label: '📊', title: 'Dashboard', path: '/dashboard' },
            { label: '📝', title: 'Notlar', path: '/notes' },
            { label: '🛒', title: 'Satış', path: '/sales/quick' },
            { label: '📦', title: 'Stok', path: '/stock/items' },
          ].map(item => (
            <button
              key={item.path}
              style={styles.navBtn}
              title={item.title}
              onClick={() => {
                if (iframeRef.current) iframeRef.current.src = `${base}${item.path}`
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* ERP iframe */}
        <iframe
          ref={iframeRef}
          src={`${base}/notes`}
          style={styles.iframe}
          title="Olko ERP"
        />
      </div>
    </div>
  )
}

// Mobil-də üzən kart yerinə tam-ekran görünüş
const mobileOuter: React.CSSProperties = { padding: 0 }
const mobileBubble: React.CSSProperties = { borderRadius: 0, border: 'none', boxShadow: 'none' }

const styles: Record<string, React.CSSProperties> = {
  bubbleOuter: {
    height: '100%',
    display: 'flex',
    padding: 12,
    background: 'transparent',
  },
  bubble: {
    flex: 1,
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
    borderRadius: '0 0 20px 20px',
  },
}

export default App
