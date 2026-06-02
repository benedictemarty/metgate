import { X } from 'lucide-react'

export const MAP_LANGUAGES = [
  { code: 'en', label: 'English',    neKey: 'NAME_EN' },
  { code: 'fr', label: 'Français',   neKey: 'NAME_FR' },
  { code: 'de', label: 'Deutsch',    neKey: 'NAME_DE' },
  { code: 'es', label: 'Español',    neKey: 'NAME_ES' },
  { code: 'it', label: 'Italiano',   neKey: 'NAME_IT' },
  { code: 'pt', label: 'Português',  neKey: 'NAME_PT' },
  { code: 'nl', label: 'Nederlands', neKey: 'NAME_NL' },
  { code: 'sv', label: 'Svenska',    neKey: 'NAME_SV' },
  { code: 'pl', label: 'Polski',     neKey: 'NAME_PL' },
  { code: 'ru', label: 'Русский',    neKey: 'NAME_RU' },
  { code: 'uk', label: 'Українська', neKey: 'NAME_UK' },
  { code: 'el', label: 'Ελληνικά',   neKey: 'NAME_EL' },
  { code: 'hu', label: 'Magyar',     neKey: 'NAME_HU' },
  { code: 'tr', label: 'Türkçe',     neKey: 'NAME_TR' },
] as const

export type MapLanguageCode = typeof MAP_LANGUAGES[number]['code']

export function neKeyForLang(code: MapLanguageCode): string {
  return MAP_LANGUAGES.find(l => l.code === code)?.neKey ?? 'NAME_EN'
}

interface Props {
  language: MapLanguageCode
  onLanguageChange: (code: MapLanguageCode) => void
  onClose: () => void
}

export default function ConfigPanel({ language, onLanguageChange, onClose }: Props) {
  return (
    <div className="absolute top-20 right-4 z-20 w-72 rounded-xl border border-slate-700/80 bg-slate-950/95 backdrop-blur-md shadow-2xl text-slate-200">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div className="text-sm font-semibold tracking-wide text-slate-100">Configuration</div>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-100 transition"
          aria-label="Fermer"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="p-4 space-y-4">
        <div>
          <label className="text-[0.6875rem] uppercase tracking-wider text-slate-400 block mb-1.5">
            Langue de la carte
          </label>
          <select
            value={language}
            onChange={(e) => onLanguageChange(e.target.value as MapLanguageCode)}
            className="w-full bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-amber-400"
          >
            {MAP_LANGUAGES.map(l => (
              <option key={l.code} value={l.code}>{l.label} ({l.code.toUpperCase()})</option>
            ))}
          </select>
          <p className="text-[0.625rem] text-slate-500 mt-1.5">
            Affecte les noms de pays (couche « Pays »). Préférence sauvegardée localement.
          </p>
        </div>
      </div>
    </div>
  )
}
