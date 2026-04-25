import {
  Activity,
  AlertTriangle,
  Cloud,
  CloudSnow,
  Database,
  FileText,
  Layers,
  Loader2,
  Mountain,
  Plane,
  Radar,
  RefreshCw,
  Sparkles,
  Tornado,
  Wind,
  Zap,
} from 'lucide-react'
import type { Aggregate, Family, ServiceCatalog } from '../types'

const familyIcon = (name: string) => {
  const n = name.toLowerCase()
  if (n.includes('composite')) return Radar
  if (n.includes('rdt')) return Zap
  if (n.includes('opic')) return Activity
  if (n.includes('cat_') || n.includes('givrage')) return Plane
  if (n.includes('jet') || n.includes('wind')) return Wind
  if (n.includes('tropo')) return Layers
  if (n.includes('volcanic') || n.includes('qvacis')) return Mountain
  if (n.includes('cyclone')) return Tornado
  if (n.includes('sigmet') || n.includes('airmet')) return AlertTriangle
  if (n.includes('space')) return Sparkles
  if (n === 'metar' || n === 'sa' || n === 'speci' || n === 'sp') return Cloud
  if (n === 'taf' || n === 'fc' || n === 'ft' || n === 'fv' || n === 'fk') return CloudSnow
  if (n === 'wa' || n === 'ws' || n === 'wl' || n === 'wv' || n === 'wc') return AlertTriangle
  return FileText
}

const fmtDate = (s?: string) => {
  if (!s) return ''
  const m = s.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC`
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) return s.slice(0, 16) + ' UTC'
  return s
}

interface CatalogProps {
  data: Aggregate | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}

export default function Catalog({ data, loading, error, onRefresh }: CatalogProps) {
  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <div className="flex items-center justify-end mb-6">
        <button
          onClick={onRefresh}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-800 bg-slate-900/60 hover:bg-slate-800/60 hover:border-slate-700 text-sm transition disabled:opacity-50"
        >
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          <span className="font-medium">Erreur :</span> {error}
        </div>
      )}

      {!data && loading && (
        <div className="flex items-center justify-center py-32 text-slate-500">
          <Loader2 className="size-7 animate-spin" />
        </div>
      )}

      {data && (
        <div className="space-y-12">
          <Section
            title="RAW"
            subtitle="Downloadable files · radar mosaics"
            icon={Database}
            accent="from-emerald-400/40 to-emerald-600/0"
            data={data.raw}
          />
          <Section
            title="WFS"
            subtitle="Vector features · METAR / TAF / SIGMET / hazards"
            icon={Layers}
            accent="from-sky-400/40 to-sky-600/0"
            data={data.wfs}
          />
          <Section
            title="WCS"
            subtitle="Gridded coverages · forecast wind / jet / tropopause"
            icon={Layers}
            accent="from-violet-400/40 to-violet-600/0"
            data={data.wcs}
          />
        </div>
      )}

      {data && (
        <div className="mt-14 text-center text-xs text-slate-500">
          Fetched {new Date(data.fetched_at).toLocaleString()}
        </div>
      )}
    </main>
  )
}

interface SectionProps {
  title: string
  subtitle: string
  icon: React.ComponentType<{ className?: string }>
  accent: string
  data: ServiceCatalog
}

function Section({ title, subtitle, icon: Icon, accent, data }: SectionProps) {
  return (
    <section>
      <div className="flex items-baseline gap-3 mb-5">
        <Icon className="size-5 text-slate-400" />
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <span className="text-sm text-slate-500">{subtitle}</span>
        <span className="ml-auto text-xs text-slate-500 tabular-nums">
          {data.count} {data.count > 1 ? 'familles' : 'famille'}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {data.families.map((f) => (
          <FamilyCard key={f.name} family={f} accent={accent} />
        ))}
      </div>
    </section>
  )
}

function FamilyCard({ family, accent }: { family: Family; accent: string }) {
  const Icon = familyIcon(family.name)
  return (
    <div className="group relative overflow-hidden rounded-xl border border-slate-800/60 bg-slate-900/40 p-4 transition hover:border-slate-700 hover:bg-slate-900/70">
      <div className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r ${accent}`} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-2">
            <Icon className="size-4 text-slate-400 shrink-0" />
            <div className="font-medium text-sm truncate" title={family.name}>
              {family.name}
            </div>
          </div>
          {family.latest && (
            <div className="text-[11px] font-mono text-slate-500 truncate">
              {fmtDate(family.latest)}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl font-semibold tabular-nums leading-none">
            {family.count}
          </div>
          {family.format && (
            <div className="mt-1 text-[10px] uppercase tracking-wider text-slate-500">
              .{family.format}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
