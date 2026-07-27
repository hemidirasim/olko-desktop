/**
 * UpdateGate — proqram açılanda avtomatik yeniləmə yoxlaması (2026-07-27).
 *
 * NİYƏ BURADA: app quraşdırmadan sonra webview-i ERP saytına yönləndirir. Uzaq
 * domendə Tauri IPC (plagin API-ləri) əlçatan deyil — ona görə yeniləmə yoxlaması
 * MƏHZ başladıcı ekranında, yönləndirmədən ƏVVƏL aparılmalıdır.
 *
 * TƏHLÜKƏSİZLİK: yüklənən paket `tauri.conf.json`-dakı AÇIQ AÇARLA yoxlanır —
 * imzası uyğun gəlməyən paket quraşdırılmır (saxta yeniləmə mümkün deyil).
 *
 * DAYANIQLIQ: yoxlama uğursuz olsa (internet yox, GitHub əlçatmaz) proqram normal
 * davam edir — yeniləmə HEÇ VAXT girişi bloklamamalıdır.
 */
import { useEffect, useState } from 'react'

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'error'

interface Props {
  /** Yoxlama bitəndə (yeniləmə yoxdursa və ya ötürülübsə) çağırılır. */
  onDone: () => void
}

const IS_MOBILE = /android|iphone|ipad/i.test(navigator.userAgent)

export default function UpdateGate({ onDone }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [version, setVersion] = useState('')
  const [notes, setNotes] = useState('')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [update, setUpdate] = useState<any>(null)

  useEffect(() => {
    let alive = true
    // Mobil platformalarda updater yoxdur (mağaza üzərindən yenilənir)
    if (IS_MOBILE) { onDone(); return }

    ;(async () => {
      setPhase('checking')
      try {
        const { check } = await import('@tauri-apps/plugin-updater')
        const found = await check()
        if (!alive) return
        if (found) {
          setUpdate(found)
          setVersion(found.version || '')
          setNotes(found.body || '')
          setPhase('available')
        } else {
          onDone()
        }
      } catch {
        // İnternet yoxdur / GitHub əlçatmaz / brauzerdə işləyir → sakitcə davam et
        if (alive) onDone()
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const install = async () => {
    if (!update) return
    setPhase('downloading')
    setError('')
    try {
      let downloaded = 0
      let total = 0
      await update.downloadAndInstall((event: any) => {
        if (event.event === 'Started') {
          total = event.data?.contentLength || 0
        } else if (event.event === 'Progress') {
          downloaded += event.data?.chunkLength || 0
          setProgress(total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0)
        } else if (event.event === 'Finished') {
          setPhase('installing')
        }
      })
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (e: any) {
      setError(String(e?.message || e))
      setPhase('error')
    }
  }

  if (phase === 'idle' || phase === 'checking') {
    return (
      <div style={S.wrap}>
        <div style={S.spinner} />
        <p style={S.muted}>Yeniləmə yoxlanılır…</p>
      </div>
    )
  }

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <h2 style={S.title}>Yeni versiya mövcuddur</h2>
        <p style={S.version}>Olko ERP {version}</p>
        {notes && <pre style={S.notes}>{notes}</pre>}

        {phase === 'available' && (
          <>
            <button style={S.primary} onClick={install}>Yenilə və yenidən başlat</button>
            <button style={S.ghost} onClick={onDone}>Sonra</button>
          </>
        )}

        {phase === 'downloading' && (
          <>
            <div style={S.barOuter}><div style={{ ...S.barInner, width: `${progress}%` }} /></div>
            <p style={S.muted}>Yüklənir… {progress}%</p>
          </>
        )}

        {phase === 'installing' && <p style={S.muted}>Quraşdırılır — proqram yenidən açılacaq…</p>}

        {phase === 'error' && (
          <>
            <p style={S.err}>{error}</p>
            <button style={S.primary} onClick={install}>Yenidən cəhd et</button>
            <button style={S.ghost} onClick={onDone}>Ötür</button>
          </>
        )}
      </div>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  wrap: {
    height: '100%', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 14,
    background: '#f1f5f9', padding: 24,
  },
  card: {
    width: '100%', maxWidth: 420, background: '#fff', borderRadius: 16, padding: 24,
    boxShadow: '0 8px 32px rgba(0,0,0,0.10)', border: '1px solid rgba(0,0,0,0.06)',
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  title: { margin: 0, fontSize: 18, fontWeight: 700, color: '#0f172a' },
  version: { margin: 0, fontSize: 14, color: '#0d9488', fontWeight: 600 },
  notes: {
    margin: 0, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap',
    fontSize: 12, color: '#475569', background: '#f8fafc',
    border: '1px solid #e2e8f0', borderRadius: 8, padding: 10,
  },
  primary: {
    padding: '11px 16px', border: 'none', borderRadius: 10, cursor: 'pointer',
    background: '#0d9488', color: '#fff', fontWeight: 700, fontSize: 14,
  },
  ghost: {
    padding: '9px 16px', border: '1px solid #e2e8f0', borderRadius: 10, cursor: 'pointer',
    background: '#fff', color: '#475569', fontWeight: 600, fontSize: 13,
  },
  muted: { margin: 0, fontSize: 13, color: '#64748b' },
  err: { margin: 0, fontSize: 12, color: '#e11d48' },
  barOuter: { height: 8, background: '#e2e8f0', borderRadius: 99, overflow: 'hidden' },
  barInner: { height: '100%', background: '#0d9488', transition: 'width 0.2s' },
  spinner: {
    width: 28, height: 28, borderRadius: '50%',
    border: '3px solid #cbd5e1', borderTopColor: '#0d9488',
    animation: 'olko-spin 0.8s linear infinite',
  },
}
