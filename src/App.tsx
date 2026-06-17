import { useState, useEffect, useRef } from 'react'
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

  if (screen === 'login') {
    return (
      <div style={styles.loginContainer}>
        <div style={styles.loginCard}>
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
    )
  }

  // App screen — iframe with ERP
  const base = session?.siteUrl || normalizeSiteUrl(siteUrl)

  return (
    <div style={styles.appContainer}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.headerLogo}>O</div>
          <span style={styles.headerTitle}>Olko ERP</span>
        </div>
        <div style={styles.headerRight}>
          <span style={styles.headerEmail}>{session?.email}</span>
          <button style={styles.logoutBtn} onClick={handleLogout}>
            Çıxış
          </button>
        </div>
      </div>

      <div style={styles.navBar}>
        <NavButton
          label="Dashboard"
          onClick={() => {
            if (iframeRef.current) iframeRef.current.src = `${base}/dashboard`
          }}
        />
        <NavButton
          label="Notlar"
          onClick={() => {
            if (iframeRef.current) iframeRef.current.src = `${base}/notes`
          }}
        />
        <NavButton
          label="Satış"
          onClick={() => {
            if (iframeRef.current) iframeRef.current.src = `${base}/sales/quick`
          }}
        />
        <NavButton
          label="Tam ERP"
          onClick={() => {
            if (iframeRef.current) iframeRef.current.src = `${base}/dashboard`
          }}
        />
      </div>

      <iframe
        ref={iframeRef}
        src={`${base}/notes`}
        style={styles.iframe}
        title="Olko ERP"
      />
    </div>
  )
}

function NavButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button style={styles.navBtn} onClick={onClick}>
      {label}
    </button>
  )
}

const styles: Record<string, React.CSSProperties> = {
  loginContainer: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    padding: 20,
  },
  loginCard: {
    background: '#fff',
    borderRadius: 16,
    padding: '40px 32px',
    width: '100%',
    maxWidth: 360,
    boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
  },
  logoSection: {
    textAlign: 'center' as const,
    marginBottom: 32,
  },
  logoIcon: {
    width: 56,
    height: 56,
    borderRadius: 14,
    background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
    color: '#fff',
    fontSize: 24,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  logoText: {
    fontSize: 22,
    fontWeight: 700,
    color: '#1e293b',
    margin: '0 0 4px',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
  },
  field: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: '#475569',
  },
  input: {
    padding: '10px 12px',
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
    fontSize: 13,
    textAlign: 'center' as const,
  },
  button: {
    padding: '12px',
    border: 'none',
    borderRadius: 10,
    background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 4,
  },
  appContainer: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    background: '#1e293b',
    color: '#fff',
    flexShrink: 0,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  headerLogo: {
    width: 28,
    height: 28,
    borderRadius: 7,
    background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: 600,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  headerEmail: {
    fontSize: 11,
    color: '#94a3b8',
  },
  logoutBtn: {
    padding: '4px 10px',
    border: '1px solid #475569',
    borderRadius: 6,
    background: 'transparent',
    color: '#cbd5e1',
    fontSize: 12,
    cursor: 'pointer',
  },
  navBar: {
    display: 'flex',
    gap: 1,
    background: '#f1f5f9',
    borderBottom: '1px solid #e2e8f0',
    flexShrink: 0,
  },
  navBtn: {
    flex: 1,
    padding: '8px 4px',
    border: 'none',
    background: '#fff',
    fontSize: 12,
    fontWeight: 500,
    color: '#475569',
    cursor: 'pointer',
  },
  iframe: {
    flex: 1,
    border: 'none',
    width: '100%',
  },
}

export default App
