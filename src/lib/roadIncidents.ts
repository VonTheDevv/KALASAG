export type TrafficIncidentMetadata = {
  label: string
  color: string
  symbol: string
}

const TRAFFIC_INCIDENT_METADATA: Record<number, TrafficIncidentMetadata> = {
  0: { label: 'Road incident', color: '#6b7280', symbol: '!' },
  1: { label: 'Road accident', color: '#dc2626', symbol: '!' },
  2: { label: 'Fog', color: '#64748b', symbol: '!' },
  3: { label: 'Dangerous road condition', color: '#ea580c', symbol: '!' },
  4: { label: 'Heavy rain', color: '#2563eb', symbol: '!' },
  5: { label: 'Ice', color: '#0891b2', symbol: '!' },
  6: { label: 'Traffic congestion', color: '#f59e0b', symbol: '!' },
  7: { label: 'Lane closure', color: '#e11d48', symbol: 'x' },
  8: { label: 'Road closure', color: '#be123c', symbol: 'x' },
  9: { label: 'Roadworks', color: '#d97706', symbol: '!' },
  10: { label: 'Strong wind', color: '#7c3aed', symbol: '!' },
  11: { label: 'Road flooding', color: '#2563eb', symbol: '~' },
  14: { label: 'Broken-down vehicle', color: '#f97316', symbol: '!' },
}

export function trafficIncidentMetadata(category: number): TrafficIncidentMetadata {
  return TRAFFIC_INCIDENT_METADATA[category] ?? TRAFFIC_INCIDENT_METADATA[0]
}
