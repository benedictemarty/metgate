export interface Family {
  name: string
  count: number
  latest?: string
  format?: string
}

export interface ServiceCatalog {
  count: number
  families: Family[]
}

export interface Aggregate {
  fetched_at: string
  raw: ServiceCatalog
  wfs: ServiceCatalog
  wcs: ServiceCatalog
}
