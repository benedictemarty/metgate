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
import { displayFamilyName, familyInfo, EXTERNAL_PRODUCTS } from '../familyDisplay'
import type { ExternalProduct } from '../familyDisplay'
import { Satellite, Radio } from 'lucide-react'

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
          <ExternalSection />
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

function ExternalSection() {
  const eumetsat = EXTERNAL_PRODUCTS.filter((p) => p.provider === 'EUMETSAT')
  const opensky = EXTERNAL_PRODUCTS.filter((p) => p.provider === 'OpenSky')
  return (
    <section>
      <div className="flex items-baseline gap-3 mb-5">
        <Satellite className="size-5 text-amber-300" />
        <h2 className="text-2xl font-semibold tracking-tight">Sources externes</h2>
        <span className="text-sm text-slate-500">
          satellite & ADS-B · situationnel, non OPMET
        </span>
        <span className="ml-auto text-xs text-slate-500 tabular-nums">
          {EXTERNAL_PRODUCTS.length} produits
        </span>
      </div>

      <h3 className="text-[0.625rem] uppercase tracking-widest text-amber-300/70 mb-2 flex items-center gap-2">
        <Satellite className="size-3" /> EUMETSAT
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mb-6">
        {eumetsat.map((p) => (
          <ExternalCard key={p.name} product={p} accent="from-amber-400/40 to-amber-600/0" />
        ))}
      </div>

      <h3 className="text-[0.625rem] uppercase tracking-widest text-rose-300/70 mb-2 flex items-center gap-2">
        <Radio className="size-3" /> OpenSky Network
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {opensky.map((p) => (
          <ExternalCard key={p.name} product={p} accent="from-rose-400/40 to-rose-600/0" />
        ))}
      </div>
    </section>
  )
}

function ExternalCard({ product, accent }: { product: ExternalProduct; accent: string }) {
  const Icon = product.provider === 'OpenSky' ? Radio : Satellite
  return (
    <div className="group relative overflow-hidden rounded-xl border border-slate-800/60 bg-slate-900/40 p-4 transition hover:border-slate-700 hover:bg-slate-900/70">
      <div className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r ${accent}`} />
      <div className="flex items-start justify-between gap-3 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <Icon className="size-4 text-slate-400 shrink-0" />
            <div className="font-medium text-sm truncate" title={product.name}>
              {product.name}
            </div>
          </div>
          <div className="text-[0.6875rem] text-slate-300 leading-snug mb-1.5">
            {product.description}
          </div>
          <div className="text-[0.5625rem] uppercase tracking-wider text-amber-300/70 mb-1">
            {product.source}
          </div>
          <div className="text-[0.625rem] font-mono text-slate-500 truncate">
            {product.cadence}
          </div>
          <div className="text-[0.5625rem] font-mono text-cyan-400/70 truncate mt-1">
            {product.endpoint}
          </div>
          <div className="text-[0.5625rem] italic text-amber-200/70 mt-2 leading-snug">
            ⚠ {product.disclaimer}
          </div>
        </div>
      </div>
    </div>
  )
}

function FamilyCard({ family, accent }: { family: Family; accent: string }) {
  const Icon = familyIcon(family.name)
  const info = familyInfo(family.name)
  return (
    <div className="group relative overflow-hidden rounded-xl border border-slate-800/60 bg-slate-900/40 p-4 transition hover:border-slate-700 hover:bg-slate-900/70">
      <div className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r ${accent}`} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <Icon className="size-4 text-slate-400 shrink-0" />
            <div className="font-medium text-sm truncate" title={family.name}>
              {displayFamilyName(family.name)}
            </div>
          </div>
          {info?.description && (
            <div className="text-[0.6875rem] text-slate-300 leading-snug mb-1.5 line-clamp-2">
              {info.description}
            </div>
          )}
          {info?.source && (
            <div className="text-[0.5625rem] uppercase tracking-wider text-cyan-400/70 mb-1.5">
              {info.source}
            </div>
          )}
          {family.latest && (
            <div className="text-[0.6875rem] font-mono text-slate-500 truncate">
              {fmtDate(family.latest)}
            </div>
          )}
        </div>
        <div
          className="text-right shrink-0 cursor-help"
          title={`${family.count} instances disponibles dans le catalogue\n(échéances / runs historiques pour cette famille)\n\nLatest : ${family.latest ?? '—'}`}
        >
          <div className="text-2xl font-semibold tabular-nums leading-none">
            {family.count}
          </div>
          <div className="mt-1 text-[0.625rem] uppercase tracking-wider text-slate-500">
            {family.format ? `.${family.format}` : 'instances'}
          </div>
        </div>
      </div>
    </div>
  )
}
