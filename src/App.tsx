import { useState, useEffect, useRef } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize } from '@tauri-apps/api/dpi'
import './index.css'

type Screen = 'login' | 'app'

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
    const win = getCurrentWindow()
    if (collapsed) {
      win.setSize(new LogicalSize(64, 64))
    } else {
      win.setSize(new LogicalSize(400, 620))
    }
  }, [collapsed])

  const normalizeSiteUrl = (raw: string): string => {
    let url = raw.trim().replace(/\/+$/, '')
    if (!url.startsWith('http')) url = 'https://' + url
    return url
  }

  const handleLogin = async () => {
    setError('')
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
    getCurrentWindow().hide()
  }

  // Collapsed bubble — small floating circle
  if (collapsed) {
    return (
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          boxShadow: '0 4px 24px rgba(79, 70, 229, 0.4), 0 2px 8px rgba(0,0,0,0.15)',
          margin: 4,
          transition: 'transform 0.2s',
        }}
        data-tauri-drag-region
        onDoubleClick={() => setCollapsed(false)}
        title="İki dəfə kliklə — genişlət"
      >
        <span style={{ color: '#fff', fontSize: 22, fontWeight: 800, pointerEvents: 'none' }}>O</span>
      </div>
    )
  }

  // Login screen
  if (screen === 'login') {
    return (
      <div style={styles.bubbleOuter}>
        <div style={styles.bubble}>
          {/* Drag handle */}
          <div style={styles.dragBar} data-tauri-drag-region>
            <div style={styles.dragDots} data-tauri-drag-region>
              <span style={styles.dot} data-tauri-drag-region />
              <span style={styles.dot} data-tauri-drag-region />
              <span style={styles.dot} data-tauri-drag-region />
            </div>
            <div style={styles.dragActions}>
              <button style={styles.controlBtn} onClick={() => setCollapsed(true)} title="Kiçilt">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
              </button>
              <button style={styles.controlBtn} onClick={handleHide} title="Gizlət">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          </div>

          <div style={styles.loginContent}>
            <div style={styles.logoSection}>
              <div style={styles.logoIcon}>O</div>
              <h1 style={styles.logoText}>Olko ERP</h1>
              <p style={styles.subtitle}>Hesabınıza daxil olun</p>
            </div>

            <div style={styles.form}>
              <div style={styles.field}>
                <label style={styles.label}>Sayt ünvanı</label>
                <input
                  style={styles.input}
                  type="text"
                  placeholder="cofmof.olkoerp.com"
                  value={siteUrl}
                  onChange={e => setSiteUrl(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
              </div>

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
                {loading ? 'Gözləyin...' : 'Daxil ol'}
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
    <div style={styles.bubbleOuter}>
      <div style={styles.bubble}>
        {/* Drag handle + controls */}
        <div style={styles.dragBar} data-tauri-drag-region>
          <div style={styles.headerInfo} data-tauri-drag-region>
            <div style={styles.headerLogoBadge}>O</div>
            <span style={styles.headerLabel} data-tauri-drag-region>{session?.email?.split('@')[0] || 'Olko'}</span>
          </div>
          <div style={styles.dragActions}>
            <button style={styles.controlBtn} onClick={handleLogout} title="Çıxış">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
            <button style={styles.controlBtn} onClick={() => setCollapsed(true)} title="Kiçilt">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
            </button>
            <button style={styles.controlBtn} onClick={handleHide} title="Gizlət">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
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

const styles: Record<string, React.CSSProperties> = {
  bubbleOuter: {
    height: '100%',
    display: 'flex',
    padding: 0,
    background: 'transparent',
  },
  bubble: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    background: '#ffffff',
    borderRadius: 20,
    overflow: 'hidden',
    boxShadow: '0 8px 40px rgba(0,0,0,0.18), 0 2px 12px rgba(0,0,0,0.08)',
    border: '1px solid rgba(0,0,0,0.06)',
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
    borderRadius: 6,
    background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
    color: '#fff',
    fontSize: 11,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
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
    width: 52,
    height: 52,
    borderRadius: 14,
    background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
    color: '#fff',
    fontSize: 22,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    boxShadow: '0 4px 16px rgba(79, 70, 229, 0.3)',
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
